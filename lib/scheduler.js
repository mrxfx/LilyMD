'use strict';
/**
 * Persistent scheduling worker.
 *
 * The MySQL queue is the source of truth: the worker polls due rows, claims one
 * atomically, sends, then records the result. Timers are only a wake-up hint,
 * so a restart or a reconnect simply resumes from the database.
 *
 * Publishing a WhatsApp Status uses Baileys' status broadcast:
 *   sock.sendMessage('status@broadcast', content, { statusJidList, broadcast: true })
 * The library supports text/image/video statuses this way. If the connected
 * socket does not expose sendMessage, the job fails explicitly - it is never
 * reported as published when it was not.
 */
const fs = require('fs');
const path = require('path');
const db = require('./db');
const store = require('./dbSchedules');
const time = require('./scheduleTime');

const MEDIA_ROOT = path.join(__dirname, '..', 'data', 'schedules');
const MEDIA_MAX_BYTES = (Number(process.env.SCHEDULE_MEDIA_MAX_MB) || 16) * 1024 * 1024;
const DEFAULT_TICK_MS = 15000;
const LEASE_MINUTES = 10;

const MIME_ALLOWLIST = {
    image: /^image\/(jpeg|png|webp|gif)$/i,
    video: /^video\/(mp4|3gpp|quicktime|webm)$/i,
    document: /^(application\/pdf|application\/msword|application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document|application\/vnd\.ms-excel|application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet|application\/vnd\.ms-powerpoint|application\/vnd\.openxmlformats-officedocument\.presentationml\.presentation|text\/plain|application\/zip)$/i
};

const PERMANENT_PATTERNS = [
    /ENOENT/i,
    /media (file )?missing/i,
    /unsupported media/i,
    /too large/i,
    /invalid (jid|recipient|target)/i,
    /not[- ]a[- ]?uthorized/i,
    /forbidden/i,
    /no such (contact|group)/i,
    /status publishing (is )?not supported/i
];

let timer = null;
let running = false;
let started = false;
let lastTickAt = null;
let lastResult = null;
let restored = 0;

function isPermanent(error) {
    const text = String(error || '');
    return PERMANENT_PATTERNS.some((pattern) => pattern.test(text));
}

function mediaRootResolved() {
    return path.resolve(MEDIA_ROOT);
}

/** Media may only be read from data/schedules (no traversal, no URLs). */
function resolveMediaPath(mediaPath) {
    const root = mediaRootResolved();
    const resolved = path.resolve(root, String(mediaPath || ''));
    if (!resolved.startsWith(root + path.sep)) throw new Error('Invalid media path');
    return resolved;
}

/** Validate a media file before it is stored or sent. */
function validateMedia(mediaPath, type, mime) {
    const absolute = resolveMediaPath(mediaPath);
    let stat;
    try {
        stat = fs.statSync(absolute);
    } catch (error) {
        return { ok: false, error: 'Media file missing' };
    }
    if (!stat.isFile()) return { ok: false, error: 'Media is not a file' };
    if (stat.size <= 0) return { ok: false, error: 'Media file is empty' };
    if (stat.size > MEDIA_MAX_BYTES) {
        return { ok: false, error: `Media too large (max ${Math.round(MEDIA_MAX_BYTES / 1048576)} MB)` };
    }
    const kind = ['image', 'video', 'document'].includes(type) ? type : null;
    if (!kind) return { ok: false, error: 'Unsupported media type' };
    if (mime && MIME_ALLOWLIST[kind] && !MIME_ALLOWLIST[kind].test(String(mime))) {
        return { ok: false, error: `Unsupported ${kind} format` };
    }
    return { ok: true, absolute, size: stat.size, mime: mime || 'application/octet-stream' };
}

function normaliseTarget(job) {
    const target = String(job.target || '').trim();
    if (!target) throw new Error('Invalid recipient');
    if (job.kind === 'status') return 'status@broadcast';
    if (target === 'status@broadcast') throw new Error('Invalid recipient');
    if (target.endsWith('@g.us') || target.endsWith('@s.whatsapp.net') || target.endsWith('@lid')) return target;
    const digits = target.replace(/[^0-9]/g, '');
    if (digits.length < 7 || digits.length > 16) throw new Error('Invalid recipient');
    return `${digits}@s.whatsapp.net`;
}

function buildContent(job) {
    const content = {};
    if (job.mediaType && job.mediaType !== 'none' && job.mediaPath) {
        const checked = validateMedia(job.mediaPath, job.mediaType, job.mediaMime);
        if (!checked.ok) throw new Error(checked.error);
        const buffer = fs.readFileSync(checked.absolute);
        if (job.mediaType === 'image') content.image = buffer;
        else if (job.mediaType === 'video') content.video = buffer;
        else {
            content.document = buffer;
            content.fileName = path.basename(checked.absolute);
            content.mimetype = checked.mime;
        }
        if (job.body) content.caption = job.body;
        else if (job.mediaType === 'document') content.caption = '';
    } else if (job.body) {
        content.text = job.body;
    } else {
        throw new Error('Nothing to send (no text or media)');
    }
    return content;
}

async function publishStatus(sock, job) {
    if (!sock || typeof sock.sendMessage !== 'function') {
        throw new Error('Status publishing is not supported by the connected library');
    }
    const content = buildContent(job);
    if (!content.text && !content.image && !content.video) {
        throw new Error('Unsupported media for a WhatsApp Status');
    }
    const recipients = String(job.target || '')
        .split(',')
        .map((jid) => jid.trim())
        .filter((jid) => jid && jid !== 'status@broadcast')
        .map((jid) => (jid.includes('@') ? jid : `${jid.replace(/[^0-9]/g, '')}@s.whatsapp.net`));
    await sock.sendMessage('status@broadcast', content, {
        broadcast: true,
        statusJidList: recipients
    });
    return { ok: true };
}

/** Send one claimed job. Returns { ok } or throws. */
async function executeJob(sock, job) {
    const target = normaliseTarget(job);
    if (job.kind === 'status') return publishStatus(sock, job);
    const content = buildContent(job);
    const sendTarget = target === 'status@broadcast' ? target : target;
    await sock.sendMessage(sendTarget, content);
    return { ok: true };
}

async function tick(options = {}) {
    if (running) return { skipped: 'busy' };
    running = true;
    lastTickAt = new Date().toISOString();
    try {
        if (!db.configured()) return { skipped: 'not-configured' };
        const sock = options.sock || (typeof options.getSock === 'function' ? options.getSock() : null);
        const connected = typeof options.isConnected === 'function' ? options.isConnected() : Boolean(sock);
        if (!connected || !sock) {
            // Keep jobs pending; disconnection must not eat attempts.
            return { skipped: 'offline' };
        }
        if (!db.status().connected) {
            const ok = await db.connect();
            if (!ok) return { skipped: 'db-offline' };
        }
        await db.ping().catch(() => {});
        const released = await store.releaseStale(LEASE_MINUTES);
        const jobs = await store.claimDue(5);
        const summary = { claimed: jobs.length, sent: 0, retried: 0, failed: 0, released };
        for (const job of jobs) {
            try {
                await executeJob(sock, job);
                await store.markSent(job);
                summary.sent += 1;
                if (job.recurrence && job.recurrence !== 'none') {
                    const next = time.addRecurrence(job.runAt || new Date(), job.recurrence);
                    if (next) await store.rescheduleRecurring(job, next);
                }
            } catch (error) {
                const message = db.safeError(error);
                const outcome = await store.markFailed(job, message, !isPermanent(message));
                if (outcome === 'retry') summary.retried += 1;
                else summary.failed += 1;
                console.error(`[scheduler] job ${job.publicId} ${outcome || 'failed'}: ${message}`);
            }
        }
        lastResult = summary;
        return summary;
    } catch (error) {
        console.error(`[scheduler] tick failed: ${db.safeError(error)}`);
        return { error: db.safeError(error) };
    } finally {
        running = false;
    }
}

function start(options = {}) {
    if (started) return { started: false, already: true };
    started = true;
    const interval = Math.max(5000, Number(process.env.SCHEDULE_TICK_MS) || DEFAULT_TICK_MS);
    const run = () => tick(options).catch(() => {});
    // Wait for the socket/DB to settle, then poll.
    setTimeout(run, 5000);
    timer = setInterval(run, interval);
    if (timer.unref) timer.unref();
    (async () => {
        try {
            if (db.configured() && (await db.connect())) {
                restored = await store.releaseStale(LEASE_MINUTES);
                if (restored) console.log(`[scheduler] restored ${restored} interrupted job(s)`);
            }
        } catch (error) {
            // the periodic tick will retry
        }
    })();
    console.log(`[scheduler] worker started (every ${Math.round(interval / 1000)}s, timezone ${time.timezone()})`);
    return { started: true };
}

function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    started = false;
    return true;
}

function state() {
    return {
        started,
        running,
        intervalMs: Math.max(5000, Number(process.env.SCHEDULE_TICK_MS) || DEFAULT_TICK_MS),
        timezone: time.timezone(),
        lastTickAt,
        lastResult,
        restored
    };
}

module.exports = {
    MEDIA_ROOT,
    MEDIA_MAX_BYTES,
    MIME_ALLOWLIST,
    tick,
    start,
    // alias kept so older callers using startScheduler keep working
    startScheduler: start,
    stop,
    state,
    executeJob,
    publishStatus,
    buildContent,
    validateMedia,
    resolveMediaPath,
    normaliseTarget,
    isPermanent
};
