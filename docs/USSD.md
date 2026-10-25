# USSD service

## Protocol (Africa's Talking)

Africa's Talking POSTs `application/x-www-form-urlencoded` to the channel's callback URL on every step:

| Field | Meaning |
| --- | --- |
| `sessionId` | Same for the whole dial session |
| `serviceCode` | Code dialled, e.g. `*384*1234#` |
| `phoneNumber` | Caller, E.164 |
| `networkCode` | Carrier (may be absent) |
| `text` | **All** inputs so far joined by `*` (`""` on the first request) |

The reply is `text/plain` with HTTP 200, beginning `CON ` (show menu, wait for input) or `END `
(show message, close). Implementation: `backend/src/routes/ussd.ts`, `backend/src/ussd/`.

Because `text` is cumulative it contains the password once typed. The server **never stores it**: it
keeps an HMAC of the previous text plus its length, finds the newest input by prefix comparison (so
inputs that contain `*` work), and answers retried requests from a cached last response.

## Menu tree

```
RemotePhonebook
1. Login ──► Enter phone number or email ──► Enter password (warning: visible)  ─┐
             (from a trusted phone with a PIN: Enter your USSD PIN directly)     │
             (optional: 6-digit code by SMS/email, USSD_REQUIRE_OTP_FOR_UNTRUSTED)│
2. Demo Contacts (fictional dataset, read-only)                                  │
3. Help                                                                          │
4. Exit                                                                          ▼
                                     Welcome to RemotePhonebook
                                     1. View Contacts ──► My Contacts - Page N
                                     2. Search Contacts      1-5. <names>
                                     3. Recent Contacts      6. Next Page / Previous Page
                                     4. My Account           7. Search
                                     5. Sync Status          8. Back
                                     6. Logout                    │
                                                                  ▼
                                                     Contact: Alice Wanjiku
                                                     Phone: +254700000101 (mobile)
                                                     1. View Number
                                                     2. Next Number (if several)
                                                     3. Send SMS
                                                     4. Return to Contacts
                                                     5. Main Menu
```

Option numbers are generated per screen and stored server-side; a typed number is only ever looked up
in the options the server last showed, so input cannot jump to arbitrary actions or contacts.

## Fitting carrier limits

`USSD_MAX_CHARS` (default 182 including `CON `) and `USSD_PAGE_SIZE` (default 5) are configurable.
List screens shorten names first and then show fewer contacts per page if needed; paging keeps a stack
of offsets so "Previous Page" returns exactly to the earlier page. Tests check every screen fits at 120.

## Copying numbers over USSD

A USSD session cannot touch the clipboard, dialer or SMS app, and copy/paste inside the USSD window
does not work on ordinary phones. So:

- **View Number** shows the number on its own line (E.164 plus a spaced version) with a reminder to
  write it down and type it into the dialer/SMS app.
- **Send SMS** texts `Name +2547…` to the *caller's* phone via Africa's Talking. On most phones a number
  in an SMS can be tapped to call or long-pressed to copy — the closest practical equivalent of
  "copy". Limited to `USSD_SMS_DAILY_LIMIT` per account per day; simulated in demo mode. Costs SMS credit.

## Login design and its limits

- USSD input is **not masked** on most handsets and carriers. The password prompt says so explicitly.
- **Preferred:** set a 4–6 digit USSD PIN in the app. It is accepted only when the call comes from the
  account's own *verified* phone number or a verified linked phone — knowing someone's number or email
  is never enough, because the PIN prompt is only offered to calls from that phone.
- From any other phone: identifier + password, optionally followed by a one-time code
  (`USSD_REQUIRE_OTP_FOR_UNTRUSTED=true`) sent to the account's verified phone or email. Turn this on if
  your users can still receive SMS/email when away from their phone; leave it off if the main use case is
  "I lost my phone" and SMS would go to the lost phone.
- Failures always show the same generic message and an unknown account goes through the same steps
  as a real one. 3 failures end the session; 10 per hour per calling phone; 5 per account lock it for 15 min.
- A session is tied to the caller's number, idles out after `USSD_SESSION_TTL_SECONDS` (sliding), and lasts
  at most 15 minutes. Each new dial requires a new login.

## Simulators (no telecom connection needed)

- Browser: `GET /api/dev/ussd-simulator`
- Terminal: `npm run ussd:sim -- --phone +254700000999 [--url https://…/api/ussd?token=…]`
  (posts real form-encoded requests, so it also works against a deployed server)
- In the app: Home → USSD (development builds)
