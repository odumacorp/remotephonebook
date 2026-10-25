# Deployment & Africa's Talking setup

> The Africa's Talking steps below follow their sandbox/USSD flow as commonly documented. Dashboard
> labels change; confirm against your Africa's Talking account and their current docs.
> Nothing here has been run against a live carrier yet.

## 1. Create the database

Any PostgreSQL 14+ (managed is easiest: RDS, Cloud SQL, Supabase, Neon, Render). The migration
enables `pgcrypto` and `pg_trgm`; both are available on all major managed providers.

```bash
createdb remotephonebook
export DATABASE_URL=postgres://USER:PASS@HOST:5432/remotephonebook
```

## 2. Run migrations

```bash
cd backend && npm ci && npm run build
npm run migrate        # also runs automatically on server start (advisory-locked, safe with many instances)
```

## 3. Seed demo contacts

```bash
npm run seed -- --with-test-user            # development
npm run seed -- --allow-production-demo     # production: demo dataset only, and only if DEMO_MODE_ENABLED=true
```

## 4. Start the backend

```bash
NODE_ENV=production npm start                # listens on $PORT
```

Production environment (see `backend/.env.example` for all options):

```
NODE_ENV=production
DATABASE_URL=...
API_BASE_URL=https://api.yourdomain.com
AUTH_SECRET=<48+ random chars>   # node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
TRUST_PROXY=true
AFRICASTALKING_ENV=live
AFRICASTALKING_USERNAME=<your app username>
AFRICASTALKING_API_KEY=<live API key>
AFRICASTALKING_USSD_SERVICE_CODE="*384*1234#"   # quoted: "#" starts a comment in .env files
AFRICASTALKING_SMS_FROM=<approved sender ID, optional>
USSD_CALLBACK_TOKEN=<random string>
CORS_ORIGINS=https://yourdomain.com
```

Schedule `npm run maintenance` daily (cron / platform scheduler).

## 5. Start the mobile app

```bash
cd mobile && npm ci
EXPO_PUBLIC_API_URL=https://api.yourdomain.com npx expo start
```

The app uses native modules (contacts, secure store, background task), so use a development build
(`npx expo run:android` / `npx expo run:ios`) or EAS (`npx eas-cli@latest build --profile development`).
Expo Go may not include every module at these versions. For release: `eas build --profile production`
with `EXPO_PUBLIC_API_URL` set. Physical device on your LAN during development: use
`http://<your-LAN-IP>:4000` (Android emulator: `http://10.0.2.2:4000`).

## 6. Expose the backend over HTTPS

Africa's Talking must reach the callback over the public internet.

- Development: `ngrok http 4000` (or `cloudflared tunnel --url http://localhost:4000`) → use the `https://` URL.
- Production: any host with TLS (Render, Fly.io, Railway, a VM behind nginx/Caddy). Set `TRUST_PROXY=true`.

Check: `curl https://YOUR-HOST/api/ussd/health`.

The handler answers in milliseconds, well inside the few-second budget carriers allow per step, but keep
the database in the same region as the API.

## 7. Configure the Africa's Talking USSD callback

Sandbox first:

1. Sign up at africastalking.com and open the **Sandbox** app (username is `sandbox`). Generate a
   sandbox API key under Settings → API Key.
2. USSD → **Create channel**: pick a sandbox service code (shared codes look like `*384*xxxx#`),
   callback URL `https://YOUR-HOST/api/ussd?token=<USSD_CALLBACK_TOKEN>`, method POST.
3. Set `AFRICASTALKING_ENV=sandbox`, `AFRICASTALKING_USERNAME=sandbox`, `AFRICASTALKING_API_KEY=<sandbox key>`,
   `AFRICASTALKING_USSD_SERVICE_CODE="<that code>"`, restart.
4. Open the sandbox **simulator**, enter a phone number, dial the code. Sandbox SMS (verification
   codes, "Send SMS") appear in the simulator's inbox.

## 8. Register / provision the real service code

In your **live** Africa's Talking app, apply for a USSD code: a channel on a *shared* code
(faster, cheaper, e.g. `*384*1234#`) or a *dedicated* code (needs carrier approval, takes longer and
costs more). Africa's Talking handles carrier provisioning per country/network. When approved, create the
live channel with the same callback URL and token, and register an SMS sender ID if you want branded SMS.

## 9. Test a real USSD session

1. `npm run check:prod` must report no blocking problems.
2. `npm run ussd:sim -- --url "https://YOUR-HOST/api/ussd?token=..." --code "*384*1234#" --phone +2547...`
   (exercises the deployed server exactly as AT would).
3. From a real SIM on a supported network: dial the code → Demo Contacts (if enabled) → Login.
4. Watch `audit_events` (`ussd_login_success`, `callback_rejected`) and server logs for errors.
5. Confirm the screen length is fine on the target networks; lower `USSD_MAX_CHARS`/`USSD_PAGE_SIZE` if
   menus get cut off.

## 10. Switch from demo to production mode

| Setting | Demo / dev | Production |
| --- | --- | --- |
| `NODE_ENV` | development | production (forces dev tools off) |
| `AFRICASTALKING_ENV` | mock | sandbox → live |
| `DEMO_MODE_ENABLED` | true (default in dev) | false (default in prod) |
| `REQUIRE_VERIFICATION` | true | true |
| `USSD_CALLBACK_TOKEN` | empty ok | set |
| Test user | `seed --with-test-user` | never created |
| Email delivery | mock outbox | add a provider in `services/messaging.ts` |

Remove or keep the demo dataset as you like; with demo mode off it is unreachable over USSD.
