# Deployment Report — Lily MD

## Shape of the deployment

Lily MD supports two deployment models:

| Part | Host | Runtime |
|---|---|---|
| **Website & Dashboard (Standalone)** | **Render (Web Service)** | Node.js web server (`npm run website`). Operates independently without any proxy or external dependency. |
| **WhatsApp Bot (Persistent)** | VPS / Dedicated Node Host | Baileys persistent WebSocket process (`node index.js`). |
| **2-in-1 Unified Mode** | VPS / Dedicated Node Host | Runs both WhatsApp bot and the website together on `PORT`. |

---

## 1. Website on Render (Web Service)

The website is hosted on Render as a Node.js Web Service:

1. **Repository Root**: Deployed directly from the repository root.
2. **Build Command**: `npm install --omit=dev`
3. **Start Command**: `npm run website`
4. **Health Check Path**: `/health` (responds with HTTP 200 and system JSON telemetry).
5. **Port Binding**: Automatically binds to `process.env.PORT` assigned by Render (default 10000).
6. **Independence**: Does not depend on OptikLink for hosting, APIs, or routing.

### Environment Variables on Render:

```env
NODE_ENV=production
BOT_NAME=Lily MD
WEBSITE_URL=https://<your-service>.onrender.com
```

---

## 2. WhatsApp Bot on a Persistent Node Host

```bash
npm install
node index.js
```

Environment:

```env
OPENROUTER_API_KEY=sk-or-...
PORT=8080
WEBSITE_URL=https://<your-service>.onrender.com
FRONTEND_ORIGIN=https://<your-service>.onrender.com
SESSION_TTL_HOURS=12
OWNER_NUMBER=916033352400
SECONDARY_OWNERS=916033271400
```

- `PORT` must be reachable for pairing and the dashboard API.
- `FRONTEND_ORIGIN` is what CORS allows.
- `OWNER_NUMBER` / `SECONDARY_OWNERS` define authorized owner accounts.

---

## 3. Platform Capabilities

- **Render Web Service**: Long-running Node.js process, automatic HTTPS, WebSocket and Server-Sent Events support, and zero server maintenance.
- **OptikLink**: Dedicated container runtime for the bot backend. The website does not connect to or depend on OptikLink.
- **Persistence**: Sessions are backed up atomically into `session.card` with SHA-256 integrity checks.
