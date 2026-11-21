# 🌸 Lily MD

**Lily MD** is an open-source WhatsApp multi-device bot built on [Baileys](https://github.com/WhiskeySockets/Baileys), with **AYHA**, its built-in AI assistant, powered by [OpenRouter](https://openrouter.ai).

<div align="center">
  <img src="assets/logo.png" alt="Lily MD logo" width="260" />
  <h3>WhatsApp MD Bot · AI Assistant AYHA</h3>
</div>

---

## Project profile

| | |
|---|---|
| **Project** | Lily MD |
| **Owner** | Rahul Haldar |
| **Owner number** | 916033352400 |
| **AI assistant** | AYHA |
| **Runtime** | Node.js / JavaScript |
| **WhatsApp integration** | Baileys (`@whiskeysockets/baileys`) |
| **AI provider** | OpenRouter |
| **Default AI model** | `openrouter/free` |
| **Configuration** | JSON settings + local session storage (`./session`) |
| **Previous hosting** | OptikLink |
| **Dashboard** | Vercel |

---

## ✨ Features

- **AYHA AI assistant** — `.ai <question>` for one-off answers, `.chatbot on` for a group chatbot that replies when mentioned or replied to, and `.aiutoreply on` for private-chat auto-reply that answers every DM in your own talking style (groups are never auto-answered)
- Group management: tag all, mute/unmute, promote/demote, kick, warnings, welcome/goodbye
- Protection: anti-link, anti-badword, anti-bot, anti-call, anti-delete, anti-tag, PM blocker
- **Website link** — `.website` shares your Vercel site, and the same URL is sent as the AI referer
- **Universal downloader** — `.dl <any link>` auto-detects 13 platforms (TikTok, Instagram, Pinterest, Facebook, Twitter/X, Threads, Videy, Mega, SoundCloud, Spotify, YouTube, Sfile, MediaFire) and sends the media, Atlas-MD style
- **26 anime reactions** — `.hug`, `.slap`, `.bonk`, `.pat`, `.cuddle`, `.highfive`, `.yeet` and 19 more, animated via Tenor
- **Two prefixes** — every command works with `.` or Atlas's `-`, so `-help` and `.help` are the same
- Media: song/video download, YouTube search, Instagram, TikTok, Facebook, Twitter/X, Spotify, lyrics
- Stickers: image/video stickers, crop, take, emoji mix, Telegram stickers, attp
- Utilities: `.alive`, `.ping`, `.help`, `.menu`, `.tts`, `.translate`, `.weather`, `.news`, `.ss`, `.pair`
- Games and fun: tic-tac-toe, hangman, trivia, truth/dare, 8ball, quotes, jokes

---

## 🛠️ Setup

### Prerequisites

- Node.js 18 or newer
- Git

### Install

```bash
git clone <your-lily-md-repository>
cd Lily-MD
npm install
```

### Configure

Copy `.env.example` to `.env` and set your OpenRouter key and MySQL details:

```env
OPENROUTER_API_KEY=sk-or-...
OPENROUTER_MODEL=openrouter/free
GITHUB_REPO=owner/repo

DB_HOST=your-mysql-host
DB_PORT=3306
DB_NAME=your-database
DB_USER=your-database-user
DB_PASSWORD=your-database-password
DB_CONNECTION_LIMIT=10
```

`OPENROUTER_MODEL` is optional — it defaults to `openrouter/free`, OpenRouter's Free Models Router. Without a key the bot still runs; `.ai` and the chatbot fall back to the public AI endpoints.

Optional settings (all default to off/disabled):

| Variable | Purpose |
|---|---|
| `AI_DAILY_LIMIT` | AYHA requests per user per day (default `30`, `0` = unlimited). Owner and sudo are exempt. |
| `WEBSITE_URL` | Public site shown by `.website` and used as the AI request referer (default `https://lilymd.vercel.app`). |
| `CHANNEL_LINK` | Your WhatsApp channel, shown by the channel button and `.alive` / ready message. |
| `SUPPORT_GROUP_LINK` | Your support group, shown by the support button. |
| `NEWSLETTER_JID` | Forwarding channel JID. Leave empty and messages are simply not forwarded. |
| `PORT` | Port for the 2-in-1 server: pairing website + `/health` (default `8080`). |
| `TENOR_API_KEY` | Tenor key(s) for `.gif` and `.emojimix`, comma-separated (a public fallback key is built in). |
| `OPENWEATHER_API_KEY` | OpenWeather key for `.weather`. |
| `OPENAI_API` / `GEMINI_API` / `CLAUDE_API` | Comma-separated provider keys used by AYHA when OpenRouter is unavailable. |
| `SESSION_ID` | Base64 session backup restored on boot (see **Session persistence**). |
| `SESSION_BACKUP_INTERVAL_MS` | Periodic backup interval, default `21600000` (6 hours). |
| `SESSION_BACKUP_DEBOUNCE_MS` | Delay after a credential change before the backup is rewritten, default `20000`. |
| `SESSION_BACKUP_RETRY_MS` | Retry delay when WhatsApp rejects a backup document, default `600000`. |

Bot name, owner, sticker pack name and API endpoints live in `settings.js`. AYHA memory and the schedule queue are stored in MySQL; small JSON caches and the WhatsApp session live under `data/` and `./session`. If MySQL is not configured the bot still runs and keeps memory in the local JSON cache, but scheduling needs the database.

### Run

```bash
node index.js
```

Scan the QR code shown in the terminal with WhatsApp → Linked Devices, or generate a pair code with `.pair <number>` from the bot's own WhatsApp account.

### Hosting

- **2-in-1 server** — one process, one port: `GET /` is the pairing website and `GET /health` returns JSON (`status`, `connected`, `uptime`) for panels and uptime monitors. Nothing else needs to be hosted.
- **Session restore** — after the first successful login the session is backed up and sent to the bot's own chat as `LILY-MD-SESSION.txt` (see **Session persistence** below). Paste its contents into `SESSION_ID` and the bot boots straight into the saved session instead of asking for a new QR scan.
- **Reconnects** — dropped connections retry with exponential backoff (2s → 60s) instead of a fixed delay, and uncaught errors are logged rather than crashing the process.

### Session persistence

Pair once, keep the account linked forever:

1. **Pair** — first start shows a QR code, or use `.pair <number>` for a pairing code.
   A pairing code only links the device; the session is what keeps it linked.
2. **Backup** — `session/` is packed into `session-backup.txt` (gitignored) right
   after the connection opens, again whenever Baileys writes new credentials
   (debounced, 20s) and every 6 hours as a safety net. The file is `0600`.
3. **Delivery** — the same archive is sent as **`LILY-MD-SESSION.txt`** to the
   bot's own WhatsApp chat, with restore instructions inside. It is only re-sent
   when the archive changed; a failed send is retried after 10 minutes.
4. **Restore** — on a new/rebuilt server paste the file's contents into
   `SESSION_ID`, start the bot, and it connects without a QR/pairing code.

`SESSION_ID` is read before Baileys initialises. A **valid local session is never
overwritten**, archives are checked (gzip, entry names, `creds.json`) before
anything is extracted into an isolated directory, and path traversal or absolute
entries are refused. Startup logs are one of:

```
🔐 Existing local session detected
🔐 Session restored successfully from SESSION_ID
⚠️ No valid saved session found. Pairing required.
```

Environment-variable restore is what survives a hosting provider deleting
ephemeral container storage — OptikLink containers are recreated without
`./session`, so `SESSION_ID` (or a re-uploaded `session-backup.txt`) is the only
way back in. If WhatsApp unlinks the device (logged out / 401), the session is
truly dead: the bot says so and you pair again; temporary disconnects, conflicts
and crashes never delete `session/`.

### Pairing website (2-in-1)

The bot serves a small public site on its own port, so one process gives you both
the bot and the website — no second host or second port:

```bash
node index.js          # website at http://localhost:8080, health at /health
npm run website        # website only, without the bot (WEB_PORT, default 3000)
```

Visitors link their own WhatsApp and take the session away:

1. The visitor enters their number with country code.
2. Baileys requests a real pairing code, which the page shows.
3. After they confirm it in WhatsApp, the page downloads the creds as a base64
   `SESSION_ID` — the same format `SESSION_ID` restores on boot.

Sessions are packed on the server, returned once, and dropped from memory after
15 minutes. Pairings are limited to 6 per IP per hour and 4 at a time. **Anyone
who holds a `SESSION_ID` controls that WhatsApp account**, so keep it private.
The site needs publicly reachable `WEB_PORT`, which a plain WhatsApp host such
as OptikLink does not expose by default — put it behind a reverse proxy or run
it on a VPS where that port is open.

### Checks

```bash
npm test        # syntax-checks every project .js file, no dependencies needed
npm run test:web  # HTTP tests for the website + dashboard API (port 34567)
```

### Web platform docs

| Document | What it covers |
|---|---|
| [`LILY_WEB_ARCHITECTURE.md`](LILY_WEB_ARCHITECTURE.md) | How the site, API and bot fit together |
| [`PAIRING_SYSTEM_REPORT.md`](PAIRING_SYSTEM_REPORT.md) | The Vercel JSON bug, root cause and fix |
| [`AUTHENTICATION_SECURITY_REPORT.md`](AUTHENTICATION_SECURITY_REPORT.md) | Hashing, sessions, CSRF, lockout, audit log |
| [`DASHBOARD_IMPLEMENTATION_REPORT.md`](DASHBOARD_IMPLEMENTATION_REPORT.md) | The 16 dashboard sections and what they read |
| [`API_INTEGRATION_REPORT.md`](API_INTEGRATION_REPORT.md) | Every endpoint, request and response shape |
| [`DEPLOYMENT_REPORT.md`](DEPLOYMENT_REPORT.md) | Vercel (frontend) + Node host (bot) setup |
| [`FINAL_TEST_REPORT.md`](FINAL_TEST_REPORT.md) | What was tested and what was not |

---

## 🔌 Atlas API layer

Every media, search and utility call goes through `lib/atlasApi.js`, which ports the
endpoints and multi-key pools of [Atlas-MD](https://github.com/FantoX/Atlas-MD) (MIT):

| Feature | Endpoint |
|---|---|
| TikTok | `tikwm.com` |
| Instagram, Facebook, Pinterest, MediaFire | `api-faa.my.id` |
| Twitter/X, YouTube audio, Spotify, SoundCloud, Threads, Videy, Mega, Sfile | `api.nexray.web.id` |
| GIF / emoji mix | Tenor (`TENOR_API_KEY` pool) |
| Weather | OpenWeatherMap |
| Wikipedia, GitHub | official public APIs |
| AYHA fallback | OpenAI / Gemini / Claude key pools |

Atlas-MD has no YouTube *video* endpoint (its YouTube support is audio only), so
`.video` keeps three public MP4 converters as its sources.

---

## 🤖 AYHA

AYHA is the assistant personality shared by `.ai`, the group chatbot and private auto-reply. Requests go to OpenRouter's chat completions API (`https://openrouter.ai/api/v1/chat/completions`) using `settings.openrouterModel`, and fall back to the legacy public AI APIs if OpenRouter is unavailable or unconfigured.

### Private auto-reply `.aiutoreply`

```text
.aiutoreply on      # AYHA answers every DM (private chats only)
.aiutoreply off
.aisetkey sk-or-... # change the chat API key from WhatsApp (no restart)
.aisetkey clear     # drop the saved key, fall back to .env
.aisetmodel openrouter/free   # change the model from WhatsApp
.aisetmodel default           # back to OPENROUTER_MODEL
.aistyle short Hinglish, savage comebacks, uses 😂🙄
.aistyle reset
.aimemory           # see what AYHA learned from your messages
.aimemory clear
```

While it is on, every plain DM gets a short reply from AYHA using the OpenRouter key. Groups are never answered by this feature, and commands are ignored. To sound like you, the bot quietly learns from the messages **you** send from your own phone (last 40, kept in `data/aiMemory.json`) and copies that tone, slang and emoji habit; `.aistyle` adds explicit instructions on top. A dedicated key or model can be set with `AI_AUTO_REPLY_API_KEY` / `AI_AUTO_REPLY_MODEL`; otherwise it uses `OPENROUTER_API_KEY` / `OPENROUTER_MODEL`. Replies still count against `AI_DAILY_LIMIT`.

### Changing the key and model from WhatsApp

The owner can change the chat key and model at runtime — no `.env` edit, no restart. Both are stored in `data/aiAutoReply.json` and apply to `.ai`, the group chatbot and the private auto-reply:

```text
.aisetkey sk-or-v1-...        # save a key (the command message is deleted when WhatsApp allows it)
.aisetkey                     # show the key masked (sk-or-v1…c48145) and where it comes from
.aisetkey clear               # remove it, fall back to OPENROUTER_API_KEY
.aisetmodel openrouter/free   # save a model
.aisetmodel                   # show the current model and its source
.aisetmodel default           # back to OPENROUTER_MODEL (.env)
```

The saved key beats `AI_AUTO_REPLY_API_KEY` and `OPENROUTER_API_KEY`; the saved model beats `AI_AUTO_REPLY_MODEL` and `OPENROUTER_MODEL`. `.aikey` / `.aimodel` work as aliases. Free models are listed at <https://openrouter.ai/models?max_price=0>.

---

### MySQL storage, memory and scheduling

AYHA memory and the schedule queue live in MySQL (OptikLink). Set `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` and optionally `DB_CONNECTION_LIMIT` in the panel — never in git. Pending migrations run automatically on startup (`CREATE TABLE IF NOT EXISTS`; existing rows are never dropped). Check a deployment with `npm run db:check`.

```text
.dbstatus                     # connection, latency, table counts (no credentials)
.aistatus                     # AYHA memory + scheduler state
.aimemory export              # JSON backup of memory
.aimemory set 1 location Delhi
.aimemory forget 1 location

.schedule new 2026-11-22 09:30 | 916033271400 | Good morning
.schedule new +2h 916033271400 Hello
.schedule new 20:30 916033271400 | caption   # reply to an image/video/document
.schedule list | cancel <id> | delete <id> | history
.schedule edit <id> time +3h | text <new text> | repeat weekly
.schedule status [list|cancel <id>]
.schedule statusnew 2026-11-22 09:30 | My status text
.schedule confirm <token>     # nothing is saved until you confirm
```

Every schedule is previewed and confirmed, validated (recipient, group membership, media type and size), stored in MySQL and sent by a worker that claims jobs atomically, retries temporary failures with backoff, never retries permanent ones, and resumes after a restart or reconnect. Media is kept in `data/schedules/` (gitignored, max 16 MB by default). Status publishing uses Baileys' `status@broadcast` with `statusJidList`; if the connected library cannot send it, the job fails loudly and is never reported as published. Time zone defaults to `Asia/Kolkata` (`SCHEDULE_TIMEZONE`).

## 📖 About

Lily MD helps group admins run large WhatsApp groups and gives them an AI assistant in the same chat. It uses Baileys for the WhatsApp Web multi-device API and runs in a plain Node.js environment with QR or pair-code authentication. Bot name, owner and owner number are configured in `settings.js` and `data/owner.json`.

---

## 🙌 Credits

- [Baileys](https://github.com/WhiskeySockets/Baileys) — WhatsApp multi-device API
- [OpenRouter](https://openrouter.ai) — AYHA's model provider

---

## ⚠️ Warning

This bot is for educational purposes only. It is not an official WhatsApp bot, and using it may lead to your WhatsApp account being banned. Use it at your own risk.

## 📝 Legal

- Not affiliated with, authorized, maintained, sponsored or endorsed by WhatsApp or its affiliates.
- Independent and unofficial software. Use at your own risk.
- Do not spam, send bulk messages, or use this bot for illegal purposes.

## 📄 License

MIT License. Copyright (c) 2026 Rahul Haldar.
