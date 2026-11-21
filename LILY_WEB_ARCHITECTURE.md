# Lily MD — Web Platform Architecture

## What exists now

Lily MD has a **single Node.js process** that runs WhatsApp (Baileys) *and* the web
platform on one port. That is the "2-in-1" mode: `node index.js` serves the site on
`PORT` (default `8080`) and the bot keeps its socket.

A second entry point, `npm run website` (`web/server.js`, `WEB_PORT` 3000), serves
the same site without a WhatsApp connection. Pairing there still works, because
pairing opens its own temporary Baileys session.

```
                    ┌──────────────────────────── browser ────────────────────────────┐
                    │  /            landing + pairing        (web/public/index.html)  │
                    │  /login       owner sign-in            (web/public/login.html)  │
                    │  /dashboard   owner dashboard (SPA)    (web/public/dashboard.*)  │
                    └───────────────┬─────────────────────────────────────────────────┘
                                    │ fetch (JSON) + HttpOnly cookie + SSE
┌───────────────────────────────────▼─────────────────────────────────────────────────┐
│ lib/webApp.js   routing, static files, pairing jobs, CORS, JSON contracts           │
│ lib/webAuth.js  accounts, scrypt hashes, sessions, CSRF, lockout, audit log         │
│ lib/webApi.js   /api/dash/* — status, settings, AI, auto-reply, commands, owners     │
│ lib/ownerNumbers.js  the single "is this an owner?" list                            │
│ lib/webStore.js atomic JSON persistence                                             │
└───────────────────────────────────┬─────────────────────────────────────────────────┘
                                    │ reads/writes the bot's own files
┌───────────────────────────────────▼─────────────────────────────────────────────────┐
│ data/*.json (antidelete, autoread, autoStatus, messageCount, aiAutoReply, …)        │
│ main.js / index.js (WhatsApp runtime + runtime hooks for reconnect/disconnect)      │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

## Request rules

* Every JSON route answers with `content-type: application/json` **even on failure**
  (`{ ok: false, code, error }`). The frontend checks the content-type and status
  before parsing, which removes the original
  `Unexpected token 'T', "The page c"… is not valid JSON` crash.
* `POST /api/pair` validates input first, then dependencies, then rate limits.
* Prerendered static files are served only from `web/public` (flat filenames).
  `data/webAccounts.json`, `data/webSessions.json` and the audit log are never served.
* CORS allows credentials only for the same origin or `WEBSITE_URL` / `FRONTEND_ORIGIN`.
* Mutations require the per-session CSRF token in `X-Lily-CSRF`.

## Data files written by the web layer

| File | Purpose |
| --- | --- |
| `data/webAccounts.json` | owner accounts: number, role, scrypt hash, flags |
| `data/webSessions.json` | SHA-256 of each session token, CSRF token, expiry, IP |
| `data/webAudit.log` | JSONL audit trail (logins, lockouts, resets, config changes) |
| `data/disabledCommands.json` | commands switched off from the dashboard |
| `data/aiAutoReply.json` | auto-reply config, runtime key/model, personality, language |

All are gitignored.

## Render Web Service

The website is hosted on Render as a dedicated Node.js Web Service:

1. **Independent Process**: Runs `npm run website` (`web/server.js`), serving both static frontend assets and backend APIs.
2. **Real Node.js Runtime**: Long-running requests, Server-Sent Events, and ephemeral Baileys pairing sockets are fully supported.
3. **No External Proxy**: The website operates independently and does not require Vercel or any OptikLink proxy.
4. **Health Monitoring**: Render automatically probes `/health` to ensure service availability.
