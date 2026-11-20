# Pairing System Report

## The reported error

```
Unexpected token 'T', "The page c"... is not valid JSON
```

### Root cause

`lilymd.vercel.app` is a **static** deployment of `web/public/index.html`. The page
sent `POST /api/pair` to its own origin; Vercel has no such function, so it answered
with its HTML 404 page (`"The page c…ould not be found"`). The old code did:

```js
var res = await fetch('/api/pair', …);
var data = await res.json();     // ← HTML parsed as JSON
```

There was also no way to point the static copy at a real backend, so *every* attempt
on Vercel was guaranteed to fail — the pairing engine lives in the bot process, not
in a serverless function.

### Fixes

1. **JSON-safe client** — `web/public/app.js` reads `content-type` and status first,
   and raises readable errors ("This address does not host the Lily MD API (HTTP 404).
   If the website is on Vercel, point it at your bot…"). All three pages use it.
2. **Configurable backend** — `window.LILY_CONFIG.backendUrl`, a saved `localStorage`
   value, or the "Server settings" field on the pairing page. The bot serves a
   generated `/config.js` with `BACKEND_API_URL`.
3. **Guaranteed JSON contract** — `/api/pair` and `/api/status` always answer JSON:
   `{ ok, id, job }`, `{ ok:false, code:'BAD_NUMBER' | 'INVALID_NUMBER' |
   'PAIRING_UNAVAILABLE' | 'RATE_LIMITED' | 'JOB_EXPIRED' | 'BUSY', error }`.
4. **Correct error order** — the number is validated before dependencies, so a typo
   reports the typo instead of "pairing unavailable".
5. **Duplicate protection** — a live job for the same number is reused (`reused:true`)
   instead of opening a second socket.
6. **Request timeout** — 20–25 s client timeout with an abort; the page never hangs.
7. **Loading states + state machine** — `initializing → waiting → requesting → code →
   connecting → connected | failed`, mirrored in the UI chips. A code is **not**
   treated as connected: `connected` is only set when Baileys reports
   `connection.update === 'open'`.
8. **Rate limiting** — 6 pairing attempts per IP per hour; at most 4 concurrent jobs.
9. **Number validation** — digits only, 7–15 characters, validated with
   `awesome-phonenumber` (`+countrycode…`).

## Flow

1. Number is submitted → job created with a temporary auth directory.
2. `requestPairingCode` returns 8 characters, displayed grouped as `XXXX-XXXX`.
3. User completes the link in WhatsApp.
4. On `open`, the credentials are packed into a base64 `SESSION_ID` (tar, in memory),
   the socket is closed, and the directory is deleted.
5. If the number is an authorized owner, the account is provisioned and the temporary
   password is sent over that same, now authenticated, WhatsApp connection.
6. `SESSION_ID` is shown once; the job expires after 15 minutes and drops it from memory.

## Not implemented

* **QR pairing.** The current backend issues pairing codes only. `printQRInTerminal`
  exists in the bot for its own first login, but the website does not render a QR.
  The state machine has a place for it; exposing it needs the QR payload streamed over
  SSE and is deliberately out of scope for this pass.
* **Live verification.** This machine has no `node_modules`, so no real WhatsApp
  handshake was performed here. The API contract, validation, error paths, static
  pages and rate limits were exercised over HTTP (see `FINAL_TEST_REPORT.md`).
