# Dashboard Implementation Report

The owner dashboard lives at `/dashboard` on the bot's web server. It is a single
HTML shell (`web/public/dashboard.html`) styled by `dashboard.css` and driven by
`dashboard.js` — no framework, no build step, no CDN.

## Design

- Dark purple/pink "premium" palette built on CSS custom properties, so every panel
  shares one accent (`--accent` / `--accent-2`).
- Glass cards: translucent background, 1 px light border, soft shadow, backdrop blur.
- Grouped sidebar (Bot · Intelligence · Control · Access) with a collapsible mobile
  drawer; every view is a full-width card stack that reflows to one column under 760 px.
- `prefers-reduced-motion: reduce` disables transitions, the animated gradient
  background and the toast slide-in. The pairing page, login page and landing page use
  the same rule.
- Focus-visible rings on every interactive element; toasts are `role="status"`,
  errors `role="alert"`.

## Live data

`dashboard.js` opens an `EventSource` on `/api/events` (Server-Sent Events) and
re-renders the current view when the bot reports a change. Status is never invented:
values come from `/api/dash/status`, which reads the running process and the same
JSON files the in-chat commands use (see `API_INTEGRATION_REPORT.md`).

The header shows the signed-in owner number, the bot connection state and a
"Change password" action. Every mutating request carries the session CSRF token in
`X-Lily-CSRF`, and a `403` triggers a re-check of `/api/auth/me` before retrying the
login redirect.

## The 16 sections

| # | Section | Reads | Writes |
|---|---|---|---|
| 1 | Overview | `/api/dash/status` — uptime, WhatsApp state, command counts, messages, AI requests, auto-reply state, memory size | — |
| 2 | WhatsApp connection | `connection` — link state, number, socket reconnects | `POST /api/dash/connection` `{action:"reconnect"\|"disconnect"}` |
| 3 | AI Brain — AYHA | `ai` — provider, model, key (masked), daily limit, personality, language | save key/model/personality/language, `{action:"test"}` runs a real completion |
| 4 | Auto reply | `autoreply` — mode, allow/block lists, cooldown | mode, allow/block/unblock, cooldown |
| 5 | Commands | `commands` — every command file, its category and enabled state | toggle one command (`data/disabledCommands.json`) |
| 6 | Plugins | `commands` grouped by category | — (read-only inventory, disabled ones included) |
| 7 | Group management | `groups` — live group list from WhatsApp | — (group rules stay in chat) |
| 8 | Protection | `settings` — protection toggles, PM blocker text | toggles, PM message |
| 9 | Auto status | `settings.autoStatus` | auto-view, auto-react |
| 10 | Media & downloads | `commands` filtered to `downloads` / `media` | — (links to Commands) |
| 11 | Themes & mode | `settings` — mode, prefix, website, repo, owners | bot mode (public/private) |
| 12 | Owner management | `owners` — accounts, last login, temp-password flag, active sessions | reset a password, revoke a session |
| 13 | Database & memory | `database` (JSON file sizes/counts), `memory` (style samples, facts) | clear memory |
| 14 | Logs & analytics | `logs` — audit tail plus counters | — |
| 15 | Security | `logs` audit entries, session policy | revoke all sessions, change password |
| 16 | General settings | `settings` | website URL, daily AI limit, auto-reply master switch |

Every section renders an empty state with the reason the API returned (for example
"The bot is offline") instead of a fake number.

## Access control

- `/dashboard` is served to everyone, but `dashboard.js` calls `/api/auth/me` first;
  a `401` redirects to `/login?next=/dashboard`.
- `mustChangePassword` sessions are forced through the password form before any
  panel loads.
- Dashboard APIs require a valid session whose account still exists and whose number
  is still an authorized owner; unlisted numbers get `403 ACCOUNT_REMOVED`.
- `data/webAccounts.json`, `data/webSessions.json` and `data/webAudit.log` are
  git-ignored and never served as static files.

## Known limits

- No WebSocket transport: updates use SSE, which works through ordinary proxies but
  is one-way (actions are normal `POST`s).
- Group-level rules (anti-link, welcome, warnings) are shown but edited in chat, not
  from the dashboard, because they are keyed by JID inside `data/groupSettings.json`.
- The dashboard shows the bot's own message/uptime counters; it does not import
  WhatsApp history.
