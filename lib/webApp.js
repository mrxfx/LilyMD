'use strict';
/**
 * Pairing website — request handler shared by the bot and the standalone site.
 * Copyright (c) 2026 Rahul Haldar
 *
 * The bot serves this on the same port as its health endpoint (`node index.js`),
 * and `npm run website` starts it on its own. Nothing in here depends on the
 * bot's socket: it opens a temporary Baileys session per visitor, hands back the
 * resulting SESSION_ID once, then drops it.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const PUBLIC_DIR = path.join(__dirname, '..', 'web', 'public');
const ASSETS_DIR = path.join(__dirname, '..', 'assets');

const JOB_TTL_MS = 15 * 60 * 1000;
const MAX_ACTIVE_JOBS = 4;
const RATE_LIMIT = 6;
const RATE_WINDOW_MS = 60 * 60 * 1000;
const MAX_BUFFER = 64 * 1024 * 1024;

const jobs = new Map();
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
        if (job.status === 'pending' || job.status === 'code') count += 1;
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
    try {
        fs.rmSync(job.dir, { recursive: true, force: true });
    } catch {}
}

function closeJobs() {
    for (const job of jobs.values()) closeJob(job);
    jobs.clear();
}

function failJob(job, message) {
    job.status = 'error';
    job.error = message || 'Pairing failed';
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

async function finishJob(job) {
    if (job.status === 'connected') return;
    job.status = 'packing';
    try {
        await delay(2000); // let creds.json settle before packing
        if (!fs.existsSync(path.join(job.dir, 'creds.json'))) throw new Error('creds.json missing after pairing');
        job.sessionId = packSession(job.dir);
        job.status = 'connected';
    } catch (err) {
        job.status = 'error';
        job.error = err.message;
    } finally {
        closeJob(job);
    }
}

async function runPairing(job) {
    try {
        const { pino, baileys } = getDeps();
        const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } = baileys;

        let version;
        try {
            ({ version } = await fetchLatestBaileysVersion());
        } catch {}

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
        });

        await delay(1500); // the socket needs a moment before requesting the code
        const raw = await sock.requestPairingCode(job.number);
        if (!raw) throw new Error('WhatsApp did not return a pairing code');
        job.code = raw.match(/.{1,4}/g)?.join('-') || raw;
        job.status = 'code';
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
        status: 'pending',
        code: null,
        sessionId: null,
        error: null,
        socket: null,
        createdAt: Date.now()
    };
    jobs.set(id, job);

    const ttl = setTimeout(() => {
        if (job.status !== 'connected') failJob(job, 'Timed out — the code was not used in time');
        job.sessionId = null; // keep the creds out of memory after the TTL
        jobs.delete(id);
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
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml'
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

function readBody(req, limit = 2048) {
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
        status: job.status,
        code: job.status === 'code' ? job.code : null,
        sessionId: job.status === 'connected' ? job.sessionId : null,
        error: job.status === 'error' ? job.error : null
    };
}

/**
 * Handle a pairing-site request. Returns true when the request was answered,
 * false when the caller should fall through to its own routes (e.g. /health).
 */
async function handleRequest(req, res, botName = 'Lily MD') {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const route = url.pathname;

    try {
        if (req.method === 'GET' && (route === '/' || route === '/index.html')) {
            sendFile(res, path.join(PUBLIC_DIR, 'index.html'));
            return true;
        }

        if (req.method === 'GET' && route.startsWith('/assets/')) {
            sendFile(res, path.join(ASSETS_DIR, path.basename(route)));
            return true;
        }

        if (req.method === 'POST' && route === '/api/pair') {
            const available = getDeps();
            if (!available) {
                sendJson(res, 503, { error: 'Pairing is not available on this server yet — run npm install first.' });
                return true;
            }

            const ip = req.socket.remoteAddress || 'unknown';
            if (rateLimited(ip)) {
                sendJson(res, 429, { error: 'Too many pairing attempts. Please try again later.' });
                return true;
            }
            if (activeJobs() >= MAX_ACTIVE_JOBS) {
                sendJson(res, 503, { error: 'Busy right now — please try again in a minute.' });
                return true;
            }

            let payload = {};
            try {
                payload = JSON.parse((await readBody(req)) || '{}');
            } catch {
                sendJson(res, 400, { error: 'Invalid request.' });
                return true;
            }

            const digits = String(payload.number || '').replace(/[^0-9]/g, '');
            if (digits.length < 7 || digits.length > 15) {
                sendJson(res, 400, { error: 'Enter your full number with country code, digits only.' });
                return true;
            }
            if (!available.PhoneNumber('+' + digits).isValid()) {
                sendJson(res, 400, { error: 'That number does not look valid. Include your country code.' });
                return true;
            }

            sendJson(res, 200, { id: startPairing(digits).id });
            return true;
        }

        if (req.method === 'GET' && route === '/api/status') {
            const job = jobs.get(url.searchParams.get('id') || '');
            if (!job) {
                sendJson(res, 404, { error: 'This pairing session expired. Please start again.' });
                return true;
            }
            sendJson(res, 200, publicJob(job));
            return true;
        }

        if (req.method === 'GET' && route === '/api/info') {
            sendJson(res, 200, { bot: botName, ai: 'AYHA' });
            return true;
        }

        return false;
    } catch (err) {
        console.error('[web] request failed:', err.message);
        if (!res.headersSent) sendJson(res, 500, { error: 'Something went wrong on our side.' });
        return true;
    }
}

module.exports = {
    handleRequest,
    closeJobs,
    PUBLIC_DIR,
    // Exposed so the in-chat `.pair` command can use the same pairing engine
    startPairing,
    getJob: (id) => jobs.get(id) || null
};
