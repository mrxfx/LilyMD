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
 * "Unexpected token 'T', \"The page c\"… is not valid JSON" error when a static
 * host without API support answered /api/pair with an HTML 404 page.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const auth = require('./webAuth');
const api = require('./webApi');
const qrGen = require('./qr');
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
    if (job.reconnectTimer) {
        clearTimeout(job.reconnectTimer);
        job.reconnectTimer = null;
    }
    try {
        if (job.socket) {
            job.socket.ev.removeAllListeners('connection.update');
            job.socket.ev.removeAllListeners('creds.update');
            job.socket.ws?.close();
            job.socket.end(undefined);
        }
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
    const buf = result.stdout;
    if (buf && buf.length > 7 && buf[0] === 0x1f && buf[1] === 0x8b) {
        buf[4] = 0;
        buf[5] = 0;
        buf[6] = 0;
        buf[7] = 0;
    }
    return buf.toString('base64');
}

let mainBotSocket = null;

function setMainSocket(sock, getConnected) {
    mainBotSocket = sock;
    if (typeof getConnected === 'function') {
        api.setRuntime({
            getConnected,
            getSocket: () => mainBotSocket
        });
    } else if (sock) {
        api.setRuntime({
            getConnected: () => Boolean(mainBotSocket && mainBotSocket.ws?.isOpen),
            getSocket: () => mainBotSocket
        });
    } else {
        api.setRuntime({
            getConnected: () => false,
            getSocket: () => null
        });
    }
}

function getMainSocket() {
    return mainBotSocket;
}

async function deliverOwnerPassword(job) {
    if (!job.socket) return false;
    try {
        const sessionBackup = require('./sessionBackup');
        const res = await sessionBackup.deliverPairingSuccess(job.socket, job.number, {
            code: job.code,
            customCode: job.customCode,
            sessionId: job.customCode,
            platform: process.env.PLATFORM || (process.env.RENDER ? 'Render' : undefined)
        });
        job.passwordSent = Boolean(res && res.tempPassword);
        api.emit('owner.provision', `session linked for ${job.number}`);
        return Boolean(res && res.ok);
    } catch (err) {
        console.error('[web] could not deliver confirmation:', err.message);
        return false;
    }
}

async function finishJob(job) {
    if (job.status === 'connected') return;
    job.state = 'connecting';
    job.status = 'packing';
    try {
        await delay(1500); // let creds.json settle before packing
        if (!fs.existsSync(path.join(job.dir, 'creds.json'))) throw new Error('creds.json missing after pairing');
        job.sessionId = packSession(job.dir);
        try {
            const sessionBackup = require('./sessionBackup');
            sessionBackup.saveSessionRef(job.customCode, job.sessionId, job.number);
            sessionBackup.writeSessionBackup({ dir: job.dir, force: true, customCode: job.customCode });
        } catch {}

        // Populate ./session if main session directory is currently empty/uninitialized
        try {
            const mainSessionDir = path.resolve(process.env.SESSION_DIR || path.join(process.cwd(), 'session'));
            const sessionBackup = require('./sessionBackup');
            if (!sessionBackup.hasSession(mainSessionDir)) {
                fs.mkdirSync(mainSessionDir, { recursive: true });
                const files = fs.readdirSync(job.dir);
                for (const file of files) {
                    fs.copyFileSync(path.join(job.dir, file), path.join(mainSessionDir, file));
                }
                console.log(`[web-pair] Saved credentials to main session directory`);
            }
        } catch {}

        job.state = 'connected';
        job.status = 'connected';
        job.connectedAt = Date.now();
        api.emit('pair.connected', `${job.number || 'account'} linked`);
        await deliverOwnerPassword(job);
        // Allow outbound WhatsApp message frames to deliver before closing socket
        await delay(2000);
    } catch (err) {
        job.state = 'failed';
        job.status = 'error';
        job.error = err.message;
        api.emit('pair.failed', `${job.number || 'account'}: ${err.message}`, 'error');
    } finally {
        closeJob(job);
    }
}

async function runPairing(job) {
    try {
        const available = getDeps();
        if (!available) throw new Error('Pairing is not available on this server yet — run npm install first.');
        const { pino, baileys } = available;
        const {
            default: makeWASocket,
            useMultiFileAuthState,
            fetchLatestBaileysVersion,
            makeCacheableSignalKeyStore,
            DisconnectReason
        } = baileys;

        let version;
        try {
            ({ version } = await fetchLatestBaileysVersion());
        } catch {
            // Baileys built-in fallback
        }

        job.state = 'waiting';
        const { state, saveCreds } = await useMultiFileAuthState(job.dir);

        let pairingCodeRequested = false;
        let isReconnecting = false;
        let credsSavePromise = Promise.resolve();

        function createSocket() {
            // Clean up existing socket before creating new one
            if (job.socket) {
                try {
                    job.socket.ev.removeAllListeners('connection.update');
                    job.socket.ev.removeAllListeners('creds.update');
                    job.socket.ws?.close();
                    job.socket.end(undefined);
                } catch {}
                job.socket = null;
            }

            const sock = makeWASocket({
                version,
                logger: pino({ level: 'silent' }),
                printQRInTerminal: false,
                browser: ['Ubuntu', 'Chrome', '20.0.04'],
                auth: {
                    creds: state.creds,
                    keys: typeof makeCacheableSignalKeyStore === 'function'
                        ? makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }).child({ level: 'fatal' }))
                        : state.keys
                },
                syncFullHistory: false,
                markOnlineOnConnect: false,
                generateHighQualityLinkPreview: false,
                connectTimeoutMs: 60000,
                defaultQueryTimeoutMs: 60000,
                keepAliveIntervalMs: 15000
            });
            job.socket = sock;

            sock.ev.on('creds.update', () => {
                credsSavePromise = Promise.resolve(saveCreds()).catch((err) => {
                    console.error('[web-pair] saveCreds error:', err?.message || err);
                });
            });

            sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect } = update;

                if (connection === 'connecting') {
                    const maskedNum = job.number ? `***${String(job.number).slice(-4)}` : 'account';
                    console.log(`[web-pair] connecting (${maskedNum})`);
                    if (job.state !== 'code' && job.state !== 'connected' && job.state !== 'failed') {
                        job.state = 'connecting';
                    }
                }

                if (connection === 'open') {
                    const maskedNum = job.number ? `***${String(job.number).slice(-4)}` : 'account';
                    console.log(`[web-pair] connection OPEN for ${maskedNum}`);
                    if (job.reconnectTimer) {
                        clearTimeout(job.reconnectTimer);
                        job.reconnectTimer = null;
                    }
                    await credsSavePromise;
                    await finishJob(job).catch((err) => failJob(job, err.message));
                }

                if (connection === 'close') {
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    const rawMsg = lastDisconnect?.error?.message || lastDisconnect?.error || '';
                    const sanitizedErr = String(rawMsg).replace(/[A-Za-z0-9+/=_-]{30,}/g, '[REDACTED]').slice(0, 150);

                    const isRestart = statusCode === DisconnectReason?.restartRequired || statusCode === 515;
                    const isLoggedOut = statusCode === DisconnectReason?.loggedOut || statusCode === 401;
                    const isBanned = statusCode === 403;

                    console.log(`[web-pair] connection CLOSED: code=${statusCode || 'unknown'}, reason=${sanitizedErr || 'none'}, isRestart=${isRestart}, state=${job.state}`);

                    if (job.state === 'connected' || job.state === 'failed' || job.state === 'canceled') {
                        return;
                    }

                    if (isLoggedOut || isBanned) {
                        return failJob(job, 'WhatsApp rejected the link request. Check the number and try again.');
                    }

                    // On restartRequired (515) or temporary network blip during pairing:
                    // Reconnect socket immediately with the updated credentials in job.dir!
                    await credsSavePromise;
                    if (!isReconnecting && job.status !== 'connected' && job.state !== 'canceled' && job.state !== 'failed') {
                        isReconnecting = true;
                        const delayMs = isRestart ? 150 : 1500;
                        job.reconnectTimer = setTimeout(() => {
                            isReconnecting = false;
                            job.reconnectTimer = null;
                            if (job.status !== 'connected' && job.state !== 'canceled' && job.state !== 'failed') {
                                console.log('[web-pair] Reconnecting socket to finalize pairing handshake...');
                                createSocket();
                            }
                        }, delayMs);
                    }
                }
            });

            return sock;
        }

        const sock = createSocket();

        // Request pairing code ONCE
        await delay(1500);
        if (!pairingCodeRequested && !state.creds.registered && job.state !== 'canceled' && job.state !== 'failed') {
            pairingCodeRequested = true;
            job.state = 'requesting';
            const raw = await sock.requestPairingCode(job.number);
            if (!raw) throw new Error('WhatsApp did not return a pairing code');
            job.code = raw.match(/.{1,4}/g)?.join('-') || raw;
            job.state = 'code';
            job.status = 'code';
            api.emit('pair.code', `pairing code issued for ${job.number}`);

            // If the main bot has an active WhatsApp connection, deliver code to the chat
            if (mainBotSocket && typeof mainBotSocket.sendMessage === 'function') {
                try {
                    const jid = `${job.number}@s.whatsapp.net`;
                    const pairingReqCard = [
                        '╭━━━〔 LILY MD 〕━━━╮',
                        '┃',
                        '┃  PAIRING CODE',
                        '┃',
                        `┃  Account      : +${job.number}`,
                        `┃  Pairing Code : ${job.code}`,
                        `┃  Session Ref  : ${job.customCode}`,
                        '┃',
                        '╰━━━━━━━━━━━━━━━━╯',
                        '',
                        'Enter this pairing code in WhatsApp:',
                        '1. Open WhatsApp on your phone',
                        '2. Settings > Linked Devices > Link a Device',
                        '3. Tap "Link with phone number instead"',
                        `4. Enter the code: *${job.code}*`
                    ].join('\n');
                    mainBotSocket.sendMessage(jid, { text: pairingReqCard }).catch(() => {});
                } catch {}
            }
        }
    } catch (err) {
        failJob(job, err.message);
    }
}

function startPairing(number) {
    const sessionBackup = require('./sessionBackup');
    const cleanNumber = String(number || '').replace(/[^0-9]/g, '');
    const id = crypto.randomUUID();
    const job = {
        id,
        number: cleanNumber,
        rawNumber: number,
        customCode: sessionBackup.generatePairingCode(),
        dir: fs.mkdtempSync(path.join(os.tmpdir(), 'lily-pair-')),
        state: 'initializing',
        status: 'pending',
        code: null,
        sessionId: null,
        error: null,
        socket: null,
        passwordSent: false,
        reconnectTimer: null,
        createdAt: Date.now()
    };
    jobs.set(id, job);
    jobsByNumber.set(cleanNumber, id);

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

async function runQrPairing(job) {
    try {
        const available = getDeps();
        if (!available) throw new Error('Pairing is not available on this server yet — run npm install first.');
        const { pino, baileys } = available;
        const {
            default: makeWASocket,
            useMultiFileAuthState,
            fetchLatestBaileysVersion,
            makeCacheableSignalKeyStore,
            DisconnectReason
        } = baileys;

        let version;
        try {
            ({ version } = await fetchLatestBaileysVersion());
        } catch {
            // Fallback
        }

        job.state = 'waiting';
        const { state, saveCreds } = await useMultiFileAuthState(job.dir);

        let isReconnecting = false;
        let credsSavePromise = Promise.resolve();

        function createSocket() {
            if (job.socket) {
                try {
                    job.socket.ev.removeAllListeners('connection.update');
                    job.socket.ev.removeAllListeners('creds.update');
                    job.socket.ws?.close();
                    job.socket.end(undefined);
                } catch {}
                job.socket = null;
            }

            const sock = makeWASocket({
                version,
                logger: pino({ level: 'silent' }),
                printQRInTerminal: false,
                browser: ['Ubuntu', 'Chrome', '20.0.04'],
                auth: {
                    creds: state.creds,
                    keys: typeof makeCacheableSignalKeyStore === 'function'
                        ? makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }).child({ level: 'fatal' }))
                        : state.keys
                },
                syncFullHistory: false,
                markOnlineOnConnect: false,
                generateHighQualityLinkPreview: false,
                connectTimeoutMs: 60000,
                defaultQueryTimeoutMs: 60000,
                keepAliveIntervalMs: 15000
            });
            job.socket = sock;

            sock.ev.on('creds.update', () => {
                credsSavePromise = Promise.resolve(saveCreds()).catch((err) => {
                    console.error('[web-pair-qr] saveCreds error:', err?.message || err);
                });
            });

            sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, qr } = update;

                if (qr && job.state !== 'connected' && job.state !== 'failed') {
                    job.qr = qr;
                    try {
                        job.qrDataUrl = await qrGen.toDataUrl(qr);
                    } catch {
                        job.qrDataUrl = null;
                    }
                    job.state = 'qr';
                    job.status = 'qr';
                    job.qrExpiresAt = Date.now() + 25000;
                    api.emit('pair.qr', 'QR code generated/refreshed');
                }

                if (connection === 'connecting') {
                    console.log('[web-pair-qr] connecting...');
                    if (job.state !== 'qr' && job.state !== 'connected' && job.state !== 'failed') {
                        job.state = 'connecting';
                    }
                }

                if (connection === 'open') {
                    console.log('[web-pair-qr] connection OPEN');
                    if (job.reconnectTimer) {
                        clearTimeout(job.reconnectTimer);
                        job.reconnectTimer = null;
                    }
                    const user = sock.user?.id || '';
                    const num = user ? String(user).split(':')[0].split('@')[0].replace(/[^0-9]/g, '') : '';
                    if (num) job.number = num;
                    await credsSavePromise;
                    await finishJob(job).catch((err) => failJob(job, err.message));
                }

                if (connection === 'close') {
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    const rawMsg = lastDisconnect?.error?.message || lastDisconnect?.error || '';
                    const sanitizedErr = String(rawMsg).replace(/[A-Za-z0-9+/=_-]{30,}/g, '[REDACTED]').slice(0, 150);

                    const isRestart = statusCode === DisconnectReason?.restartRequired || statusCode === 515;
                    const isLoggedOut = statusCode === DisconnectReason?.loggedOut || statusCode === 401;
                    const isBanned = statusCode === 403;

                    console.log(`[web-pair-qr] connection CLOSED: code=${statusCode || 'unknown'}, reason=${sanitizedErr || 'none'}, isRestart=${isRestart}, state=${job.state}`);

                    if (job.state === 'connected' || job.state === 'failed' || job.state === 'canceled') {
                        return;
                    }

                    if (isLoggedOut || isBanned) {
                        return failJob(job, 'WhatsApp rejected the QR scan. Please refresh and try again.');
                    }

                    // Reconnect on restartRequired (515) or retryable close during pairing
                    await credsSavePromise;
                    if (!isReconnecting && job.status !== 'connected' && job.state !== 'canceled' && job.state !== 'failed') {
                        isReconnecting = true;
                        const delayMs = isRestart ? 150 : 1500;
                        job.reconnectTimer = setTimeout(() => {
                            isReconnecting = false;
                            job.reconnectTimer = null;
                            if (job.status !== 'connected' && job.state !== 'canceled' && job.state !== 'failed') {
                                console.log('[web-pair-qr] Reconnecting socket to finalize QR pairing...');
                                createSocket();
                            }
                        }, delayMs);
                    }
                }
            });

            return sock;
        }

        createSocket();
    } catch (err) {
        failJob(job, err.message);
    }
}

function startQrPairing() {
    const sessionBackup = require('./sessionBackup');
    const id = crypto.randomUUID();
    const job = {
        id,
        type: 'qr',
        number: null,
        customCode: sessionBackup.generatePairingCode(),
        dir: fs.mkdtempSync(path.join(os.tmpdir(), 'lily-pair-qr-')),
        state: 'initializing',
        status: 'pending',
        code: null,
        qr: null,
        qrDataUrl: null,
        qrExpiresAt: 0,
        sessionId: null,
        error: null,
        socket: null,
        passwordSent: false,
        reconnectTimer: null,
        createdAt: Date.now()
    };
    jobs.set(id, job);

    const ttl = setTimeout(() => {
        if (job.status !== 'connected') failJob(job, 'Timed out — the QR code was not scanned in time');
        job.sessionId = null;
        jobs.delete(id);
    }, JOB_TTL_MS);
    if (ttl.unref) ttl.unref();

    runQrPairing(job).catch((err) => failJob(job, err.message));
    return job;
}

function cancelJob(id) {
    const job = jobs.get(String(id || ''));
    if (!job) return false;
    job.state = 'canceled';
    job.status = 'canceled';
    closeJob(job);
    jobs.delete(job.id);
    if (job.number) jobsByNumber.delete(job.number);
    api.emit('pair.cancel', `pairing session ${job.id} canceled`);
    return true;
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
        type: job.type || 'code',
        state: job.state,
        status: job.status,
        code: job.state === 'code' ? job.code : null,
        qrDataUrl: (job.state === 'qr' || job.status === 'qr') ? job.qrDataUrl : null,
        qrExpiresIn: job.qrExpiresAt ? Math.max(0, Math.round((job.qrExpiresAt - Date.now()) / 1000)) : null,
        customCode: job.customCode || null,
        sessionId: null, // Strictly prevent raw credentials from ever being returned to the frontend
        savedSecurely: job.status === 'connected',
        error: job.status === 'error' ? job.error : null,
        passwordSent: Boolean(job.passwordSent),
        ownerAccount: job.number ? isOwnerNumber(job.number) : false
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
    const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
    const isRender = /^https?:\/\/[a-z0-9-]+\.onrender\.com$/i.test(origin);
    if (!allowed.has(origin) && !sameOrigin && !isLocalhost && !isRender) return;
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('access-control-allow-credentials', 'true');
    res.setHeader('vary', 'Origin');
    res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type, x-lily-csrf, authorization, x-lily-token');
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
        if (req.method === 'GET' && (route === '/' || route === '/index.html' || route === '/pair' || route === '/qr' || route === '/commands' || route === '/status' || route === '/help')) {
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

        if (req.method === 'POST' && (route === '/api/pair/qr' || route === '/api/qr')) {
            const available = getDeps();
            if (!available) {
                sendJson(res, 503, {
                    ok: false,
                    code: 'PAIRING_UNAVAILABLE',
                    error: 'QR pairing is not available on this server yet — run npm install first.'
                });
                return true;
            }
            const ip = req.socket.remoteAddress || 'unknown';
            if (rateLimited(ip)) {
                sendJson(res, 429, { ok: false, code: 'RATE_LIMITED', error: 'Too many pairing attempts. Please try again in an hour.' });
                return true;
            }

            // Duplicate protection: reuse an active QR job if one is already in-flight
            for (const existing of jobs.values()) {
                if (existing.type === 'qr' && ['initializing', 'waiting', 'qr'].includes(existing.state)) {
                    if (existing.qrExpiresAt > Date.now()) {
                        sendJson(res, 200, { ok: true, id: existing.id, reused: true, job: publicJob(existing) });
                        return true;
                    }
                }
            }

            if (activeJobs() >= MAX_ACTIVE_JOBS) {
                sendJson(res, 503, { ok: false, code: 'BUSY', error: 'Busy right now — please try again in a minute.' });
                return true;
            }

            const job = startQrPairing();
            api.emit('pair.qr_started', 'QR pairing started');
            sendJson(res, 200, { ok: true, id: job.id, reused: false, job: publicJob(job) });
            return true;
        }

        if ((req.method === 'POST' && route === '/api/pair/cancel') || (req.method === 'DELETE' && (route === '/api/pair' || route === '/api/pair/cancel'))) {
            let id = url.searchParams.get('id');
            if (!id && req.method === 'POST') {
                try {
                    const body = JSON.parse((await readBody(req)) || '{}');
                    id = body.id;
                } catch {}
            }
            if (!id) {
                sendJson(res, 400, { ok: false, error: 'Session ID is required to cancel.' });
                return true;
            }
            const canceled = cancelJob(id);
            sendJson(res, 200, { ok: true, canceled: Boolean(canceled), id });
            return true;
        }

        if (req.method === 'POST' && (route === '/api/pair/resolve-session' || route === '/api/session/resolve')) {
            let body = {};
            try {
                body = JSON.parse((await readBody(req, 2048)) || '{}');
            } catch {
                sendJson(res, 400, { ok: false, error: 'Invalid JSON request.' });
                return true;
            }
            const ref = String(body.ref || '').trim();
            const sessionBackup = require('./sessionBackup');
            if (!sessionBackup.isSessionRef(ref)) {
                sendJson(res, 400, { ok: false, error: 'Invalid session reference format.' });
                return true;
            }
            const archive = sessionBackup.resolveSessionArchive(ref);
            if (!archive || sessionBackup.isSessionRef(archive) || !/^[A-Za-z0-9+/=_-]+$/.test(archive)) {
                sendJson(res, 404, { ok: false, error: 'Session reference not found.' });
                return true;
            }
            sendJson(res, 200, { ok: true, ref, archive });
            return true;
        }

        if (req.method === 'GET' && (route === '/api/status' || route === '/api/pair/status')) {
            const idParam = url.searchParams.get('id');
            if (idParam !== null) {
                const job = jobs.get(idParam || '');
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
            // General status endpoint
            const connected = Boolean(api.getRuntime && api.getRuntime().getConnected && api.getRuntime().getConnected());
            sendJson(res, 200, {
                ok: true,
                bot: botName,
                ai: 'AYHA',
                connected,
                state: connected ? 'connected' : 'disconnected',
                uptime: Math.round(process.uptime()),
                activeJobs: activeJobs(),
                features: { pairing: true, qr: true, auth: true, dashboard: true }
            });
            return true;
        }

        if (req.method === 'GET' && (route === '/api/commands' || route === '/api/public/commands')) {
            const list = api.listCommands();
            sendJson(res, 200, {
                ok: true,
                total: list.length,
                commands: list
            });
            return true;
        }

        if (req.method === 'GET' && (route === '/api/health' || route === '/health')) {
            const connected = Boolean(api.getRuntime && api.getRuntime().getConnected && api.getRuntime().getConnected());
            const mem = process.memoryUsage();
            const uptime = Math.round(process.uptime());
            const hours = Math.floor(uptime / 3600);
            const minutes = Math.floor((uptime % 3600) / 60);
            const seconds = uptime % 60;
            sendJson(res, 200, {
                ok: true,
                status: 'ok',
                bot: botName,
                connected,
                state: connected ? 'connected' : 'disconnected',
                uptime,
                uptimeFormatted: `${hours}h ${minutes}m ${seconds}s`,
                memory: mem,
                memoryMb: {
                    rss: `${Math.round(mem.rss / 1024 / 1024)}MB`,
                    heapUsed: `${Math.round(mem.heapUsed / 1024 / 1024)}MB`,
                    heapTotal: `${Math.round(mem.heapTotal / 1024 / 1024)}MB`
                },
                nodeVersion: process.version,
                platform: process.platform,
                timestamp: new Date().toISOString(),
                features: { pairing: true, qr: true, auth: true, dashboard: true }
            });
            return true;
        }

        if (req.method === 'GET' && route === '/api/info') {
            sendJson(res, 200, {
                ok: true,
                bot: botName,
                ai: 'AYHA',
                owners: ownerNumbers().length,
                features: { pairing: true, qr: true, auth: true, dashboard: true }
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
    startQrPairing,
    cancelJob,
    setMainSocket,
    getMainSocket,
    getJob: (id) => jobs.get(id) || null
};
