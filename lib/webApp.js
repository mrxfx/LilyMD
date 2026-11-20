'use strict';
/**
 * Lily MD web platform — request handler shared by the bot and the standalone site.
 * Copyright (c) 2026 Rahul Haldar
 *
 * Routes
 *   GET  /                 landing page + WhatsApp pairing
 *   GET  /login            owner sign-in
 *   GET  /dashboard        owner dashboard (real API, owner session required)
 *   GET  /config.js        runtime config for a separately hosted frontend
 *   GET  /assets/*         local branding assets
 *   POST /api/pair         start a pairing job (always JSON)
 *   GET  /api/status?id=   pairing job state (always JSON)
 *   *    /api/auth/*      login / logout / me / password
 *   *    /api/dash/*      dashboard data + mutations (owner only)
 *   GET  /api/events       Server-Sent Events status stream
 *
 * Every JSON route answers with JSON even on failure, and the frontend checks
 * content-type + status before parsing — that is what produced the old
 * "Unexpected token 'T', \"The page c\"… is not valid JSON" error when the static
 * Vercel deployment answered /api/pair with an HTML 404 page.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const auth = require('./webAuth');
const api = require('./webApi');
const { isOwnerNumber, ownerNumbers } = require('./ownerNumbers');

const PUBLIC_DIR = path.join(__dirname, '..', 'web', 'public');
const ASSETS_DIR = path.join(__dirname, '..', 'assets');

const JOB_TTL_MS = 15 * 60 * 1000;
const MAX_ACTIVE_JOBS = 4;
const RATE_LIMIT = 6;
const RATE_WINDOW_MS = 60 * 60 * 1000;
const MAX_BUFFER = 64 * 1024 * 1024;

const jobs = new Map();
const jobsByNumber = new Map();
const rate = new Map();

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let deps = null;
function getDeps() {
    if (deps) return deps;
    try {
        deps = {
            pino: require('pino'),
            PhoneNumber: require('awesome-phonenumber'),
            baileys: require('@whiskeysockets/baileys')
        };
    } catch (err) {
        console.error(`[web] pairing unavailable, dependencies missing: ${err.message}`);
        return null;
    }
    return deps;
}

/* ------------------------------------------------------------------ pairing */

function activeJobs() {
    let count = 0;
    for (const job of jobs.values()) {
        if (['initializing', 'waiting', 'code'].includes(job.state)) count += 1;
    }
    return count;
}

function rateLimited(ip) {
    const now = Date.now();
    const hits = (rate.get(ip) || []).filter((time) => now - time < RATE_WINDOW_MS);
    if (hits.length >= RATE_LIMIT) {
        rate.set(ip, hits);
        return true;
    }
    hits.push(now);
    rate.set(ip, hits);
    return false;
}

function closeJob(job) {
    try {
        if (job.socket) job.socket.end(undefined);
    } catch {}
    job.socket = null;
    jobsByNumber.delete(job.number);
    try {
        fs.rmSync(job.dir, { recursive: true, force: true });
    } catch {}
}

function closeJobs() {
    for (const job of jobs.values()) closeJob(job);
    jobs.clear();
    jobsByNumber.clear();
}

function failJob(job, message) {
    job.state = 'failed';
    job.status = 'error';
    job.error = message || 'Pairing failed';
    api.emit('pair.failed', `${job.number}: ${job.error}`, 'error');
    closeJob(job);
}

function packSession(dir) {
    const result = spawnSync('tar', ['-czf', '-', '.'], { cwd: dir, maxBuffer: MAX_BUFFER });
    if (result.error) throw new Error(`tar is unavailable (${result.error.message})`);
    if (result.status !== 0) {
        throw new Error(String(result.stderr || '').trim() || `tar exited with ${result.status}`);
    }
    return result.stdout.toString('base64');
}

async function deliverOwnerPassword(job) {
    if (!isOwnerNumber(job.number) || !job.socket) return false;
    const provisioned = auth.provisionOwnerAccount(job.number);
    if (!provisioned?.tempPassword) return false;
    try {
        await job.socket.sendMessage(`${job.number}@s.whatsapp.net`, {
            text:
                `✨🌸 *Lily MD dashboard*\n\n` +
                `Your WhatsApp is linked. An owner dashboard account was created for *${job.number}*.\n\n` +
                `Temporary password: *${provisioned.tempPassword}*\n\n` +
                `Sign in on the Lily MD website and change this password straight away. ` +
                `Only a hash of it is stored, and it is sent once.`
        });
        job.passwordSent = true;
        api.emit('owner.provision', `dashboard account created for ${job.number}`);
        return true;
    } catch (err) {
        console.error('[web] could not deliver owner password:', err.message);
        api.emit('owner.provision', `password delivery failed for ${job.number}`, 'error');
        return false;
    }
}

async function finishJob(job) {
    if (job.status === 'connected') return;
    job.state = 'connecting';
    job.status = 'packing';
    try {
        await delay(2000); // let creds.json settle before packing
        if (!fs.existsSync(path.join(job.dir, 'creds.json'))) throw new Error('creds.json missing after pairing');
        job.sessionId = packSession(job.dir);
        job.state = 'connected';
        job.status = 'connected';
        job.connectedAt = Date.now();
        api.emit('pair.connected', `${job.number} linked`);
        await deliverOwnerPassword(job);
    } catch (err) {
        job.state = 'failed';
        job.status = 'error';
        job.error = err.message;
        api.emit('pair.failed', `${job.number}: ${err.message}`, 'error');
    } finally {
        closeJob(job);
    }
}

async function runPairing(job) {
    try {
        const available = getDeps();
        if (!available) throw new Error('Pairing is not available on this server yet — run npm install first.');
        const { pino, baileys } = available;
        const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } = baileys;

        let version;
        try {
            ({ version } = await fetchLatestBaileysVersion());
        } catch {}

        job.state = 'waiting';
        const { state, saveCreds } = await useMultiFileAuthState(job.dir);
        const sock = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false,
            browser: ['Ubuntu', 'Chrome', '20.0.04'],
            auth: { creds: state.creds, keys: state.keys },
            syncFullHistory: false,
            markOnlineOnConnect: false,
            generateHighQualityLinkPreview: false,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 15000
        });
        job.socket = sock;

        sock.ev.on('creds.update', saveCreds);
        sock.ev.on('connection.update', (update) => {
            if (update.connection === 'open') finishJob(job).catch((err) => failJob(job, err.message));
            if (update.connection === 'close' && job.state !== 'connected' && job.state !== 'failed') {
                const code = update.lastDisconnect?.error?.output?.statusCode;
                if (code === 401 || code === 403) failJob(job, 'WhatsApp rejected the link request. Check the number and try again.');
            }
        });

        await delay(1500); // the socket needs a moment before requesting the code
        job.state = 'requesting';
        const raw = await sock.requestPairingCode(job.number);
        if (!raw) throw new Error('WhatsApp did not return a pairing code');
        job.code = raw.match(/.{1,4}/g)?.join('-') || raw;
        job.state = 'code';
        job.status = 'code';
        api.emit('pair.code', `pairing code issued for ${job.number}`);
    } catch (err) {
        failJob(job, err.message);
    }
}

function startPairing(number) {
    const id = crypto.randomUUID();
    const job = {
        id,
        number,
        dir: fs.mkdtempSync(path.join(os.tmpdir(), 'lily-pair-')),
        state: 'initializing',
        status: 'pending',
        code: null,
        sessionId: null,
        error: null,
        socket: null,
        passwordSent: false,
        createdAt: Date.now()
    };
    jobs.set(id, job);
    jobsByNumber.set(number, id);

    const ttl = setTimeout(() => {
        if (job.status !== 'connected') failJob(job, 'Timed out — the code was not used in time');
        job.sessionId = null; // keep the creds out of memory after the TTL
        jobs.delete(id);
        jobsByNumber.delete(number);
    }, JOB_TTL_MS);
    if (ttl.unref) ttl.unref();

    runPairing(job).catch((err) => failJob(job, err.message));
    return job;
}

/* -------------------------------------------------------------- http helpers */

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2'
};

function sendJson(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(body)
    });
    res.end(body);
}

function sendFile(res, filePath) {
    fs.readFile(filePath, (err, data) => {
        if (err) {
            sendJson(res, 404, { error: 'not found' });
            return;
        }
        res.writeHead(200, {
            'content-type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
            'cache-control': 'no-cache'
        });
        res.end(data);
    });
}

function readBody(req, limit = 4096) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > limit) {
                reject(new Error('request body too large'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

function publicJob(job) {
    return {
        id: job.id,
        state: job.state,
        // `status` kept for older clients / the in-chat .pair command
        status: job.status,
        code: job.state === 'code' ? job.code : null,
        sessionId: job.status === 'connected' ? job.sessionId : null,
        error: job.status === 'error' ? job.error : null,
        passwordSent: Boolean(job.passwordSent),
        ownerAccount: isOwnerNumber(job.number)
    };
}

/** CORS for a separately hosted frontend. Credentials only for allowed origins. */
function applyCors(req, res) {
    const origin = String(req.headers.origin || '');
    if (!origin) return;
    const allowed = new Set(
        [process.env.WEBSITE_URL, process.env.FRONTEND_ORIGIN]
            .filter(Boolean)
            .map((value) => String(value).replace(/\/$/, ''))
    );
    const host = String(req.headers.host || '');
    const sameOrigin = origin.replace(/^https?:\/\//, '') === host;
    if (!allowed.has(origin) && !sameOrigin) return;
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('access-control-allow-credentials', 'true');
    res.setHeader('vary', 'Origin');
    res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type, x-lily-csrf');
}

/**
 * Handle a web-platform request. Returns true when the request was answered,
 * false when the caller should fall through to its own routes (e.g. /health).
 */
async function handleRequest(req, res, botName = 'Lily MD') {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const route = url.pathname;

    try {
        applyCors(req, res);
        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return true;
        }

        /* ----------------------------- pages ----------------------------- */
        if (req.method === 'GET' && (route === '/' || route === '/index.html')) {
            sendFile(res, path.join(PUBLIC_DIR, 'index.html'));
            return true;
        }
        if (req.method === 'GET' && (route === '/login' || route === '/login.html')) {
            sendFile(res, path.join(PUBLIC_DIR, 'login.html'));
            return true;
        }
        if (req.method === 'GET' && (route === '/dashboard' || route === '/dashboard/')) {
            sendFile(res, path.join(PUBLIC_DIR, 'dashboard.html'));
            return true;
        }
        if (req.method === 'GET' && route.startsWith('/assets/')) {
            const name = path.basename(route);
            const local = path.join(PUBLIC_DIR, 'assets', name);
            sendFile(res, fs.existsSync(local) ? local : path.join(ASSETS_DIR, name));
            return true;
        }
        if (req.method === 'GET' && route === '/config.js') {
            const crossSite = Boolean(process.env.WEBSITE_URL);
            const base = String(process.env.BACKEND_API_URL || '').replace(/\/$/, '');
            const body = `window.LILY_CONFIG = ${JSON.stringify({
                backendUrl: base,
                websiteUrl: process.env.WEBSITE_URL || '',
                features: { pairing: true, auth: true, dashboard: true },
                crossSite
            })};`;
            res.writeHead(200, { 'content-type': MIME['.js'], 'cache-control': 'no-store' });
            res.end(body);
            return true;
        }

        // Static frontend files (app.js, dashboard.js, dashboard.css, …) placed
        // directly in web/public. Restricted to one flat path segment.
        if (req.method === 'GET' && /^\/[A-Za-z0-9_.-]+\.(?:js|css|png|jpe?g|webp|svg|ico|json|txt)$/.test(route)) {
            const file = path.join(PUBLIC_DIR, path.basename(route));
            if (fs.existsSync(file)) {
                sendFile(res, file);
                return true;
            }
        }

        /* --------------------------- pairing API -------------------------- */
        if (req.method === 'POST' && route === '/api/pair') {
            let payload = {};
            try {
                payload = JSON.parse((await readBody(req)) || '{}');
            } catch {
                sendJson(res, 400, { ok: false, code: 'BAD_JSON', error: 'Invalid request.' });
                return true;
            }

            const digits = String(payload.number || '').replace(/[^0-9]/g, '');
            if (digits.length < 7 || digits.length > 15) {
                sendJson(res, 400, {
                    ok: false,
                    code: 'BAD_NUMBER',
                    error: 'Enter your full number with the country code — digits only.'
                });
                return true;
            }
            // Dependencies are checked after validation so a bad number always
            // gets the accurate error.
            const available = getDeps();
            if (!available) {
                sendJson(res, 503, {
                    ok: false,
                    code: 'PAIRING_UNAVAILABLE',
                    error:
                        'Pairing is not available on this server. The pairing code is generated by the Lily MD bot process, not by the website host — run `npm install` and start the bot, then open this page from the bot host.'
                });
                return true;
            }
            if (!available.PhoneNumber('+' + digits).isValid()) {
                sendJson(res, 400, {
                    ok: false,
                    code: 'INVALID_NUMBER',
                    error: 'That number does not look valid. Include your country code, e.g. 916033352400.'
                });
                return true;
            }

            const ip = req.socket.remoteAddress || 'unknown';
            if (rateLimited(ip)) {
                sendJson(res, 429, { ok: false, code: 'RATE_LIMITED', error: 'Too many pairing attempts. Please try again in an hour.' });
                return true;
            }

            // Duplicate protection: reuse a live job for the same number.
            const existingId = jobsByNumber.get(digits);
            const existing = existingId ? jobs.get(existingId) : null;
            if (existing && ['initializing', 'waiting', 'requesting', 'code'].includes(existing.state)) {
                sendJson(res, 200, { ok: true, id: existing.id, reused: true, job: publicJob(existing) });
                return true;
            }
            if (activeJobs() >= MAX_ACTIVE_JOBS) {
                sendJson(res, 503, { ok: false, code: 'BUSY', error: 'Busy right now — please try again in a minute.' });
                return true;
            }

            const job = startPairing(digits);
            api.emit('pair.started', `pairing started for ${digits}`);
            sendJson(res, 200, { ok: true, id: job.id, reused: false, job: publicJob(job) });
            return true;
        }

        if (req.method === 'GET' && (route === '/api/status' || route === '/api/pair/status')) {
            const job = jobs.get(url.searchParams.get('id') || '');
            if (!job) {
                sendJson(res, 404, {
                    ok: false,
                    code: 'JOB_EXPIRED',
                    error: 'This pairing session expired. Please start again.'
                });
                return true;
            }
            sendJson(res, 200, { ok: true, ...publicJob(job) });
            return true;
        }

        if (req.method === 'GET' && route === '/api/info') {
            sendJson(res, 200, {
                ok: true,
                bot: botName,
                ai: 'AYHA',
                owners: ownerNumbers().length,
                features: { pairing: true, auth: true, dashboard: true }
            });
            return true;
        }

        /* ------------------------- auth + dashboard ----------------------- */
        if (route.startsWith('/api/auth/') || route.startsWith('/api/dash/')) {
            if (await api.handleApi(req, res, url)) return true;
        }
        if (req.method === 'GET' && route === '/api/events') {
            return api.handleEvents(req, res);
        }

        return false;
    } catch (err) {
        console.error('[web] request failed:', err.message);
        if (!res.headersSent) {
            sendJson(res, 500, { ok: false, code: 'SERVER_ERROR', error: 'Something went wrong on our side.' });
        }
        return true;
    }
}

module.exports = {
    handleRequest,
    closeJobs,
    PUBLIC_DIR,
    startPairing,
    getJob: (id) => jobs.get(id) || null
};
