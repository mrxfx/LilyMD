# Render Web Service Deployment Guide — Lily MD Website

This guide explains how to deploy and host the **Lily MD** website independently on **Render** as a Node.js Web Service.

---

## 1. Architecture Overview

The website runs as a standalone Node.js service using `web/server.js` (`npm run website`).

- **Independent Runtime**: Serves both static frontend assets (`web/public/*`) and backend APIs (`/api/pair`, `/api/pair/qr`, `/api/pair/cancel`, `/api/commands`, `/api/status`, `/health`).
- **No External Dependencies**: The website does **not** depend on OptikLink, Vercel, or any third-party proxy.
- **Port Management**: Automatically binds to `process.env.PORT` injected by Render (default `10000`) and listens on `0.0.0.0`.
- **Health Checks**: Responds with HTTP 200 on both `/health` and `/api/health` with live system telemetry and JSON metrics.

---

## 2. Deploy Using Blueprint (`render.yaml`)

The repository includes a pre-configured [`render.yaml`](render.yaml):

```yaml
services:
  - type: web
    name: lily-md-website
    env: node
    plan: free
    buildCommand: npm install --omit=dev
    startCommand: npm run website
    healthCheckPath: /health
    autoDeploy: true
    envVars:
      - key: NODE_ENV
        value: production
      - key: BOT_NAME
        value: Lily MD
      - key: WEBSITE_URL
        generateValue: false
```

### Steps:
1. Push your repository to GitHub.
2. In the [Render Dashboard](https://dashboard.render.com/), click **New +** → **Blueprint**.
3. Select your repository.
4. Render will detect `render.yaml` and configure the Web Service automatically.
5. Click **Apply**.

---

## 3. Manual Web Service Configuration

If you prefer to configure the Web Service manually via the Render UI:

| Setting | Value |
| :--- | :--- |
| **Service Type** | Web Service |
| **Name** | `lily-md-website` (or custom) |
| **Environment** | `Node` |
| **Region** | Oregon (US West) or any preferred region |
| **Branch** | `main` |
| **Root Directory** | *(leave blank)* |
| **Build Command** | `npm install --omit=dev` |
| **Start Command** | `npm run website` |
| **Instance Type** | Free |

### Environment Variables (under the "Environment" tab):

| Key | Value | Description |
| :--- | :--- | :--- |
| `NODE_ENV` | `production` | Enables production optimizations |
| `BOT_NAME` | `Lily MD` | Bot brand name displayed in headers |
| `WEBSITE_URL` | `https://your-service.onrender.com` | Your public Render service URL |

*(Note: Render automatically injects `PORT` into the environment; no manual `PORT` variable is required).*

### Advanced Settings:
- **Health Check Path**: `/health`
- **Auto-Deploy**: `Yes` (deploys on git push)

---

## 4. Verification and Routes

Once deployed, Render provisions an automatic TLS certificate for your `*.onrender.com` URL.

You can verify the following endpoints:

| Route | Expected Response | Description |
| :--- | :--- | :--- |
| `GET /` | HTTP 200 (HTML) | Main landing page with dual pairing switcher & commands explorer |
| `GET /health` | HTTP 200 (JSON) | Health check for Render watchdog and uptime monitors |
| `GET /api/health` | HTTP 200 (JSON) | API health endpoint |
| `GET /api/commands`| HTTP 200 (JSON) | Full categorized list of registered bot commands |
| `GET /api/status` | HTTP 200 (JSON) | Bot status and system telemetry |
| `POST /api/pair` | HTTP 200 / 503 (JSON) | Phone code pairing generation |
| `POST /api/pair/qr` | HTTP 200 / 503 (JSON) | Real Baileys QR code generation |
| `POST /api/pair/cancel`| HTTP 200 (JSON) | Pairing cancellation and socket cleanup |

---

## 5. Security & Isolation

- **Zero Credential Leaks**: No session tokens, passwords, or credentials are sent to third parties.
- **Independent State**: Website operates without accessing or modifying the OptikLink database or bot container.
- **CORS Protection**: Allows same-origin queries and explicitly configured origins.
