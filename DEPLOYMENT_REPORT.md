# Deployment Report

## Shape of the deployment

Lily MD needs two different kinds of host, and mixing them up is what broke the
pairing page:

| Part | Host | Why |
|---|---|---|
| Website + dashboard UI | Vercel (static) | `web/public/*` is plain HTML/CSS/JS; no server code needed |
| Bot, pairing engine, dashboard API | A persistent Node host (Railway, Render, a VPS, a panel) | Baileys holds a live WhatsApp socket; a serverless function cannot |
| Bot + website in one process | the same Node host, `node index.js` | the bot already serves `web/public` and the API on `PORT` |

Vercel **cannot** host `/api/pair`, the login endpoints or `/api/dash/*`: they run
inside the bot process. The static site now knows this — it calls a configurable
backend instead of its own origin.

## Frontend on Vercel

1. Project root: the repository. No build command, no framework preset.
2. Output/static directory: `web/public`.
3. Optional environment variable on the Vercel project: `BACKEND_API_URL`, e.g.
   `https://lily-bot.up.railway.app`.
4. Deploy. `https://lilymd.vercel.app` then serves the landing page, `/login` and
   `/dashboard`.

The page resolves its backend in this order: `localStorage.lilyBackend` → a
server-generated `/config.js` (only when Vercel proxies it) → same origin. If a
visitor lands on the static site with no backend configured, the "Server settings"
field on the pairing page lets them enter the bot URL; the value is validated,
stored and reused, and a failed request shows a readable message instead of a JSON
parse error.

## Bot on a Node host

```bash
npm install --legacy-peer-deps
node index.js
```

Environment:

```env
OPENROUTER_API_KEY=sk-or-...
OPENROUTER_MODEL=openrouter/free
PORT=8080
WEBSITE_URL=https://lilymd.vercel.app
FRONTEND_ORIGIN=https://lilymd.vercel.app
BACKEND_API_URL=https://lily-bot.up.railway.app
SESSION_TTL_HOURS=12
OWNER_NUMBER=916033352400
SECONDARY_OWNERS=916033271400
```

- `PORT` must be reachable from the internet for pairing and the dashboard API.
- `FRONTEND_ORIGIN` is what CORS allows; add every origin the site is served from
  (custom domain, preview URL), comma-separated.
- `OWNER_NUMBER` / `SECONDARY_OWNERS` extend the built-in owner list in
  `lib/ownerNumbers.js`. Only these numbers can be provisioned a dashboard account.
- Restart once after setting them; no secret is ever sent to the browser.

### Persistence

Keep these on a persistent volume, otherwise a redeploy logs the bot out and wipes
dashboard accounts:

```
session/                 # WhatsApp credentials
data/                    # bot state, webAccounts.json, webSessions.json, webAudit.log
session-backup.txt       # optional; paste into SESSION_ID to restore after a wipe
```

Deploying with no volume? Set `SESSION_ID` (base64 session backup) so the bot boots
straight back into the linked account.

## Cross-site cookies

Vercel (`https://lilymd.vercel.app`) and the bot (another HTTPS origin) are different
sites. A session cookie only travels between them when it is
`SameSite=None; Secure` — which requires **HTTPS on both sides**. `lib/webAuth.js`
sets that automatically for a cross-site request and falls back to `SameSite=Lax`
for same-origin/pairing use. Locally (`http://localhost`) cross-site cookies are
rejected by the browser, so **serve both from the same origin for local testing**
(the bot's own `PORT` does that already).

If you want to avoid cross-site cookies entirely, proxy the API from Vercel:

```json
{
  "rewrites": [
    { "source": "/api/(.*)", "destination": "https://lily-bot.up.railway.app/api/$1" }
  ]
}
```

and leave `BACKEND_API_URL` unset so the page uses its own origin.

## Platform constraints

- **Vercel** — static only for this project. No `vercel.json` is shipped, so the
  default static behaviour applies.
- **Railway/Render** — deploy the repository with `node index.js`; open the same
  port for the website. Long-running sockets are supported.
- **OptikLink / similar panels** — usually expose one port and no volume; fine for
  the bot alone, but the pairing site needs that port public and reachable.
- No PostgreSQL is used or required: state is JSON under `data/`, written atomically.

## What is still manual

- Nothing has been deployed by this work. No Vercel or Node-host credentials were
  used, so no production URL has been verified beyond the existing Vercel static
  deploy.
- The first owner account is created automatically only after a real pairing by an
  owner number. Until then `/login` has no accounts to sign in with — that is
  expected, not a bug.
- A QR-code pairing path and live "already connected" verification are not exposed
  on the web page; pair codes are.
