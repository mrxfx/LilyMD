# 🌸 Lily MD — Next-Gen WhatsApp Bot & AYHA AI Assistant

<div align="center">
  <img src="assets/logo.png" alt="Lily MD Logo" width="240" />
  <p><strong>A modern, resilient WhatsApp Multi-Device bot built on Baileys with AYHA AI, unified web dashboard, single-file session management, and dual-model image vision.</strong></p>

  [![Node Version](https://img.shields.io/badge/Node.js-%3E%3D18.0.0-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
  [![Baileys](https://img.shields.io/badge/Baileys-v7.0.0--rc.9-25D366?style=for-the-badge&logo=whatsapp&logoColor=white)](https://github.com/WhiskeySockets/Baileys)
  [![AI Engine](https://img.shields.io/badge/AYHA-Gemini%20%7C%20Groq%20%7C%20OpenRouter-8E75B2?style=for-the-badge&logo=google-gemini&logoColor=white)](https://ai.google.dev/)
  [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](LICENSE)
</div>

---

## 📑 Project Profile

| Key Specification | Value / Description |
|---|---|
| **Project Name** | **Lily MD** (v3.0.8) |
| **Author / Owner** | **Rahul Haldar** (`916033352400`) |
| **WhatsApp Library** | [`@whiskeysockets/baileys`](https://github.com/WhiskeySockets/Baileys) (v7.0.0-rc.9, Multi-Device) |
| **AI Assistant** | **AYHA** (Benglish persona: Rahul from WebCraft Studio) |
| **AI Models & Vision** | Google Gemini 2.5/Flash, Groq LLaMA, OpenRouter; Image Vision with `gemini-3.6-flash` & `gemini-3.1-flash-lite` fallback |
| **Session Architecture** | **Single-File Setup** (`session.card`) with automatic decompression & credential restoration |
| **Web Server & UI** | Native zero-dependency HTTP server, Cyberpunk Anime Theme, Pairing Portal, and Web Dashboard |
| **Database Storage** | MySQL with idempotent automatic migrations; local JSON failover storage in `data/` |
| **Hosting Modes** | **2-in-1 Unified Mode** (`npm start`), **Standalone Web Mode** (`npm run website`), Docker, VPS, Render |

---

## 🌟 Key Highlights

- **⚡ Single-File Session Setup (`session.card`)**: Pair your bot once on the web, copy your `session.card`, replace the placeholder in `session.card`, and run `npm start`. Zero manual credential hunting or repeated QR code scanning!
- **🔄 Unified Pairing Parity**: Website pairing (`/pair`) and terminal pairing (`node index.js`) share identical Baileys connection lifecycles, session persistence, command routing, and dashboard authentication.
- **🛡️ Secure Owner Dashboard**: Cyberpunk-styled real-time telemetry console (`/dashboard`, `/login`) protected by cryptographic `scrypt` password hashing, IP rate-limiting, and timing-safe authentication.
- **🔑 WhatsApp `.setpass` Command**: Configure your permanent dashboard password straight from WhatsApp using `.setpass <new-password>`. Unauthorized users are rejected and passwords are never logged.
- **🧠 Multi-Provider AYHA AI Engine**: High-speed, resilient natural language conversations powered by Google Gemini, Groq, and OpenRouter with automatic key rotation and sticky healthy keys.
- **👁️ Dual-Model Image Vision**: Send or reply to any photo or sticker with `.vision` to get real-time visual analysis. Employs `gemini-3.6-flash` as primary and automatically falls back to `gemini-3.1-flash-lite`.
- **📦 113+ WhatsApp Commands**: Full suite of group administration tools, universal 13-platform media downloader, anime reactions, sticker creation, AI workflows, and games.

---

## ⚡ Quick Start

### 1. Prerequisites
- **Node.js** >= 18.0.0 ([Download Node.js](https://nodejs.org/))
- **Git** ([Download Git](https://git-scm.com/))
- Optional: **MySQL Server** (if omitted, Lily MD automatically uses local JSON fallback storage)

### 2. Clone & Install
```bash
git clone https://github.com/Rahulhaldar/LilyMD.git
cd LilyMD
npm install
```

### 3. Initialize Environment
Copy the example environment configuration file:
```bash
cp .env.example .env
```
Open `.env` in your editor and configure your credentials:
```env
BOT_NAME="Lily MD"
OWNER_NUMBER="916033352400"
GEMINI_API="your-gemini-api-key"
OPENROUTER_API_KEY="sk-or-v1-..."
GROQ_API_KEY="gsk_..."
PORT=5745
```

---

## 💳 Single-File Session Setup (`session.card`)

Hosting Lily MD on any server, VPS, or cloud platform takes less than 60 seconds with **`session.card`**:

```
┌─────────────────────────────────────────────────────────────┐
│ 1. Pair on Web UI    ───►  Receive session.card in WhatsApp │
│                                         │                   │
│                                         ▼                   │
│ 3. Run: npm start    ◄───  2. Paste in session.card file    │
└─────────────────────────────────────────────────────────────┘
```

### Step-by-Step Instructions:

1. **Pair through the Website**:
   - Open your web pairing portal (e.g., `https://lilymd.onrender.com/pair` or `http://localhost:5745/pair`).
   - Enter your phone number with country code (e.g., `916033352400`) and request an 8-character pairing code, or scan the interactive QR code.
   - Enter the pairing code in WhatsApp (*Linked Devices > Link with phone number*).
2. **Receive your Session Card**:
   - As soon as pairing completes, Lily MD automatically delivers a **`session.card`** document directly into your WhatsApp chat along with your temporary dashboard password.
   - The session card contains an encoded bundle starting with `LilyMD~...`.
3. **Configure `session.card`**:
   - In the project root, open `session.card` (if not present, copy `session.card.example` to `session.card`).
   - Replace the demo placeholder line (`LilyMD~DEMO_SESSION_CARD_PLACEHOLDER`) with your actual session code:
   ```text
   # =======================================================
   # LILY MD — SINGLE-FILE SESSION SETUP (session.card)
   # =======================================================
   LilyMD~YOUR_ENCODED_SESSION_CARD_HERE
   ```
4. **Start the Bot**:
   ```bash
   npm start
   ```
   Lily MD will detect `session.card`, restore your session credentials into `./session`, and connect immediately without prompting for QR codes or pairing codes!

> [!TIP]
> **Git Safety**: `session.card` is strictly ignored by `.gitignore`. The safe placeholder file `session.card.example` is tracked in Git, ensuring your live credentials are never committed or exposed.

---

## 🔐 Web Dashboard & `.setpass` Password Management

Lily MD features a built-in owner dashboard providing real-time telemetry, memory state, scheduler jobs, and system controls.

<div align="center">
  <img src="assets/dashboard-preview.png" alt="Dashboard Preview" width="600" />
</div>

### Dual Dashboard Authentication

1. **Temporary Password on Pairing**:
   - Whenever you link the bot (via web pairing or terminal pairing), a secure random temporary password is generated and sent to you privately in WhatsApp.
2. **Set a Permanent Password via WhatsApp**:
   - As the verified bot owner, simply send this command in WhatsApp:
     ```text
     .setpass MySecretPassword123
     ```
   - **Immediate Invalidation**: The temporary password is instantly revoked.
   - **Persistent & Hashed**: The new password is cryptographically hashed with `scrypt` and saved to `data/dashboard_auth.json`. It persists across server restarts.
   - **Privacy**: The bot confirms success in chat without ever logging or echoing the plain-text password.
3. **Accessing the Dashboard**:
   - Open `/login` in your browser (e.g. `http://localhost:5745/login` or `https://lilymd.onrender.com/login`).
   - Enter your password to enter `/dashboard`.
   - The dashboard dynamically monitors Baileys socket state, message counts, active chats, server uptime, and database metrics.

---

## 🤖 AYHA AI Assistant & Vision

**AYHA** is Lily MD's native AI assistant. AYHA features intelligent multi-provider fallback, dynamic key pooling, and Benglish conversation support.

### AI Engine Architecture

```
User Query ──► [Google Gemini Primary] ──(Quota / Error)──► [Groq LLaMA] ──► [OpenRouter Fallback]
```

- **Primary Provider**: Google Gemini (`gemini-2.5-flash`, `gemini-2.5-pro`).
- **Fast Chat Provider**: Groq Cloud (`llama-3.3-70b-versatile`).
- **Universal Provider**: OpenRouter (`openrouter/free` router or custom models).
- **Key Rotation**: Supports comma-separated API keys in `.env` (e.g. `GEMINI_API="key1,key2,key3"`). Keys that trigger 429 quota exhaustion are cooled down while healthy keys remain sticky.

### Image Vision Mode

Lily MD includes dual-model visual recognition for images and photos:
- **Primary Vision Model**: `gemini-3.6-flash`
- **Fallback Vision Model**: `gemini-3.1-flash-lite`

```text
.vision on          # Enable auto-vision on replied or sent images
.vision off         # Disable auto-vision
.vision status      # Check vision status and active model chain
```

Reply to any image with `.ai what is in this photo?` or `.vision describe this artwork` to receive detailed AI image understanding.

### WhatsApp AI Control Commands

| Command | Usage | Description |
|---|---|---|
| `.ai <prompt>` | `.ai explain quantum computing` | Ask AYHA any question with context awareness. |
| `.chatbot on/off` | `.chatbot on` | Automatically respond to mentions and replies in WhatsApp groups. |
| `.aiutoreply on/off`| `.aiutoreply on` | Turn on smart private DM auto-replies matching your conversational style. |
| `.aistyle <style>` | `.aistyle friendly with emojis` | Customize AYHA's conversational tone. |
| `.aimemory` | `.aimemory` / `.aimemory clear` | View or wipe learned memory facts about users and chats. |
| `.aisetkey <key>` | `.aisetkey sk-or-v1-...` | Update your AI API key dynamically from WhatsApp without restart. |
| `.aisetmodel <m>` | `.aisetmodel gemini-2.5-flash` | Switch active AI model on the fly. |

---

## 📚 WhatsApp Commands Directory

Lily MD features **113+ modular commands** with dual-prefix support (`.` or `-`):

### 🛡️ Owner & Administration Commands (Owner / Sudo Only)
| Command | Aliases | Description |
|---|---|---|
| `.setpass <pass>` | - | Set a permanent web dashboard password (invalidates temporary password). |
| `.restart` | `.reboot` | Safely restart the Lily MD bot process. |
| `.mode <public/private>` | - | Toggle bot between public use and owner-only private mode. |
| `.block / .unblock` | - | Block or unblock a user from interacting with the bot. |
| `.broadcast <msg>` | `.bc` | Broadcast a message to all active chats and groups. |
| `.shutdown` | `.stop` | Terminate the bot process gracefully. |
| `.dbstatus` | - | Display MySQL database connection, pool health, and table counts. |
| `.setsudo / .delsudo` | - | Manage bot operators (sudo users). |

### 👥 Group Management Commands (Admins Only)
| Command | Aliases | Description |
|---|---|---|
| `.tagall <message>` | `.everyone`, `.hidetag` | Tag all group members in a single announcement. |
| `.kick @user` | `.remove` | Remove a member from the WhatsApp group. |
| `.add <number>` | - | Add a user to the group via phone number. |
| `.promote @user` | `.admin` | Promote a group member to administrator. |
| `.demote @user` | `.unadmin` | Demote an admin back to regular member. |
| `.mute / .unmute` | `.group open/close` | Lock or unlock group chat messaging permissions. |
| `.warn @user` | - | Issue a formal warning (auto-kick on 3rd warning). |
| `.warnings @user` | `.checkwarn` | Check existing warnings for a user. |
| `.resetwarn @user` | - | Reset warning count for a member. |
| `.welcome on/off` | - | Enable or disable custom welcome cards for new joiners. |
| `.goodbye on/off` | - | Enable or disable goodbye announcements when members leave. |
| `.antilink on/off` | - | Automatically delete messages with invite links and kick offenders. |
| `.antibadword on/off` | - | Censor vulgar words and warn senders. |
| `.antibot on/off` | - | Automatically eject foreign unauthorized bots. |

### 📥 Universal Media Downloader (`.dl`)
| Command | Syntax | Supported Platforms |
|---|---|---|
| `.dl <link>` | `.dl https://...` | **Universal Auto-Detector**: Automatically detects TikTok, Instagram, YouTube, Facebook, Twitter/X, Pinterest, Spotify, SoundCloud, Threads, Videy, Mega, Sfile, and MediaFire! |
| `.song <name/url>` | `.play <query>` | Search and download MP3 audio from YouTube/Spotify. |
| `.video <name/url>` | `.ytmp4 <query>` | Download high-definition MP4 video from YouTube. |
| `.tiktok <url>` | `.tt` | Download TikTok video without watermark. |
| `.ig <url>` | `.insta` | Download Instagram Reels, Posts, and Carousels. |
| `.fb <url>` | `.facebook` | Download Facebook public videos. |
| `.twitter <url>` | `.x` | Download media from Twitter / X. |
| `.spotify <url>` | - | Download Spotify track audio. |
| `.lyrics <song>` | - | Fetch verified lyrics for any song title. |

### 🎨 Stickers & Media Tools
| Command | Description |
|---|---|
| `.sticker` (`.s`) | Convert replied image, GIF, or short video into an animated WhatsApp sticker. |
| `.take <pack>\|<author>` | Change sticker pack name and author metadata. |
| `.crop` | Crop a sticker into a square aspect ratio. |
| `.circle` | Crop a sticker into a circle badge. |
| `.emojimix <emoji1>+<emoji2>` | Merge two emojis into a custom sticker via Google Kitchen. |
| `.attp <text>` | Generate animated rainbow text sticker. |
| `.ttp <text>` | Generate clean static text sticker. |
| `.tgsticker <pack-url>` | Import full sticker packs directly from Telegram. |

### 🎮 Games, Trivia & Fun
| Command | Description |
|---|---|
| `.tictactoe @user` | Interactive multi-player Tic-Tac-Toe in WhatsApp chat. |
| `.hangman` | Classic word-guessing game with visual hangman stages. |
| `.trivia` | Multiple-choice quiz questions across multiple categories. |
| `.truth` / `.dare` | Random truth questions and daring challenges. |
| `.8ball <question>` | Ask the mystical Magic 8-Ball a question. |
| `.quote` / `.joke` | Get curated motivational quotes or funny jokes. |
| `.hug`, `.slap`, `.bonk`, `.pat`, `.cuddle` | 26 anime reaction commands with Tenor animated GIFs. |

### ⚙️ Utilities & Information
| Command | Description |
|---|---|
| `.alive` | Check if Lily MD is online, displaying host uptime, RAM, and ping. |
| `.ping` | Benchmark WebSocket ping and Baileys response latency. |
| `.help` / `.menu` | Display the interactive command categories and documentation. |
| `.translate <lang> <text>` | Translate text between 100+ languages via Google Translate. |
| `.tts <lang> <text>` | Convert text into spoken voice note audio. |
| `.weather <city>` | Live weather forecast, temperature, humidity, and conditions. |
| `.ss <url>` | Capture a full-page desktop screenshot of any website. |
| `.pair <number>` | Request an 8-character terminal pairing code directly in chat. |

---

## 🚀 Deployment Guides

### Mode A: 2-in-1 Unified Mode (Recommended for Local / VPS)
Runs both the WhatsApp bot engine and the Cyberpunk web dashboard in a single Node process:

```bash
npm start
# Server listens on PORT (default: 5745)
# Web dashboard: http://localhost:5745/
# Pairing portal: http://localhost:5745/pair
```

### Mode B: Standalone Web Service on Render (Free Tier)
Run just the website, pairing portal, and dashboard on Render's free Web Service:

1. Fork or push this repository to your GitHub.
2. In the [Render Dashboard](https://dashboard.render.com/), click **New + > Web Service**.
3. Select your repository.
4. Set **Build Command**: `npm install --omit=dev`
5. Set **Start Command**: `npm run website`
6. Under **Advanced Settings**, set **Health Check Path** to `/health`.
7. Click **Create Web Service**. Render provisions free SSL and deploys `https://your-app.onrender.com`.

### Mode C: VPS / Pterodactyl Panel / Docker
1. Set up Node.js 18+ and upload the repository files.
2. Ensure `session.card` contains your active session card code.
3. Start the process with PM2 for automated restarts:
   ```bash
   npm install -g pm2
   pm2 start index.js --name "lily-md"
   pm2 save
   pm2 startup
   ```

---

## 🔧 Environment Variables Reference

| Variable | Default | Required? | Purpose |
|---|---|---|---|
| `PORT` | `5745` | No | HTTP server port for dashboard, pairing, and `/health`. |
| `BOT_NAME` | `Lily MD` | No | Display name used in bot messages and dashboard. |
| `OWNER_NUMBER` | `916033352400` | Recommended | WhatsApp number with full admin privileges. |
| `WEBSITE_URL` | `https://lilymd.onrender.com` | No | Public website URL used for AI referer and `.website`. |
| `GEMINI_API` | - | Recommended | Google Gemini API key(s) (comma-separated for pool rotation). |
| `GROQ_API_KEY` | - | Optional | Groq Cloud API key for fast LLaMA completions. |
| `OPENROUTER_API_KEY` | - | Optional | OpenRouter API key for third-party models. |
| `SESSION_ID` | - | Optional | Direct base64 session backup string (fallback to `session.card`). |
| `DB_HOST` | `localhost` | Optional | MySQL server host. |
| `DB_PORT` | `3306` | Optional | MySQL server port. |
| `DB_NAME` | `lilymd` | Optional | MySQL database name. |
| `DB_USER` | `root` | Optional | MySQL username. |
| `DB_PASSWORD` | - | Optional | MySQL password. |

---

## 🧪 Testing & Verification

Run the built-in test suite to verify code health before deploying:

```bash
# Syntax-check all 187+ JavaScript files
npm test

# Verify session restoration logic
npm run test:session

# Run Web Dashboard & API integration checks
npm run test:web

# Test AI engine & provider failover
npm run test:ai
```

---

## 🔒 Security & Reliability

- **Encrypted Session Persistence**: Real credentials in `session/` and `session.card` are never logged, never exposed in dashboard API responses, and strictly excluded from Git commits.
- **Timing-Safe Auth**: Dashboard login uses `crypto.timingSafeEqual` and `scrypt` hashing with unique cryptographic salts to neutralize brute-force and timing attacks.
- **Auto-Reconnect Backoff**: Baileys socket disconnections are handled with exponential backoff (2s → 60s) to safeguard against WhatsApp IP rate-limits.
- **Permission Verification**: Commands requiring elevation strictly verify the sender's unmasked JID against `OWNER_NUMBER` and group admin lists.

---

## ⚖️ Legal & Disclaimer

- **Lily MD** is an independent, open-source project and is **not affiliated with, endorsed, or sponsored by WhatsApp LLC or Meta Platforms, Inc.**
- Use this software responsibly. Excessive spamming or violating WhatsApp's Terms of Service may result in account bans. The developers assume no liability for misuse.

---

## 📄 License

Distributed under the **MIT License**. See `LICENSE` for details.

Copyright (c) 2026 **Rahul Haldar**. All rights reserved.
