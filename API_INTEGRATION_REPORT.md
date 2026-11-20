# API Integration Report

All endpoints are served by `lib/webApp.js` (routing, CORS, static files) and
`lib/webApi.js` (data + actions). Every route answers **JSON only** — including
errors — with `content-type: application/json; charset=utf-8`.

## Conventions

- Response envelope: `{ ok: true, ... }` or `{ ok: false, code, error }`.
- Error codes: `BAD_NUMBER`, `INVALID_NUMBER`, `RATE_LIMITED`, `PAIRING_UNAVAILABLE`,
  `JOB_EXPIRED`, `BUSY`, `BAD_REQUEST`, `UNAUTHORIZED`, `FORBIDDEN`, `LOCKED`,
  `NOT_FOUND`, `SERVER_ERROR`.
- No stack traces, file paths or dependency names are ever returned; internal errors
  log server-side and answer `{ ok:false, code:'SERVER_ERROR', error:'Something went wrong.' }`.
- CORS allows `WEBSITE_URL` / `FRONTEND_ORIGIN` (comma-separated) plus `localhost`
  origins, with `credentials: true`. Unknown origins get no CORS headers, so the
  browser blocks cross-site reads.
- Mutating `/api/auth/*` and `/api/dash/*` requests require the `X-Lily-CSRF` header
  matching the session token.

## Public

| Method | Path | Body | Response |
|---|---|---|---|
| `GET` | `/api/status` | — | `{ ok, connected, state, uptimeSeconds, number }` |
| `GET` | `/api/info` | — | `{ ok, name:"Lily MD", assistant:"AYHA", version, owners:[…] }` |
| `POST` | `/api/pair` | `{ number }` | `{ ok, id, reused, job }` |
| `GET` | `/api/pair/status?id=…` | — | `{ ok, job }` — state, code, session, error |
| `GET` | `/api/events` | — | `text/event-stream` of `{ type, status }` |
| `GET` | `/config.js` | — | `window.LILY_CONFIG = { backendUrl, … }` generated from env |

Pairing job states: `initializing → waiting → requesting → code → connecting →
connected | failed`. A pair code is never reported as connected; `connected` follows
Baileys `connection.update === 'open'`. Jobs expire after 15 minutes, and the
`SESSION_ID` is returned once.

Limits: 7–15 digit numbers validated before any optional dependency is required
(so a typo returns `BAD_NUMBER` even without `node_modules`), 6 attempts per IP per
hour, 4 concurrent jobs, a duplicate live number returns the existing job with
`reused: true`.

## Authentication

| Method | Path | Body | Notes |
|---|---|---|---|
| `POST` | `/api/auth/login` | `{ number, password }` | sets `lily_session` HttpOnly cookie; returns `{ mustChangePassword, csrf }` |
| `GET` | `/api/auth/me` | — | `{ account, csrf }`, `401` when signed out |
| `POST` | `/api/auth/logout` | — | clears cookie, deletes the stored session |
| `POST` | `/api/auth/password` | `{ current, next }` | policy: ≥10 chars with a letter and a digit; revokes other sessions |

Login failures are counted per number **and** per IP: 5 failures in 15 minutes locks
that key for 15 minutes (`429 LOCKED`). Success, failure, lockout, provisioning,
password change, revocation and dashboard actions are appended to
`data/webAudit.log`.

## Dashboard

`GET /api/dash/<resource>` returns data; `POST /api/dash/<resource>` with an
`{ action }` body performs a change. Resources:

| Resource | GET returns | POST actions |
|---|---|---|
| `status` | connection, uptime, message and AI counters, memory size, command totals | — |
| `connection` | state, number, reconnect count | `reconnect`, `disconnect` |
| `ai` | provider, model, key (masked), daily limit, personality, language | `save`, `test` |
| `autoreply` | mode, allowlist, blocklist, cooldown | `mode`, `allow`, `block`, `unblock`, `cooldown` |
| `commands` | every command file with category and enabled flag | `toggle` |
| `groups` | live groups (`subject`, `size`, `id`) | — |
| `settings` | toggles, PM message, auto-status, mode, website, repo, owner numbers | `toggle`, `pm-message`, `autostatus`, `mode`, `save` |
| `owners` | accounts, active sessions, configured numbers | `reset-owner`, `revoke-session`, `revoke-all` |
| `memory` | style samples and facts from `data/aiMemory.json` | `clear` |
| `database` | per-file size and record count under `data/` | — |
| `logs` | audit tail, counters | — |
| `security` | session policy, audit entries | `revoke-all`, `password` |

## How it maps to the bot

- `index.js` exposes `webApi.setRuntime({ getConnected, getSocket, disconnect,
  reconnect, listGroups })` once the health server starts, so the dashboard can drive
  the real connection instead of a stub.
- Reads use the same JSON files the commands use (`data/disabledCommands.json`,
  `data/aiAutoReply.json`, `data/aiMemory.json`, `data/groupSettings.json`), through
  `lib/webStore.js`, which writes atomically (temp file + rename) and tolerates a
  missing or corrupt file by falling back to a default.
- The AI "test" action performs a genuine completion with the configured key/model;
  it never fabricates a reply.
- With the bot offline every data route still answers `ok: true` plus a `reason`
  explaining what is unavailable, so the dashboard renders an honest empty state.

## Frontend client

`web/public/app.js` exposes `LilyAPI`:

- `api(path, options)` resolves the backend (stored `localStorage` value →
  `window.LILY_CONFIG.backendUrl` → same origin), reads `content-type` **before**
  parsing, and turns an HTML/plain-text answer into a readable error instead of
  `Unexpected token 'T'`.
- 20–25 s timeout with `AbortController`, and `credentials: 'include'` so the session
  cookie travels to a cross-origin bot.
- `escapeHtml`, `when`, `fmtUptime` helpers shared by the pairing and dashboard pages.
