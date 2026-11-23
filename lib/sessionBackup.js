'use strict';
/**
 * Lily MD — permanent WhatsApp session system.
 *
 * One engine, three jobs:
 *   restore  -> a base64 tar.gz from session.card (or SESSION_ID env) is unpacked into
 *               ./session before Baileys is initialised, so a wiped container can reconnect
 *               without a new QR code or pairing code.
 *   backup   -> ./session is packed into session.card (gitignored, 0600) on every
 *               credential change (debounced) and periodically as a safety net.
 *   deliver  -> preserves secure local backup and sends confirmation without leaking credentials.
 *
 * Security notes:
 *   - SESSION_ID values, creds and archive contents are never logged.
 *   - Archives are validated (gzip magic, entry names, creds.json present) before
 *     anything is extracted, and extraction happens in an isolated temporary
 *     directory that is only moved into place after validation.
 *   - An existing *valid* local session is never overwritten.
 *   - Atomic file writes are used (temp file + rename) to avoid corrupt backups.
 *   - Backups are private and excluded from Git commits via .gitignore.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const BACKUP_FILE_NAME = 'session.card';
const DEFAULT_INTERVAL_MS = 0; // Periodic session card resend disabled
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
        : path.join(process.cwd(), 'session.card');
}

const SESSION_ID_PLACEHOLDERS = new Set([
    'PASTE_LILY_MD_SESSION_HERE',
    'PASTE_YOUR_SESSION_HERE',
    'PASTE_YOUR_SESSION_CARD_HERE',
    'YOUR_SESSION_ID_HERE',
    'LILYMD~DEMO_SESSION_CARD_PLACEHOLDER',
    'LILYMD~DEMO_PLACEHOLDER_ONLY',
    'LILYMD~EXAMPLE_SESSION_CARD',
    'DEMO_SESSION_CARD_PLACEHOLDER'
]);

function isPlaceholder(value) {
    if (!value || typeof value !== 'string') return false;
    const upper = value.replace(/\s+/g, '').toUpperCase();
    if (SESSION_ID_PLACEHOLDERS.has(upper)) return true;
    return upper.includes('DEMO_SESSION_CARD') ||
        upper.includes('PASTE_YOUR_SESSION') ||
        upper.includes('PASTE_LILY_MD') ||
        upper.includes('DEMO_PLACEHOLDER');
}

function ensureSessionCardTemplate(file = backupFile()) {
    try {
        if (!fs.existsSync(file)) {
            const example = `${file}.example`;
            if (fs.existsSync(example)) {
                fs.copyFileSync(example, file);
                chmodQuiet(file, 0o600);
            }
        }
    } catch {}
}

const SESSION_REF_PREFIX = 'LilyMD~';
const SESSION_REF_CHARS = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const sessionRefCache = new Map();
let currentSessionId = null;
const deliveredPairingSessions = new Set();

/** Fetch remote session archive from central website if configured. */
function fetchRemoteSessionRef(ref) {
    if (!ref || typeof ref !== 'string') return null;
    let baseUrl = process.env.WEBSITE_URL;
    if (!baseUrl) {
        try {
            const settings = require('../settings');
            baseUrl = settings.websiteUrl;
        } catch {}
    }
    if (!baseUrl || !baseUrl.startsWith('http')) return null;
    try {
        const endpoint = `${baseUrl.replace(/\/+$/, '')}/api/pair/resolve-session`;
        const script = `
            const http = require(${JSON.stringify(endpoint.startsWith('https') ? 'https' : 'http')});
            const data = JSON.stringify({ ref: ${JSON.stringify(ref)} });
            const url = new URL(${JSON.stringify(endpoint)});
            const req = http.request(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(data)
                },
                timeout: 4000
            }, (res) => {
                let body = '';
                res.on('data', c => body += c);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(body);
                        if (json && json.ok && json.archive) process.stdout.write(json.archive);
                    } catch {}
                });
            });
            req.on('error', () => {});
            req.write(data);
            req.end();
        `;
        const res = spawnSync(process.execPath, ['-e', script], { timeout: 5000, encoding: 'utf8' });
        const archive = (res.stdout || '').trim();
        if (archive && /^[A-Za-z0-9+/=_-]+$/.test(archive)) {
            return archive;
        }
    } catch {}
    return null;
}

/** Committed fallback file for hosts without a panel environment editor. */
function sessionIdFile() {
    return process.env.SESSION_ID_FILE
        ? path.resolve(process.env.SESSION_ID_FILE)
        : path.join(process.cwd(), 'SESSION_ID.txt');
}

function sessionsFile() {
    return path.join(process.cwd(), 'data', 'sessions.json');
}

function readSessionStore() {
    try {
        const file = sessionsFile();
        if (!fs.existsSync(file)) return {};
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function writeSessionStore(data) {
    try {
        const file = sessionsFile();
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const temp = `${file}.tmp-${process.pid}`;
        fs.writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
        fs.renameSync(temp, file);
        chmodQuiet(file, 0o600);
        return true;
    } catch {
        return false;
    }
}

/**
 * Check if a string is a 15-character custom session reference with LilyMD~ prefix.
 * e.g. LilyMD~A7K9Q2M8X4P6R3T (prefix LilyMD~ + exactly 15 alphanumeric characters)
 */
function isSessionRef(str) {
    if (typeof str !== 'string') return false;
    const trimmed = str.trim().replace(/^["']+|["']+$/g, '');
    return /^LilyM[dD]~[A-Za-z0-9]{15}$/.test(trimmed);
}

/**
 * Generate a shorter, cryptographically secure custom pairing reference.
 * Format: LilyMD~<15-character-random-code> (e.g. LilyMD~A7K9Q2M8X4P6R3T)
 */
function generateSessionId() {
    const bytes = crypto.randomBytes(15);
    let randomPart = '';
    for (let i = 0; i < 15; i++) {
        randomPart += SESSION_REF_CHARS[bytes[i] % SESSION_REF_CHARS.length];
    }
    return `${SESSION_REF_PREFIX}${randomPart}`;
}

function generatePairingCode() {
    return generateSessionId();
}

/**
 * Save session reference mapping to store, memory cache and database.
 */
function saveSessionRef(sessionId, archive, number = null) {
    if (!sessionId || !archive) return false;
    sessionRefCache.set(sessionId, archive);
    const store = readSessionStore();
    store[sessionId] = {
        archive,
        number: number ? String(number).replace(/[^0-9]/g, '') : null,
        updatedAt: new Date().toISOString()
    };
    store.__latest = sessionId;
    writeSessionStore(store);

    // Save fallback sidecar archive
    try {
        const archiveFile = `${backupFile()}.archive`;
        fs.writeFileSync(archiveFile, archive, { mode: 0o600 });
    } catch {}

    // Also persist to MySQL if configured
    try {
        const db = require('./db');
        if (db && typeof db.configured === 'function' && db.configured()) {
            db.query(
                'INSERT INTO bot_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = ?',
                [`session_ref:${sessionId}`, archive, archive]
            ).catch(() => {});
            db.query(
                'INSERT INTO bot_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = ?',
                ['active_session_id', sessionId, sessionId]
            ).catch(() => {});
        }
    } catch {}
    return true;
}

/**
 * Resolve session reference to full base64 archive if applicable.
 */
function resolveSessionArchive(raw) {
    if (!raw) return '';
    const trimmed = String(raw).trim().replace(/^["']+|["']+$/g, '');
    if (isSessionRef(trimmed)) {
        if (sessionRefCache.has(trimmed)) {
            return sessionRefCache.get(trimmed);
        }
        const store = readSessionStore();
        if (store[trimmed] && store[trimmed].archive) {
            sessionRefCache.set(trimmed, store[trimmed].archive);
            return store[trimmed].archive;
        }
        if (store.__latest && store[store.__latest] && store[store.__latest].archive) {
            sessionRefCache.set(trimmed, store[store.__latest].archive);
            return store[store.__latest].archive;
        }
        const storeKeys = Object.keys(store).filter((k) => k !== '__latest' && store[k] && store[k].archive);
        if (storeKeys.length === 1 && store[storeKeys[0]]?.archive) {
            sessionRefCache.set(trimmed, store[storeKeys[0]].archive);
            return store[storeKeys[0]].archive;
        }
        const archiveFile = `${backupFile()}.archive`;
        if (fs.existsSync(archiveFile)) {
            try {
                const arc = fs.readFileSync(archiveFile, 'utf8').trim();
                if (arc) {
                    sessionRefCache.set(trimmed, arc);
                    return arc;
                }
            } catch {}
        }
        // Attempt remote lookup from central website if configured
        const remoteArc = fetchRemoteSessionRef(trimmed);
        if (remoteArc) {
            sessionRefCache.set(trimmed, remoteArc);
            saveSessionRef(trimmed, remoteArc);
            return remoteArc;
        }
    }
    return raw;
}

/**
 * Read session.card file. Extracts the archive string whether stored as
 * minimal session ID, plain base64, JSON container, or structured card.
 */
function readSessionCardFile(file = backupFile()) {
    try {
        ensureSessionCardTemplate(file);
        if (!fs.existsSync(file)) return { value: '', status: 'missing', file };
        const rawContent = fs.readFileSync(file, 'utf8');
        // Filter out comments
        const lines = rawContent.split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line && !line.startsWith('#') && !line.startsWith('//'));
        const raw = lines.join('\n').trim().replace(/^["']+|["']+$/g, '');
        if (!raw) return { value: '', status: 'empty', file };

        if (isPlaceholder(raw)) {
            return { value: '', status: 'placeholder', file, raw };
        }

        // Detect if first line is a session reference
        const firstLine = lines[0]?.trim().replace(/^["']+|["']+$/g, '') || '';
        const detectedRef = isSessionRef(firstLine) ? firstLine : (isSessionRef(raw) ? raw : null);

        let archive = raw;
        if (raw.startsWith('{')) {
            try {
                const parsed = JSON.parse(raw);
                archive = parsed.archive || parsed.session || parsed.sessionId || parsed.data || raw;
            } catch {}
        } else if (raw.includes('------------------------------------------------------------')) {
            const parts = raw.split('------------------------------------------------------------');
            archive = parts[parts.length - 1].trim();
        }

        let resolved = resolveSessionArchive(archive);
        if (resolved.startsWith('{')) {
            try {
                const parsed = JSON.parse(resolved);
                resolved = parsed.archive || parsed.session || parsed.sessionId || parsed.data || resolved;
                resolved = resolveSessionArchive(resolved);
            } catch {}
        }

        if (isSessionRef(raw) || isSessionRef(archive)) {
            if (resolved && resolved !== raw && resolved !== archive && !isSessionRef(resolved)) {
                const normalised = normaliseSessionId(resolved);
                if (normalised && /^[A-Za-z0-9+/=_-]+$/.test(normalised)) {
                    return { value: normalised, status: 'present', file, sessionId: detectedRef || raw };
                }
            }
            return { value: '', status: 'invalid', file, raw, sessionId: detectedRef || raw };
        }

        const normalised = normaliseSessionId(resolved);
        if (!normalised) return { value: '', status: 'empty', file };
        if (!/^[A-Za-z0-9+/=_-]+$/.test(normalised)) {
            return { value: '', status: 'invalid', file, raw };
        }
        return { value: normalised, status: 'present', file, sessionId: detectedRef };
    } catch (error) {
        return { value: '', status: 'unreadable', file, error: error.message };
    }
}

/**
 * Read SESSION_ID.txt (legacy fallback).
 */
function readSessionIdFile(file = sessionIdFile()) {
    try {
        if (!fs.existsSync(file)) return { value: '', status: 'missing', file };
        const trimmed = fs.readFileSync(file, 'utf8').trim();
        if (!trimmed) return { value: '', status: 'empty', file };
        if (isPlaceholder(trimmed)) {
            return { value: '', status: 'placeholder', file };
        }
        return { value: trimmed, status: 'present', file };
    } catch (error) {
        return { value: '', status: 'unreadable', file, error: error.message };
    }
}

/**
 * Sources:
 * 1. SESSION_ID environment variable (Render / Heroku / panel envs)
 * 2. session.card file (central user-editable file at project root)
 * 3. SESSION_ID.txt file (legacy fallback only if session.card is not configured)
 */
function sessionIdSource() {
    // 1. Environment variable
    const rawEnv = process.env.SESSION_ID;
    if (rawEnv && !isPlaceholder(rawEnv)) {
        const resolvedEnv = resolveSessionArchive(rawEnv);
        const fromEnv = normaliseSessionId(resolvedEnv);
        if (fromEnv) return { value: fromEnv, source: 'env' };
    }

    // Explicit SESSION_ID_FILE set by host
    const isExplicitFile = Boolean(process.env.SESSION_ID_FILE);
    if (isExplicitFile) {
        const fromExplicit = readSessionIdFile();
        if (fromExplicit.value) {
            const resolved = resolveSessionArchive(fromExplicit.value);
            if (resolved) return { value: normaliseSessionId(resolved), source: 'file', file: fromExplicit.file };
        }
        if (fromExplicit.status === 'placeholder') {
            return { value: '', source: 'none', file: fromExplicit.file, fileStatus: 'placeholder' };
        }
        return { value: fromExplicit.value || '', source: 'file', file: fromExplicit.file, fileStatus: fromExplicit.status };
    }

    // 2. Primary: session.card file at project root
    const fromCard = readSessionCardFile();
    if (fromCard.status === 'present' && fromCard.value) {
        return { value: fromCard.value, source: 'card', file: fromCard.file, sessionId: fromCard.sessionId };
    }

    // If session.card has an invalid or placeholder status, preserve that
    if (fromCard.status === 'invalid') {
        return { value: '', source: 'none', file: fromCard.file, fileStatus: 'invalid', fileType: 'card', raw: fromCard.raw };
    }
    if (fromCard.status === 'placeholder') {
        return { value: '', source: 'none', file: fromCard.file, fileStatus: 'placeholder', fileType: 'card' };
    }

    // 3. Legacy fallback: check SESSION_ID.txt only if it contains a non-placeholder value
    const fromLegacy = readSessionIdFile();
    if (fromLegacy.value && fromLegacy.status === 'present' && !isPlaceholder(fromLegacy.value)) {
        const resolvedLegacy = resolveSessionArchive(fromLegacy.value);
        if (resolvedLegacy && !isPlaceholder(resolvedLegacy)) {
            const norm = normaliseSessionId(resolvedLegacy);
            if (norm) return { value: norm, source: 'file', file: fromLegacy.file };
        }
    }

    return { value: '', source: 'none', file: fromCard.file, fileStatus: fromCard.status || 'none', fileType: 'card' };
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
        if (!fs.existsSync(file)) return null;
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

/** Normalise a SESSION_ID value: data: prefix, quotes, newlines, JSON-wrapping and spaces. */
function normaliseSessionId(raw) {
    let value = String(raw == null ? '' : raw).trim();
    if (!value) return '';
    if (value.startsWith('{')) {
        try {
            const parsed = JSON.parse(value);
            value = String(parsed.archive || parsed.session || parsed.sessionId || parsed.data || value).trim();
        } catch {}
    } else if (value.includes('------------------------------------------------------------')) {
        const parts = value.split('------------------------------------------------------------');
        value = parts[parts.length - 1].trim();
    }
    value = value.replace(/^data:[^,]*,/i, '');
    value = value.replace(/^["']+/, '').replace(/["']+$/, '');
    return value.replace(/\s+/g, '');
}

/** Decode and screen a session archive before any filesystem work. */
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
 * Restore session into the session directory before Baileys starts.
 * Never overwrites a valid local session.
 * Does not delete existing session directory until the new backup is verified.
 *
 * @returns {{ restored: boolean, reason: string, files?: number, source?: string }}
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
        if (source.fileStatus === 'invalid') {
            lastRestore = {
                restored: false,
                reason: 'invalid',
                source: source.file ? path.basename(source.file) : 'session.card',
                at: new Date().toISOString()
            };
            log.log('⚠️ The session card is invalid or unmapped. Pairing required.');
            return lastRestore;
        }

        lastRestore = {
            restored: false,
            reason: 'missing',
            source: source.fileStatus || 'none',
            at: new Date().toISOString()
        };
        if (source.fileStatus === 'placeholder') {
            log.log([
                '╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮',
                '┃  ⚠️  LILY MD — SESSION SETUP REQUIRED                  ┃',
                '╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯',
                ' session.card still contains the demo placeholder!',
                '',
                ' 👉 How to connect your WhatsApp:',
                ' 1. Open the website pairing page:',
                `    ${process.env.WEBSITE_URL || 'https://lilymd.onrender.com'} (or local web dashboard)`,
                ' 2. Enter your phone number and link with your WhatsApp.',
                ' 3. You will receive a "session.card" in your WhatsApp chat.',
                ' 4. Open "session.card" in the project root, paste your card',
                '    replacing the demo placeholder, and restart: npm start',
                '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
            ].join('\n'));
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

        // Verified! Now safely replace existing invalid directory if any.
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
        const sourceLabel = source.source === 'card'
            ? path.basename(source.file || 'session.card')
            : (source.source === 'file' ? 'SESSION_ID.txt' : 'SESSION_ID');

        lastRestore = {
            restored: true,
            reason: 'restored',
            files,
            source: sourceLabel,
            at: new Date().toISOString()
        };
        log.log(`🔐 Session restored successfully from ${sourceLabel}`);
        return lastRestore;
    } catch (error) {
        if (tempDir) {
            try {
                fs.rmSync(tempDir, { recursive: true, force: true });
            } catch {}
        }
        log.error(`⚠️ Session could not be restored: ${error.message}`);
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
    const buf = result.stdout;
    // Zero gzip timestamp (bytes 4-7) for deterministic archive hashing across seconds
    if (buf.length > 7 && buf[0] === 0x1f && buf[1] === 0x8b) {
        buf[4] = 0;
        buf[5] = 0;
        buf[6] = 0;
        buf[7] = 0;
    }
    return buf.toString('base64');
}

function readFileQuiet(file) {
    try {
        return fs.readFileSync(file, 'utf8').trim();
    } catch {
        return null;
    }
}

/**
 * Refresh session.card backup file.
 * Uses atomic file writes (.tmp file + rename), keeps 0600 permissions,
 * and verifies backup before completing.
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
            return { ok: true, changed: false, hash, bytes: fs.statSync(file).size, file: path.basename(file) };
        }

        const sessionId = options.customCode || generateSessionId();
        currentSessionId = sessionId;

        saveSessionRef(sessionId, archive);

        // Minimal session card format: ONLY LilyMD~XXXXXXXXXXXXXXXXX
        const cardContent = sessionId;

        // Atomic write to temporary file
        const temp = `${file}.tmp-${process.pid}`;
        fs.writeFileSync(temp, cardContent, { mode: 0o600 });
        if (!fs.existsSync(temp) || fs.statSync(temp).size === 0) {
            throw new Error('Atomic backup write verification failed.');
        }

        // Atomically replace target file
        fs.renameSync(temp, file);
        chmodQuiet(file, 0o600);

        const hashFile = `${file}.hash`;
        fs.writeFileSync(hashFile, hash, { mode: 0o600 });
        chmodQuiet(hashFile, 0o600);

        lastBackupHash = hash;
        return { ok: true, changed: true, hash, bytes: Buffer.byteLength(cardContent), file: path.basename(file), sessionId };
    } catch (error) {
        return { ok: false, reason: 'error', error: error.message };
    }
}

/* ------------------------------------------------------------------- deliver */

function backupDocument(archive) {
    return [
        '🔐 LILY MD — WHATSAPP SESSION CARD',
        '',
        'Keep this file private. Anyone who has it can use this WhatsApp account.',
        '',
        'HOW TO RESTORE ON A NEW SERVER',
        '1. Place this file as session.card in your project root, OR',
        '2. Open this file and paste the archive string below into the SESSION_ID environment variable.',
        '3. Restart the bot. It restores this session and connects without a QR or pairing code.',
        '',
        `Created: ${new Date().toISOString()}`,
        `Length: ${String(archive).length} characters`,
        '------------------------------------------------------------',
        archive
    ].join('\n');
}

/** The bot's own JID — the only recipient a session backup document is ever sent to. */
function selfJid(sock) {
    const raw = sock && sock.user && sock.user.id;
    if (!raw) return null;
    const digits = String(raw).split(':')[0].split('@')[0].replace(/[^0-9]/g, '');
    if (!digits) return null;
    return `${digits}@s.whatsapp.net`;
}

/**
 * Shared message builder for successful pairing confirmation.
 * Used by both website-based and server-based pairing flows to guarantee identical formatting.
 */
function buildPairingSuccessCaption(data = {}) {
    let settings = {};
    try { settings = require('../settings'); } catch {}
    const version = data.version || settings.version || '3.0.8';
    const digits = String(data.number || data.account || '').replace(/[^0-9]/g, '');
    const formattedNumber = `+${digits}`;

    const detectedPlatform = process.env.RENDER
        ? 'Render'
        : (process.platform === 'linux'
            ? 'Linux'
            : (process.platform === 'win32'
                ? 'Windows'
                : (process.platform === 'darwin' ? 'macOS' : 'Server')));
    const platformName = data.platform || process.env.PLATFORM || detectedPlatform;

    const lines = [
        '╭━━━〔 LILY MD 〕━━━╮',
        '┃',
        '┃  PAIRING SUCCESSFUL',
        '┃',
        `┃  Version      : ${version}`,
        `┃  Platform     : ${platformName}`,
        `┃  Account      : ${formattedNumber}`,
        '┃  Pair Status  : Connected',
        '┃',
        '╰━━━━━━━━━━━━━━━━╯',
        '',
        'Your Lily MD session is ready.',
        '',
        'Session card is attached separately.'
    ];

    if (data.tempPassword) {
        lines.push('', `🔐 *Dashboard Password:* \`${data.tempPassword}\``);
    }

    return lines.join('\n');
}

/**
 * Send the premium pairing completion confirmation message and minimal session card.
 * Shared between website-based and server-based pairing flows.
 *
 * Sequence:
 * 1. Ensure a valid Dashboard Password is provisioned (via webAuth) if not already provided.
 * 2. Send pairing-complete confirmation with Lily logo and identical structured caption.
 * 3. Send the minimal session card attachment (containing ONLY LilyMD~XXXXXXXXXXXXXXX).
 *
 * Deduplicated: won't send duplicates for the same pairing session.
 */
async function deliverPairingSuccess(sock, targetNumber, details = {}) {
    if (!sock || typeof sock.sendMessage !== 'function') return { ok: false, reason: 'offline' };
    const digits = String(targetNumber || '').replace(/[^0-9]/g, '');
    if (!digits) return { ok: false, reason: 'invalid-number' };
    const jid = `${digits}@s.whatsapp.net`;

    const dedupKey = `${digits}:${details.customCode || details.sessionId || 'active'}`;
    if (deliveredPairingSessions.has(dedupKey)) {
        return { ok: true, skipped: 'already-delivered' };
    }
    deliveredPairingSessions.add(dedupKey);

    const sessionId = details.customCode || details.sessionId || currentSessionId || generateSessionId();
    currentSessionId = sessionId;

    // Unified Dashboard Password provisioning: if not provided, provision via shared webAuth
    let tempPassword = details.tempPassword || null;
    if (!tempPassword) {
        try {
            const auth = require('./webAuth');
            if (typeof auth.provisionOwnerAccount === 'function') {
                const provisionResult = auth.provisionOwnerAccount(digits, { allowPaired: true });
                if (provisionResult && provisionResult.tempPassword) {
                    tempPassword = provisionResult.tempPassword;
                }
            }
        } catch {}
    }

    let settings = {};
    try { settings = require('../settings'); } catch {}
    const version = settings.version || '3.0.8';

    const detectedPlatform = process.env.RENDER
        ? 'Render'
        : (process.platform === 'linux'
            ? 'Linux'
            : (process.platform === 'win32'
                ? 'Windows'
                : (process.platform === 'darwin' ? 'macOS' : 'Server')));
    const platformName = details.platform || process.env.PLATFORM || detectedPlatform;

    // 1. Lily MD logo image
    let logoBuffer = null;
    const possibleLogoPaths = [
        path.join(process.cwd(), 'assets', 'logo.png'),
        path.join(process.cwd(), 'assets', 'bot_image.jpg'),
        path.join(process.cwd(), 'assets', 'bot_image.png')
    ];
    for (const p of possibleLogoPaths) {
        if (fs.existsSync(p)) {
            try {
                logoBuffer = fs.readFileSync(p);
                break;
            } catch {}
        }
    }

    const caption = buildPairingSuccessCaption({
        number: digits,
        version,
        platform: platformName,
        tempPassword
    });

    try {
        // Send Message 1: Pairing complete confirmation with Lily logo
        if (logoBuffer) {
            await sock.sendMessage(jid, {
                image: logoBuffer,
                caption,
                mimetype: 'image/png'
            });
        } else {
            await sock.sendMessage(jid, {
                text: caption
            });
        }

        // Send Message 2: Minimal session card attachment containing ONLY LilyMD~XXXXXXXXXXXXXXXXX
        await sock.sendMessage(jid, {
            document: Buffer.from(sessionId, 'utf8'),
            mimetype: 'text/plain',
            fileName: 'session.card'
        });

        console.log(`✨ Pairing confirmation & session card (${sessionId}) delivered to ${digits}`);
        return { ok: true, delivered: true, sessionId, tempPassword, caption };
    } catch (err) {
        console.error(`[pair] delivery failed for ${digits}:`, err.message || err);
        return { ok: false, reason: 'delivery-failed', error: err.message || String(err) };
    }
}

/**
 * Deliver session backup document to the bot's own self-chat only (never ordinary chats).
 * In the new architecture, sends the minimal session card attachment without raw archive dump.
 */
async function sendSessionBackup(sock, options = {}) {
    if (!sock || typeof sock.sendMessage !== 'function') return { ok: false, reason: 'offline' };
    const jid = selfJid(sock);
    if (!jid) return { ok: false, reason: 'unknown-owner' };

    const file = options.file || backupFile();
    let cardContent = readFileQuiet(file);
    if (!cardContent) {
        const sessionId = currentSessionId || generateSessionId();
        cardContent = sessionId;
    } else if (!isSessionRef(cardContent)) {
        // If file contains raw archive or legacy format, obtain sessionId
        const sessionId = currentSessionId || generateSessionId();
        saveSessionRef(sessionId, cardContent);
        cardContent = sessionId;
    }

    const hash = hashOf(cardContent);
    if (!options.force && lastSentHash === hash) return { ok: true, skipped: 'unchanged' };

    const docName = process.env.SESSION_BACKUP_NAME || (options.file ? path.basename(options.file) : BACKUP_FILE_NAME);

    try {
        await sock.sendMessage(jid, {
            document: Buffer.from(cardContent, 'utf8'),
            mimetype: 'text/plain',
            fileName: docName,
            caption: '🔐 Lily MD session card'
        });
        lastSentHash = hash;
        lastSentAt = new Date().toISOString();
        lastSendError = null;
        console.log(`💾 Session card delivered to ${jid.split('@')[0]}`);
        return { ok: true, changed: true, hash, sessionId: cardContent };
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

function onCredentialsUpdated(options = {}) {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
        debounceTimer = null;
        const result = writeSessionBackup();
        if (result.ok && result.changed) {
            console.log(`💾 Local session backup updated (${result.file || 'session.card'})`);
        }
    }, debounceMs());
    if (debounceTimer.unref) debounceTimer.unref();
    return true;
}

async function flushSessionBackup(options = {}) {
    if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
    }
    const result = writeSessionBackup({ force: options.force === true });
    if (!result.ok) return result;
    if (options.deliver && (options.sock || typeof options.getSock === 'function')) {
        const sock = options.sock || (typeof options.getSock === 'function' ? options.getSock() : null);
        if (sock) {
            return { ...result, delivery: await sendSessionBackup(sock, { getSock: options.getSock }) };
        }
    }
    return result;
}

function startBackups(options = {}) {
    let result = { ok: false, reason: 'no-session' };
    try {
        result = writeSessionBackup({ force: options.force === true });
    } catch (error) {
        result = { ok: false, reason: 'error', error: error.message };
    }
    if (!result.ok && result.reason === 'error') {
        console.error(`[session] backup failed: ${result.error}`);
    } else if (result.ok && result.changed) {
        console.log(`💾 Session backup refreshed (${result.file || 'session.card'})`);
    }

    if (!started) {
        started = true;
        console.log('[session] backup worker initialized (periodic card resend disabled; card delivered once on fresh pairing)');
    }

    // Do NOT send session card periodically or on startup/reconnect!
    // Session cards are delivered ONLY once after fresh pairing completes.
    return result;
}

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
    ensureSessionCardTemplate,
    isPlaceholder,
    readSessionIdFile,
    readSessionCardFile,
    sessionIdSource,
    generatePairingCode,
    generateSessionId,
    isSessionRef,
    saveSessionRef,
    resolveSessionArchive,
    buildPairingSuccessCaption,
    deliverPairingSuccess,
    sessionsFile,
    readSessionStore,
    writeSessionStore,
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
