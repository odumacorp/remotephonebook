# Contact synchronisation

## Model

- Every contact row has a `version` taken from one Postgres sequence. **Any** change (create, edit,
  number change, deletion) assigns a new, higher version. The highest version a client has seen is its
  **cursor**.
- Contacts that came from a phonebook carry `source_contact_id = "<deviceIdentifier>:<native id>"`, so
  each device's ids are namespaced and reinstalling the app on the same device re-links instead of
  duplicating (the device identifier is kept in the OS keychain).
- Deletions are **tombstones** (`deleted_at` + new version) so other devices learn about them.
  `npm run maintenance` purges tombstones older than `tombstoneRetentionDays` (default 90) and records
  the highest purged version; a client whose cursor is older gets `reset: true` and a full resync.
- Writes for a user are serialised with a transaction-scoped advisory lock, and pulls take the shared
  form of the same lock, so a lower version can never commit after a client has read a higher one.

## A sync run (mobile `src/lib/sync/engine.ts`)

1. **Pull** `GET /api/contacts/changes?cursor=N` until `hasMore` is false; apply upserts/tombstones to the
   local cache (AsyncStorage) and advance the cursor.
2. **Read** the phonebook (`Contact.getAllDetails([fullName, phones…])`, 500 at a time). Entries with no
   phone number are skipped (useless over USSD).
3. **Plan** (`src/lib/sync/plan.ts`, pure and unit-tested): for each device contact compare a content hash
   with what this device last synced.
   - unchanged → nothing sent (so app-side edits are never overwritten by a stale phonebook entry);
   - identical copy already on the server (e.g. after reinstall) → adopted locally, nothing sent;
   - otherwise → upsert with `baseVersion` = the server version this device last agreed on.
   - previously synced ids missing from the phonebook → delete with `baseVersion`.
4. **Push** in chunks of 200 to `POST /api/contacts/sync`; the last chunk has `final: true`, which records
   the successful sync time on the server. Network/5xx failures are retried with exponential backoff;
   replaying a chunk is harmless (identical upserts come back `unchanged`).
5. **Pull** again so the cache has the new versions.

Only a run that included the phonebook updates "last phonebook sync". A cloud-only refresh (no
permission, no consent, or web) is shown as a refresh, never as a sync.

### When it runs

- On login and whenever the app returns to the foreground (throttled to once per 5 minutes).
- 10 seconds after the phonebook changes while the app is open (`addContactsChangeListener`).
- Manually ("Sync now").
- In the background via `expo-background-task` (minimum interval 60 min). The **OS decides** when it
  runs: Android WorkManager runs it periodically when conditions allow; iOS runs it opportunistically,
  often overnight while charging, and not at all if the user force-quits the app. Do not promise
  real-time background sync.
- USSD never triggers a sync — it reads whatever is already in the cloud.

## Server responses per item

`created | updated | unchanged | deleted | conflict | kept | not_found | invalid`. A batch never fails
because of one bad entry; invalid entries are reported individually.

## Conflict resolution (documented strategy)

**The server copy wins on concurrent edits.** A push whose `baseVersion` is lower than the server's
current version means the contact changed elsewhere (another device or an edit in the app) since this
device last synced. The server rejects that change with `conflict` and returns its copy; the device
adopts it and records its own content hash so the same stale change is not re-sent. If the user later
edits the contact on the phone again, that new edit is sent with the newer base version and applies.

Without a `baseVersion` (first sight of a contact) the device wins.

Contacts deleted in the app stay deleted even though the phonebook still has them, until the phonebook
entry itself changes.

## Deletion policy (per user, Privacy screen)

- `mirror` (default): removing a contact from the phonebook removes it from the cloud.
- `keep`: phonebook deletions are ignored (`kept`); the cloud copy stays reachable over USSD.

Safety nets: an empty phonebook read never deletes anything; the server refuses a request deleting
more than half of the device's synced contacts (when over 20) unless `confirmMassDelete: true`, which the
app asks the user to confirm on the Sync status screen.

## Duplicates

- Numbers are normalised to E.164 (`DEFAULT_PHONE_REGION`, default KE) and de-duplicated within a contact.
- Each contact gets a `dedupe_key` (normalised name + sorted numbers). Listing, search, counts and
  USSD show only the oldest active contact per key, so the same person synced from two phones or
  entered twice appears once. Rows are kept, so deleting one copy reveals the other rather than losing data.
