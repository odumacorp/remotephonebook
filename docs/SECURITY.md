# Security & privacy

| Risk | Control (where) |
| --- | --- |
| Password theft from the database | Argon2id (19 MiB, t=2) for passwords and PINs (`lib/crypto.ts`). Nothing reversible is stored. |
| Session token theft from the database | Only HMAC-SHA256(token) is stored (`auth_sessions.token_hash`). Tokens are revocable and expire (`SESSION_TTL_HOURS`). On the phone the token lives in the Keychain/Keystore (`expo-secure-store`). |
| Account enumeration | Register, recovery and login return identical responses whether or not the account exists. Unknown accounts still pay for an Argon2 verification. USSD unknown accounts follow the same steps. |
| Brute force | Per-account lockout (5 failures → 15 min), Postgres-backed rate limits per IP and per identifier on register/login/verify/recovery, per-calling-phone limits on USSD login, 3 attempts per USSD session, 5 attempts per one-time code, 10-minute code expiry. |
| Accessing someone else's contacts (IDOR) | Every contact query includes `user_id` from the authenticated session; ids from another account return 404. USSD reads only the authenticated session's (or the demo dataset's) contacts. Tested over REST and USSD. |
| Getting in over USSD with only a number/email | PIN login only from the account's own verified phone(s); otherwise the password (and optionally an OTP). |
| Passwords visible over USSD | Stated on the prompt; PIN login recommended; raw USSD `text` never stored or logged (HMAC digest only); request bodies are not logged; the logger redacts secret-like keys. |
| Forged USSD callbacks | Africa's Talking does not sign USSD callbacks, so use `USSD_CALLBACK_TOKEN` (secret in the callback URL), optionally `USSD_ALLOWED_IPS` (confirm current IPs with AT first), service-code check, session tied to the caller's number. |
| SQL injection | Parameterised queries only; LIKE wildcards escaped; zod validation of every body/query; USSD search input whitelisted. |
| Transport | `helmet`; production refuses non-HTTPS requests (set `TRUST_PROXY=true` behind a TLS proxy). |
| Data minimisation | Only names and phone numbers are read from the phonebook; `WRITE_CONTACTS` is blocked on Android; audit metadata never holds passwords, codes, tokens or contact data; rate-limit keys are HMAC'd; one-time codes are redacted from the outbound message log outside mock mode. |
| Consent | Upload requires explicit consent (`contacts_consent_at`), explained before the OS permission prompt; it can be withdrawn. |
| User rights | JSON export (`GET /api/account/export`) and permanent deletion (cascades to every table). |
| Retention | `npm run maintenance` (run daily) purges expired sessions/codes, old USSD sessions, audit events after `AUDIT_RETENTION_DAYS`, outbound messages after 30 days, tombstones after 90 days. |
| Demo data leaking real data | Demo mode reads only the `account_status='demo'` user; the seed refuses production unless forced; dev tools (outbox, simulator) are always off in production. |

Encryption at rest: use your provider's encrypted Postgres storage/backups (e.g. RDS, Cloud SQL,
Supabase, Render all encrypt at rest). Column-level encryption of phone numbers was not added because
search needs them; revisit if your threat model requires it.

Before launch: replace the placeholder privacy policy and terms (`/legal/*`), have them reviewed for
your markets (e.g. Kenya's Data Protection Act, 2019 — registration with the ODPC may be required),
and run `npm run check:prod`.
