# Final Test Report

Date: 2026-11-20 · Node v24.20.0 · npm 11.19.0 · Windows (Git Bash)

## What was run

| Command | Result |
|---|---|
| `npm test` (`scripts/check-syntax.js`) | ✓ `syntax ok — 153 files`, exit 0 |
| `npm run test:web` (`scripts/test-web.js`) | **58 passed, 0 failed**, exit 0 |

`scripts/test-web.js` starts `web/server.js` as a child process on port **34567**,
waits for it to answer, runs every assertion over real HTTP, then kills the server
and restores the data files it touched (backup before, restore after).

### Coverage — 58 assertions

**Pages & static assets (8)** — `/`, `/login`, `/dashboard`, `/app.js`,
`/dashboard.js`, `/dashboard.css`, `/config.js`, `/assets/logo.png` all answer 200.

**Pairing contract (6)** — `/api/pair` always answers JSON; missing dependencies
produce a `503` with a `code`; a short number produces `400`; an empty body produces
`400` (never HTML); an unknown job produces `404`; an unauthenticated dashboard
request produces `401`. This is the regression test for the reported
`Unexpected token 'T', "The page c"…` bug.

**Owner provisioning (7)** — a non-owner number is refused; an owner number gets an
account with a 10+ character temporary password, is forced to change it, the stored
value is a scrypt hash (no plaintext), and the audit log does not contain the
password.

**Authentication (8)** — wrong password `401`, correct password `200`, a CSRF token
is returned, the session cookie is `HttpOnly` and `SameSite`, the session id is not
in the JSON body, `/api/auth/me` resolves the account, and an owner number without
an account still gets `401`.

**Dashboard data (7)** — `status`, `settings` and `commands` answer 200 from real
files; status carries the process uptime, the live connection state and a real
command count; the AI key is never exposed.

**Mutations, CSRF and persistence (13)** — a mutation without the CSRF header is
`403`; with it, a toggle, bot mode, a command disable, auto-reply mode/cooldown,
invalid-mode rejection and AI personality/language all persist to `data/`. Owner and
session views never return a hash; revoking a session makes it unusable.

**Password change & lockout (6)** — a weak password is rejected, a valid one is
accepted, old sessions are revoked, the new password works, the must-change flag
clears, and the account locks after 5 failures.

**File privacy (3)** — `/webAccounts.json`, `/webSessions.json` and `/webAudit.log`
are not served.

## Browser check

The site was started with `WEB_PORT=3210 node web/server.js` and opened locally:

- `/` rendered the full landing + pairing page with **no console errors and no failed
  requests**; all scripts, styles and the logo loaded with 200.
- `/login` rendered the sign-in form; the only console entry was the deliberate
  `GET /api/auth/me → 401` probe that confirms the visitor is signed out.
- `/dashboard` was not signed into (no account exists without a real pairing), so the
  16 sections were not clicked through section by section, and no screenshot
  comparison was made.
- CORS headers, `SameSite=None` cross-site cookie behaviour, and the
  `prefers-reduced-motion` rules were reviewed in code, not exercised in a browser.
- `data/*.json` atomic writes were exercised indirectly (writes persisted), without
  simulating a crash mid-write.

## What was not tested

- **No `node_modules` are installed in this workspace**, so the bot was never booted.
  That means: no real WhatsApp pairing, no Baileys socket, no `SESSION_ID` packing,
  no temporary-password delivery over WhatsApp, no live group list, and no live
  OpenRouter call from the dashboard "test" button. The pairing path is covered only
  to the point of the dependency check (`503 PAIRING_UNAVAILABLE`).
- **Nothing was deployed.** The Vercel project was not redeployed and no Node host
  was provisioned, so the fix is verified locally, not on `lilymd.vercel.app`.
- No cross-origin login was tested (Vercel frontend → bot backend), because that
  needs two HTTPS origins.
- No load, accessibility-audit, or Lighthouse run.
- No `git commit` was made; all changes are working-tree changes.

## How to finish verification on a real host

```bash
npm install --legacy-peer-deps
npm start                 # bot + website on PORT (default 8080)
npm run test:web          # same 58 checks against a local server
```

Then pair an owner number from the website, confirm the temporary password arrives
in WhatsApp, sign in at `/dashboard`, force the password change, and toggle one
setting to confirm it reaches `data/`.
