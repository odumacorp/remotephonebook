# API reference

Base URL: `API_BASE_URL` (e.g. `http://localhost:4000`). JSON in and out, except the USSD callback.
Private endpoints need `Authorization: Bearer <token>`. Errors look like:

```json
{ "error": { "code": "validation_error", "message": "Enter the 6-digit code", "details": [...] } }
```

Rate-limited endpoints return `429` with a `Retry-After` header.

## Authentication

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/api/auth/register` | `{fullName, email?, phone?, password, acceptTerms: true, device?}` → `202 {status:"verification_required", channels}`. Same response if the account already exists (no enumeration). |
| POST | `/api/auth/verify` | `{identifier, code, device?}` → `{token, user, deviceId, expiresAt}` |
| POST | `/api/auth/verify/resend` | `{identifier}` → `202` |
| POST | `/api/auth/login` | `{identifier, password, device?}` → `{token, user, ...}`. `401` generic on any failure; `403 verification_required` only after a correct password. 5 failures lock the account for 15 min. |
| POST | `/api/auth/logout` | Revokes the current session. |
| POST | `/api/auth/recovery` | `{identifier}` → always `202`. |
| POST | `/api/auth/recovery/confirm` | `{identifier, code, newPassword}`; signs out all devices. |

`device` = `{deviceIdentifier, platform: "ios"|"android"|"web"|"other", name?}`. Sync requires a session created with a device.

## Contacts

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/contacts?offset=&limit=` | Name-ordered page; exact duplicates are shown once. |
| GET | `/api/contacts/search?q=&offset=&limit=` | Name fragment or number fragment (`0712…` and `+254712…` both match). |
| GET | `/api/contacts/recent` | Recently opened contacts. |
| GET | `/api/contacts/:id` | `404` for unknown ids and for other users' contacts alike. |
| POST | `/api/contacts` | Manual contact `{displayName, numbers:[{number,label?,isPrimary?}], isDemo?}` |
| PATCH | `/api/contacts/:id` | `{displayName?, numbers?, baseVersion?}`; `409` if `baseVersion` is stale. |
| DELETE | `/api/contacts/:id` | Tombstones the contact (syncs to other devices). |
| POST | `/api/contacts/:id/accessed` | Marks as recently used. |
| GET | `/api/contacts/changes?cursor=&limit=` | Incremental pull, see [SYNC.md](SYNC.md). |
| POST | `/api/contacts/sync` | Push device changes, see [SYNC.md](SYNC.md). Requires contacts consent. |
| GET | `/api/contacts/sync/status` | `{totalContacts, lastSuccessfulSyncAt, status, lastError, devices[]}` |
| POST | `/api/contacts/sync/report` | `{status:"error", error}` — app reports a device-side failure (e.g. permission revoked). |

## Account & devices

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/account` | Profile, flags, linked phones. |
| PATCH | `/api/account` | `{fullName?, ussdEnabled?, deletionPolicy?: "mirror"|"keep", contactsConsent?}` |
| POST | `/api/account/password` | `{currentPassword, newPassword}`; other sessions are revoked. |
| PUT | `/api/account/ussd-pin` | `{password, pin: "4826" | null}` |
| POST | `/api/account/phones` | `{phone, label?}` → sends an SMS code |
| POST | `/api/account/phones/:id/verify` | `{code}` |
| DELETE | `/api/account/phones/:id` | |
| GET | `/api/account/export` | JSON download of account + contacts. |
| DELETE | `/api/account` | `{password, confirm: "DELETE"}` — permanent. |
| GET | `/api/devices` | |
| DELETE | `/api/devices/:id` | Signs the device out; its uploaded contacts stay. |

## USSD

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/api/ussd[?token=…]` | Africa's Talking callback, form-encoded `sessionId, serviceCode, phoneNumber, networkCode?, text`. Replies `text/plain` `CON …` / `END …`. |
| GET | `/api/ussd/health` | Config summary (no secrets). |

## Development only (`DEV_TOOLS_ENABLED`, never in production)

`GET /api/dev/outbox`, `POST /api/dev/ussd` (JSON, no callback token), `GET /api/dev/ussd-simulator`.

## Sample requests

```bash
API=http://localhost:4000

# Log in as the seeded test user with a device (needed for sync)
TOKEN=$(curl -s $API/api/auth/login -H 'Content-Type: application/json' \
  -d '{"identifier":"+254700000999","password":"TestPass2026!","device":{"deviceIdentifier":"curl-device-0001","platform":"other"}}' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')

curl -s "$API/api/contacts?limit=5" -H "Authorization: Bearer $TOKEN"
curl -s "$API/api/contacts/search?q=0700000204" -H "Authorization: Bearer $TOKEN"

# Push two phonebook entries, then pull changes
curl -s $API/api/contacts/sync -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{
  "upserts":[{"sourceContactId":"42","displayName":"Njeri Wairimu","numbers":[{"number":"0711 222 333","label":"mobile"}]}],
  "deletes":[]}'
curl -s "$API/api/contacts/changes?cursor=0" -H "Authorization: Bearer $TOKEN"
curl -s "$API/api/contacts/sync/status" -H "Authorization: Bearer $TOKEN"

# Simulate Africa's Talking calling the USSD endpoint (each step resends the whole text)
for TEXT in "" "1" "1*2468" "1*2468*1"; do
  curl -s $API/api/ussd -d sessionId=demo-1 -d 'serviceCode=*123#' -d phoneNumber=+254700000999 --data-urlencode "text=$TEXT"; echo; echo ---
done
```
