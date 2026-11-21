'use strict';
/**
 * Lily MD — permanent WhatsApp session system.
 *
 * One engine, three jobs:
 *   restore  -> a base64 tar.gz in SESSION_ID is unpacked into ./session before
 *               Baileys is initialised, so a wiped container can reconnect
 *               without a new QR code or pairing code.
 *   backup   -> ./session is packed into session-backup.txt (gitignored) on every
 *               credential change (debounced) and periodically as a safety net.
 *   deliver  -> the packed archive is sent as LILY-MD-SESSION.txt to the bot's
 *               own WhatsApp chat, so the owner always holds a restorable copy.
 *
 * The archive format is unchanged (system `tar` gzip, base64) so backups made by
 * earlier Lily MD versions still restore.
 *
 * Security notes:
 *   - SESSION_ID values, creds and archive contents are never logged.
 *   - Archives are validated (gzip magic, entry names, creds.json present) before
 *     anything is extracted, and extraction happens in an isolated temporary
 *     directory that is only moved into place after validation.
 *   - An existing *valid* local session is never overwritten.
 *   - The backup document is only ever sent to the bot's own account.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const BACKUP_FILE_NAME = 'LILY-MD-SESSION.txt';
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const DEFAULT_DEBOUNCE_MS = 20000;
const DEFAULT_SEND_RETRY_MS = 10 * 60 * 1000;
const MAX_BUFFER = 64 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MAX_CREDS_BYTES = 4 * 1024 * 1024;

let started = false;
let intervalTimer = null;
let debounceTimer = null;
let retryTimer = null;
let lastBackupHash = null;
let lastSentHash = null;
let lastSentAt = null;
let lastSendError = null;
let lastRestore = null;

/* ------------------------------------------------------------------- helpers */

function number(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sessionDir() {
    return process.env.SESSION_DIR
        ? path.resolve(process.env.SESSION_DIR)
        : path.join(process.cwd(), 'session');
}

function backupFile() {
    return process.env.SESSION_BACKUP_FILE
        ? path.resolve(process.env.SESSION_BACKUP_FILE)
        : path.join(process.cwd(), 'session-backup.txt');
}

const SESSION_ID_PLACEHOLDERS = new Set([
    'PASTE_LILY_MD_SESSION_HERE',
    'PASTE_YOUR_SESSION_HERE',
    'YOUR_SESSION_ID_HERE'
]);

/** Committed fallback file for hosts without a panel environment editor. */
function sessionIdFile() {
    return process.env.SESSION_ID_FILE
        ? path.resolve(process.env.SESSION_ID_FILE)
        : path.join(process.cwd(), 'SESSION_ID.txt');
}

/**
 * Read SESSION_ID.txt, which the owner can edit directly on GitHub so a
 * rebuild restores the session without any hosting-panel environment variable.
 * The value itself is never logged.
 *
 * @returns {{ value: string, status: string, file: string, error?: string }}
 */
function readSessionIdFile(file = sessionIdFile()) {
    try {
        if (!fs.existsSync(file)) return { value: '', status: 'missing', file };
        const trimmed = fs.readFileSync(file, 'utf8').trim();
        if (!trimmed) return { value: '', status: 'empty', file };
        if (SESSION_ID_PLACEHOLDERS.has(trimmed.replace(/\s+/g, '').toUpperCase())) {
            return { value: '', status: 'placeholder', file };
        }
        return { value: trimmed, status: 'present', file };
    } catch (error) {
        return { value: '', status: 'unreadable', file, error: error.message };
    }
}

/**
 * One place that decides where a session archive comes from: the SESSION_ID
 * environment variable first, then the committed SESSION_ID.txt file.
 *
 * @returns {{ value: string, source: 'env'|'file'|'none', file?: string, fileStatus?: string }}
 */
function sessionIdSource() {
    const fromEnv = normaliseSessionId(process.env.SESSION_ID);
    if (fromEnv) return { value: fromEnv, source: 'env' };
    const fromFile = readSessionIdFile();
    if (fromFile.value) return { value: fromFile.value, source: 'file', file: fromFile.file };
    return { value: '', source: 'none', file: fromFile.file, fileStatus: fromFile.status };
}

function hashOf(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function chmodQuiet(target, mode) {
    try {
        fs.chmodSync(target, mode);
    } catch {
        // Windows / read-only mounts: permissions are best effort
    }
}

/** Tighten permissions on a session tree (700/600), ignoring unsupported mounts. */
function hardenTree(dir) {
    chmodQuiet(dir, 0o700);
    let entries = [];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) hardenTree(full);
        else chmodQuiet(full, 0o600);
    }
}

/** Parsed creds.json, or null when the session is missing/incomplete/corrupt. */
function readCreds(dir = sessionDir()) {
    try {
        const file = path.join(dir, 'creds.json');
        const stat = fs.statSync(file);
        if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_CREDS_BYTES) return null;
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
        return parsed;
    } catch {
        return null;
    }
}

function hasSession(dir = sessionDir()) {
    return Boolean(readCreds(dir));
}

/* --------------------------------------------------------------- SESSION_ID */

/** Normalise a SESSION_ID value: data: prefix, quotes, newlines and spaces. */
function normaliseSessionId(raw) {
    let value = String(raw == null ? '' : raw).trim();
    if (!value) return '';
    value = value.replace(/^data:[^,]*,/i, '');
    value = value.replace(/^["']+/, '').replace(/["']+$/, '');
    return value.replace(/\s+/g, '');
}

/** Decode and screen a SESSION_ID before any filesystem work. */
function decodeSessionId(raw) {
    const value = normaliseSessionId(raw);
    if (!value) throw new Error('SESSION_ID is empty');
    if (!/^[A-Za-z0-9+/=_-]+$/.test(value)) throw new Error('SESSION_ID is not valid base64');
    const normalised = value.replace(/-/g, '+').replace(/_/g, '/');
    const buffer = Buffer.from(normalised, 'base64');
    if (!buffer.length) throw new Error('SESSION_ID decoded to zero bytes');
    if (buffer.length > MAX_ARCHIVE_BYTES) throw new Error('SESSION_ID is too large');
    if (buffer[0] !== 0x1f || buffer[1] !== 0x8b) throw new Error('SESSION_ID is not a gzip archive');
    return buffer;
}

function listEntries(buffer) {
    const result = spawnSync('tar', ['-tzf', '-'], { input: buffer, maxBuffer: MAX_BUFFER });
    if (result.error) throw new Error(`tar is unavailable (${result.error.message})`);
    if (result.status !== 0) throw new Error('SESSION_ID archive is corrupted');
    return String(result.stdout || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
}

/**
 * Reject absolute paths, Windows drive paths and `..` segments, and require a
 * top-level creds.json. Nothing is extracted before this passes.
 */
function assertSafeEntries(entries) {
    if (!entries.length) throw new Error('SESSION_ID archive is empty');
    let hasCreds = false;
    for (const entry of entries) {
        const name = entry.replace(/\\/g, '/');
        if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
            throw new Error('SESSION_ID archive contains an absolute path');
        }
        const parts = name.split('/').filter((part) => part && part !== '.');
        if (parts.includes('..')) throw new Error('SESSION_ID archive contains a path traversal entry');
        if (parts.length === 1 && parts[0] === 'creds.json') hasCreds = true;
    }
    if (!hasCreds) throw new Error('SESSION_ID archive does not contain creds.json');
    return { entries: entries.length, hasCreds };
}

function unpack(buffer, targetDir) {
    const result = spawnSync('tar', ['-xzf', '-'], {
        cwd: targetDir,
        input: buffer,
        maxBuffer: MAX_BUFFER
    });
    if (result.error) throw new Error(`tar is unavailable (${result.error.message})`);
    if (result.status !== 0) {
        const detail = String(result.stderr || '').trim().split(/\r?\n/)[0];
        throw new Error(`SESSION_ID archive could not be unpacked${detail ? ` (${detail})` : ''}`);
    }
}

/**
 * Restore SESSION_ID into the session directory before Baileys starts.
 * Never overwrites a valid local session.
 *
 * @returns {{ restored: boolean, reason: string, files?: number }}
 */
function restoreSessionFromEnv(options = {}) {
    const dir = options.dir || sessionDir();
    const log = options.log || console;
    const source = sessionIdSource();

    if (hasSession(dir)) {
        lastRestore = { restored: false, reason: 'existing', at: new Date().toISOString() };
        log.log('🔐 Existing local session detected');
        return lastRestore;
    }

    if (!source.value) {
        lastRestore = {
            restored: false,
            reason: 'missing',
            source: source.fileStatus || 'none',
            at: new Date().toISOString()
        };
        if (source.fileStatus === 'placeholder') {
            log.log('⚠️ SESSION_ID.txt still has the placeholder — paste your LILY-MD-SESSION.txt contents into it, or set SESSION_ID.');
        } else {
            log.log('⚠️ No valid saved session found. Pairing required.');
        }
        return lastRestore;
    }

    const sessionId = source.value;

    let tempDir = null;
    try {
        const buffer = decodeSessionId(sessionId);
        assertSafeEntries(listEntries(buffer));

        fs.mkdirSync(path.dirname(dir), { recursive: true });
        tempDir = fs.mkdtempSync(path.join(path.dirname(dir), '.session-restore-'));
        unpack(buffer, tempDir);
        if (!hasSession(tempDir)) throw new Error('archive did not contain a valid creds.json');
        hardenTree(tempDir);

        // Anything left in place is not a valid session (checked above); keep it
        // for inspection instead of deleting credentials outright.
        if (fs.existsSync(dir)) {
            const retired = `${dir}.invalid-${Date.now()}`;
            try {
                fs.renameSync(dir, retired);
            } catch {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        }
        fs.renameSync(tempDir, dir);
        tempDir = null;
        hardenTree(dir);

        const files = fs.readdirSync(dir).length;
        lastRestore = {
            restored: true,
            reason: 'restored',
            files,
            source: source.source === 'file' ? 'SESSION_ID.txt' : 'SESSION_ID',
            at: new Date().toISOString()
        };
        log.log(`🔐 Session restored successfully from ${lastRestore.source}`);
        return lastRestore;
    } catch (error) {
        if (tempDir) {
            try {
                fs.rmSync(tempDir, { recursive: true, force: true });
            } catch {
                // ignore
            }
        }
        // The message describes the failure only; it never includes the value.
        log.error(`⚠️ SESSION_ID could not be restored: ${error.message}`);
        lastRestore = { restored: false, reason: 'invalid', error: error.message, at: new Date().toISOString() };
        return lastRestore;
    }
}

/* -------------------------------------------------------------------- backup */

/** Pack the live session directory into a portable base64 archive. */
function packSession(dir = sessionDir()) {
    if (!hasSession(dir)) throw new Error('No valid session to back up');
    const result = spawnSync('tar', ['-czf', '-', '.'], { cwd: dir, maxBuffer: MAX_BUFFER });
    if (result.error) throw new Error(`tar is unavailable (${result.error.message})`);
    if (result.status !== 0) {
        throw new Error(String(result.stderr || '').trim() || `tar exited with ${result.status}`);
    }
    if (!result.stdout || !result.stdout.length) throw new Error('session archive is empty');
    return result.stdout.toString('base64');
}

function readFileQuiet(file) {
    try {
        return fs.readFileSync(file, 'utf8').trim();
    } catch {
        return null;
    }
}

/**
 * Refresh session-backup.txt. Writes atomically, keeps 0600 permissions and
 * skips the write when the archive content did not change.
 */
function writeSessionBackup(options = {}) {
    const dir = options.dir || sessionDir();
    const file = options.file || backupFile();
    if (!hasSession(dir)) return { ok: false, reason: 'no-session' };

    try {
        const archive = packSession(dir);
        const hash = hashOf(archive);
        const previous = lastBackupHash || readFileQuiet(`${file}.hash`);
        if (!options.force && previous === hash && fs.existsSync(file)) {
            lastBackupHash = hash;
            return { ok: true, changed: false, hash, bytes: fs.statSync(file).size };
        }

        const temp = `${file}.tmp-${process.pid}`;
        fs.writeFileSync(temp, archive, { mode: 0o600 });
        fs.renameSync(temp, file);
        chmodQuiet(file, 0o600);

        const hashFile = `${file}.hash`;
        fs.writeFileSync(hashFile, hash, { mode: 0o600 });
        chmodQuiet(hashFile, 0o600);

        lastBackupHash = hash;
        return { ok: true, changed: true, hash, bytes: Buffer.byteLength(archive) };
    } catch (error) {
        return { ok: false, reason: 'error', error: error.message };
    }
}

/* ------------------------------------------------------------------- deliver */

function backupDocument(archive) {
    return [
        '🔐 LILY MD — WHATSAPP SESSION BACKUP',
        '',
        'Keep this file private. Anyone who has it can use this WhatsApp account.',
        '',
        'HOW TO RESTORE ON A NEW SERVER',
        '1. Open this file and copy everything below the line.',
        '2. Paste it into the SESSION_ID environment variable on your host',
        '   (OptikLink → Startup / Environment Variables).',
        '3. Restart the bot. It restores this session and connects without a',
        '   QR code or a pairing code, as long as WhatsApp still trusts it.',
        '',
        `Created: ${new Date().toISOString()}`,
        `Length: ${String(archive).length} characters`,
        '------------------------------------------------------------',
        archive
    ].join('\n');
}

/** The bot's own JID — the only recipient a session backup is ever sent to. */
function selfJid(sock) {
    const raw = sock && sock.user && sock.user.id;
    if (!raw) return null;
    const digits = String(raw).split(':')[0].split('@')[0].replace(/[^0-9]/g, '');
    if (!digits) return null;
    return `${digits}@s.whatsapp.net`;
}

/**
 * Send session-backup.txt to the bot's own chat as LILY-MD-SESSION.txt.
 * Sends only when the archive changed (or force), never throws, and schedules a
 * retry when WhatsApp rejects the message.
 */
async function sendSessionBackup(sock, options = {}) {
    if (!sock || typeof sock.sendMessage !== 'function') return { ok: false, reason: 'offline' };
    const jid = selfJid(sock);
    if (!jid) return { ok: false, reason: 'unknown-owner' };

    const file = options.file || backupFile();
    let archive = readFileQuiet(file);
    if (!archive) return { ok: false, reason: 'no-backup' };

    const hash = hashOf(archive);
    if (!options.force && lastSentHash === hash) return { ok: true, skipped: 'unchanged' };

    try {
        await sock.sendMessage(jid, {
            document: Buffer.from(backupDocument(archive)),
            mimetype: 'text/plain',
            fileName: BACKUP_FILE_NAME,
            caption:
                '🔐 Lily MD session backup\n' +
                'Keep this file private. Paste its contents into SESSION_ID to restore this session on a new server.'
        });
        lastSentHash = hash;
        lastSentAt = new Date().toISOString();
        lastSendError = null;
        console.log(`💾 Session backup delivered to ${jid.split('@')[0]}`);
        return { ok: true, changed: true, hash };
    } catch (error) {
        lastSendError = error && error.message ? error.message : String(error);
        console.error(`[session] backup delivery failed: ${lastSendError}`);
        scheduleSendRetry(options);
        return { ok: false, reason: 'send-failed', error: lastSendError };
    }
}

function scheduleSendRetry(options = {}) {
    const getSock = typeof options.getSock === 'function' ? options.getSock : null;
    if (!getSock || retryTimer) return false;
    const wait = number(process.env.SESSION_BACKUP_RETRY_MS, DEFAULT_SEND_RETRY_MS);
    retryTimer = setTimeout(() => {
        retryTimer = null;
        const sock = getSock();
        if (!sock) return;
        Promise.resolve(sendSessionBackup(sock, { getSock })).catch(() => {});
    }, wait);
    if (retryTimer.unref) retryTimer.unref();
    return true;
}

/* ----------------------------------------------------------------- lifecycle */

function debounceMs() {
    return number(process.env.SESSION_BACKUP_DEBOUNCE_MS, DEFAULT_DEBOUNCE_MS);
}

function intervalMs() {
    return number(process.env.SESSION_BACKUP_INTERVAL_MS, DEFAULT_INTERVAL_MS);
}

/**
 * Called from `creds.update`: refreshes the file after a short quiet period so
 * key rotation does not trigger a write storm, then re-delivers when the archive
 * actually changed.
 */
function onCredentialsUpdated(options = {}) {
    const getSock = typeof options.getSock === 'function' ? options.getSock : () => null;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
        debounceTimer = null;
        const result = writeSessionBackup();
        if (!result.ok || !result.changed) return;
        const sock = getSock();
        if (!sock) return;
        Promise.resolve(sendSessionBackup(sock, { getSock })).catch(() => {});
    }, debounceMs());
    if (debounceTimer.unref) debounceTimer.unref();
    return true;
}

/** Run the debounced refresh immediately (used on connect and by tests). */
async function flushSessionBackup(options = {}) {
    if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
    }
    const result = writeSessionBackup({ force: options.force === true });
    if (!result.ok) return result;
    const sock = options.sock || (typeof options.getSock === 'function' ? options.getSock() : null);
    if (!sock) return result;
    return { ...result, delivery: await sendSessionBackup(sock, { getSock: options.getSock }) };
}

/**
 * Start the backup engine once: an immediate refresh, a periodic safety backup
 * and (when connected) delivery of the new archive to the owner's own chat.
 */
function startBackups(options = {}) {
    const getSock = typeof options.getSock === 'function' ? options.getSock : () => null;
    let result = { ok: false, reason: 'no-session' };
    try {
        result = writeSessionBackup({ force: options.force === true });
    } catch (error) {
        result = { ok: false, reason: 'error', error: error.message };
    }
    if (!result.ok && result.reason === 'error') {
        console.error(`[session] backup failed: ${result.error}`);
    } else if (result.ok && result.changed) {
        console.log('💾 Session backup refreshed (session-backup.txt)');
    }

    if (!started) {
        started = true;
        intervalTimer = setInterval(() => {
            const refreshed = writeSessionBackup();
            if (!refreshed.ok || !refreshed.changed) return;
            const sock = getSock();
            if (!sock) return;
            Promise.resolve(sendSessionBackup(sock, { getSock })).catch(() => {});
        }, intervalMs());
        if (intervalTimer.unref) intervalTimer.unref();
        console.log(`[session] backup worker started (every ${Math.round(intervalMs() / 3600000)}h)`);
    }

    const sock = getSock();
    if (sock && result.ok) {
        Promise.resolve(sendSessionBackup(sock, { getSock })).catch(() => {});
    }
    return result;
}

/** Compatibility alias for older callers. */
function scheduleSessionBackup(options = {}) {
    return startBackups(options);
}

function stopBackups() {
    if (intervalTimer) clearInterval(intervalTimer);
    if (debounceTimer) clearTimeout(debounceTimer);
    if (retryTimer) clearTimeout(retryTimer);
    intervalTimer = null;
    debounceTimer = null;
    retryTimer = null;
    started = false;
    return true;
}

function state() {
    return {
        started,
        intervalMs: intervalMs(),
        debounceMs: debounceMs(),
        backupFile: backupFile(),
        backupExists: fs.existsSync(backupFile()),
        lastBackupHash: lastBackupHash || null,
        lastSentHash: lastSentHash || null,
        lastSentAt,
        lastSendError,
        lastRestore
    };
}

module.exports = {
    BACKUP_FILE_NAME,
    sessionDir,
    backupFile,
    sessionIdFile,
    readSessionIdFile,
    sessionIdSource,
    hasSession,
    readCreds,
    normaliseSessionId,
    decodeSessionId,
    assertSafeEntries,
    packSession,
    restoreSessionFromEnv,
    writeSessionBackup,
    backupDocument,
    selfJid,
    sendSessionBackup,
    onCredentialsUpdated,
    flushSessionBackup,
    startBackups,
    scheduleSessionBackup,
    stopBackups,
    state
};
