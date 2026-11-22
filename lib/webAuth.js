'use strict';
/**
 * Owner authentication for the Lily MD web platform.
 *
 * Password hashing: scrypt (N=16384, r=8, p=1) with a per-account salt, compared
 * with timingSafeEqual. scrypt ships with Node, so no native build is required.
 * Only hashes are stored; a temporary password exists in memory just long enough
 * to be handed to WhatsApp and is never logged.
 *
 * Sessions: random 32-byte token in an HttpOnly, SameSite=Lax cookie; the server
 * stores only sha256(token). Every session carries its own CSRF token which the
 * dashboard must echo in the X-Lily-CSRF header for state-changing requests.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const store = require('./webStore');
const { ownerNumbers, digits } = require('./ownerNumbers');

const ACCOUNTS_FILE = store.dataPath('webAccounts.json');
const SESSIONS_FILE = store.dataPath('webSessions.json');
const AUDIT_FILE = store.dataPath('webAudit.log');

const SESSION_TTL_MS = Number(process.env.SESSION_TTL_HOURS || 12) * 60 * 60 * 1000;
const COOKIE_NAME = 'lily_session';
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60 * 1000;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

const failures = new Map(); // key -> { count, first, lockedUntil }

/* ------------------------------------------------------------------ crypto */

function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const key = crypto.scryptSync(String(password), salt, SCRYPT.keylen, {
        N: SCRYPT.N,
        r: SCRYPT.r,
        p: SCRYPT.p,
        maxmem: 128 * 1024 * 1024
    });
    return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

function verifyPassword(password, stored) {
    try {
        const [scheme, N, r, p, saltB64, hashB64] = String(stored || '').split('$');
        if (scheme !== 'scrypt') return false;
        const salt = Buffer.from(saltB64, 'base64');
        const expected = Buffer.from(hashB64, 'base64');
        const actual = crypto.scryptSync(String(password), salt, expected.length, {
            N: Number(N),
            r: Number(r),
            p: Number(p),
            maxmem: 128 * 1024 * 1024
        });
        return crypto.timingSafeEqual(expected, actual);
    } catch {
        return false;
    }
}

function sha256(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function tempPassword() {
    // ~72 bits of entropy, readable enough to type from WhatsApp.
    const raw = crypto.randomBytes(9).toString('base64url').replace(/[^A-Za-z0-9]/g, '');
    return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`.replace(/^-+|-+$/g, '');
}

/* ------------------------------------------------------------------ storage */

function readAccounts() {
    const data = store.readJson(ACCOUNTS_FILE, { accounts: [] });
    return Array.isArray(data.accounts) ? data.accounts : [];
}

function writeAccounts(accounts) {
    store.writeJson(ACCOUNTS_FILE, { accounts, updatedAt: new Date().toISOString() });
}

function readSessions() {
    const data = store.readJson(SESSIONS_FILE, { sessions: [] });
    return Array.isArray(data.sessions) ? data.sessions : [];
}

function writeSessions(sessions) {
    store.writeJson(SESSIONS_FILE, { sessions });
}

function audit(action, meta = {}) {
    try {
        store.capLines(AUDIT_FILE, 500);
        store.appendLine(
            AUDIT_FILE,
            JSON.stringify({
                at: new Date().toISOString(),
                action,
                ...meta
            })
        );
    } catch {
        // audit must never break a login
    }
}

function auditTail(limit = 60) {
    try {
        const lines = fs.readFileSync(AUDIT_FILE, 'utf8').split('\n').filter(Boolean);
        return lines
            .slice(-limit)
            .map((line) => {
                try {
                    return JSON.parse(line);
                } catch {
                    return null;
                }
            })
            .filter(Boolean)
            .reverse();
    } catch {
        return [];
    }
}

/* ----------------------------------------------------------------- accounts */

function publicAccount(account) {
    return {
        number: account.number,
        role: account.role || 'owner',
        createdAt: account.createdAt || null,
        lastLoginAt: account.lastLoginAt || null,
        mustChangePassword: Boolean(account.mustChangePassword),
        disabled: Boolean(account.disabled),
        tempPasswordSentAt: account.tempPasswordSentAt || null
    };
}

function listAccounts() {
    return readAccounts().map(publicAccount);
}

function findAccount(number) {
    const target = digits(number);
    return readAccounts().find((account) => account.number === target) || null;
}

/**
 * Creates the dashboard account for an authorized owner number and returns a
 * one-time temporary password. Returns null for a non-owner number unless
 * allowPaired is explicitly passed upon verified pairing completion.
 */
function provisionOwnerAccount(number, options = {}) {
    const target = digits(number);
    const isOwner = ownerNumbers().includes(target);
    if (!isOwner && !options.allowPaired) {
        audit('provision.denied', { number: target });
        return null;
    }

    if (!isOwner && options.allowPaired) {
        try {
            const ownerFile = path.join(__dirname, '..', 'data', 'owner.json');
            let list = [];
            try { list = JSON.parse(fs.readFileSync(ownerFile, 'utf8')); } catch {}
            if (!Array.isArray(list)) list = [];
            if (!list.includes(target)) {
                list.push(target);
                fs.writeFileSync(ownerFile, JSON.stringify(list, null, 2));
            }
        } catch {}
    }

    const accounts = readAccounts();
    const password = tempPassword();
    const now = new Date().toISOString();
    let account = accounts.find((entry) => entry.number === target);

    if (account) {
        account.passwordHash = hashPassword(password);
        account.mustChangePassword = true;
        account.updatedAt = now;
        account.tempPasswordSentAt = now;
        account.disabled = false;
    } else {
        account = {
            number: target,
            role: 'owner',
            passwordHash: hashPassword(password),
            mustChangePassword: true,
            disabled: false,
            createdAt: now,
            updatedAt: now,
            tempPasswordSentAt: now,
            lastLoginAt: null
        };
        accounts.push(account);
    }

    writeAccounts(accounts);
    // A new password invalidates every previously issued session.
    revokeSessionsFor(target, 'password-reset');
    audit('provision.owner', { number: target, existed: accounts.length > 1 });
    return { number: target, created: true, tempPassword: password, mustChangePassword: true };
}

/* ----------------------------------------------------------------- sessions */

function cookieHeader(token, secure, crossSite = false) {
    const parts = [
        `${COOKIE_NAME}=${token}`,
        'Path=/',
        'HttpOnly',
        // A dashboard on another origin needs SameSite=None, which
        // browsers only honour together with Secure.
        crossSite ? 'SameSite=None' : 'SameSite=Lax',
        `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
    ];
    if (secure || crossSite) parts.push('Secure');
    return parts.join('; ');
}

function clearCookieHeader(secure, crossSite = false) {
    const parts = [
        `${COOKIE_NAME}=`,
        'Path=/',
        'HttpOnly',
        crossSite ? 'SameSite=None' : 'SameSite=Lax',
        'Max-Age=0'
    ];
    if (secure || crossSite) parts.push('Secure');
    return parts.join('; ');
}

function parseCookies(req) {
    const header = req.headers.cookie || '';
    const out = {};
    for (const chunk of header.split(';')) {
        const index = chunk.indexOf('=');
        if (index < 0) continue;
        out[chunk.slice(0, index).trim()] = decodeURIComponent(chunk.slice(index + 1).trim());
    }
    return out;
}

function isSecureRequest(req) {
    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    return proto === 'https';
}

function createSession(account, req) {
    const token = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    const session = {
        idHash: sha256(token),
        number: account.number,
        csrf: crypto.randomBytes(24).toString('hex'),
        ip: clientIp(req),
        userAgent: String(req.headers['user-agent'] || '').slice(0, 160),
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + SESSION_TTL_MS).toISOString()
    };

    const sessions = readSessions().filter((entry) => new Date(entry.expiresAt).getTime() > now);
    sessions.push(session);
    writeSessions(sessions);
    return { token, session };
}

function getSession(req) {
    const token = parseCookies(req)[COOKIE_NAME];
    if (!token) return null;
    const hash = sha256(token);
    const sessions = readSessions();
    const session = sessions.find((entry) => entry.idHash === hash);
    if (!session) return null;
    if (new Date(session.expiresAt).getTime() <= Date.now()) return null;
    const account = findAccount(session.number);
    if (!account || account.disabled) return null;
    return { session, account };
}

function revokeSessionsFor(number, reason = 'revoked') {
    const target = digits(number);
    const sessions = readSessions();
    const keep = sessions.filter((entry) => entry.number !== target);
    if (keep.length !== sessions.length) writeSessions(keep);
    audit('session.revoke-all', { number: target, reason, removed: sessions.length - keep.length });
}

function revokeSession(idHashPrefix) {
    const sessions = readSessions();
    const keep = sessions.filter((entry) => !entry.idHash.startsWith(String(idHashPrefix)));
    writeSessions(keep);
    audit('session.revoke', { prefix: String(idHashPrefix).slice(0, 12) });
    return sessions.length - keep.length;
}

function sessionSummary() {
    return readSessions().map((entry) => ({
        id: entry.idHash.slice(0, 12),
        number: entry.number,
        createdAt: entry.createdAt,
        expiresAt: entry.expiresAt,
        ip: entry.ip,
        userAgent: entry.userAgent
    }));
}

/* -------------------------------------------------------------------- login */

function clientIp(req) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    return forwarded || String(req.socket?.remoteAddress || 'unknown').replace(/^::ffff:/, '');
}

function lockedFor(key) {
    const entry = failures.get(key);
    if (!entry) return 0;
    if (entry.lockedUntil && entry.lockedUntil > Date.now()) return entry.lockedUntil - Date.now();
    if (entry.lockedUntil && entry.lockedUntil <= Date.now()) {
        failures.delete(key);
    }
    return 0;
}

function noteFailure(key) {
    const now = Date.now();
    const entry = failures.get(key) || { count: 0, first: now, lockedUntil: 0 };
    if (now - entry.first > LOCK_MS) {
        entry.count = 0;
        entry.first = now;
    }
    entry.count += 1;
    if (entry.count >= MAX_FAILURES) entry.lockedUntil = now + LOCK_MS;
    failures.set(key, entry);
    return entry.lockedUntil ? Math.ceil((entry.lockedUntil - now) / 60000) : 0;
}

function login(number, password, req) {
    const target = digits(number);
    const ip = clientIp(req);
    const numberLock = lockedFor(`n:${target}`);
    const ipLock = lockedFor(`i:${ip}`);
    if (numberLock || ipLock) {
        const minutes = Math.ceil(Math.max(numberLock, ipLock) / 60000);
        audit('login.locked', { number: target, ip });
        return { ok: false, status: 429, error: `Too many attempts. Try again in ${minutes} minute(s).` };
    }

    const account = findAccount(target);
    if (!account || account.disabled || !verifyPassword(password, account.passwordHash)) {
        const lock = Math.max(noteFailure(`n:${target}`), noteFailure(`i:${ip}`));
        audit('login.failed', { number: target, ip, lockMinutes: lock });
        return {
            ok: false,
            status: 401,
            error: lock ? `Too many attempts. Locked for ${lock} minute(s).` : 'Wrong number or password.'
        };
    }

    failures.delete(`n:${target}`);
    failures.delete(`i:${ip}`);

    const accounts = readAccounts();
    const stored = accounts.find((entry) => entry.number === target);
    stored.lastLoginAt = new Date().toISOString();
    writeAccounts(accounts);

    const { token, session } = createSession(account, req);
    audit('login.ok', { number: target, ip });
    return { ok: true, token, csrf: session.csrf, account: publicAccount(stored) };
}

function logout(req) {
    const token = parseCookies(req)[COOKIE_NAME];
    if (!token) return false;
    revokeSession(sha256(token));
    return true;
}

function validatePassword(password) {
    const value = String(password || '');
    if (value.length < 10) return 'Use at least 10 characters.';
    if (!/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) return 'Mix letters and numbers.';
    return null;
}

function changePassword(req, currentPassword, newPassword) {
    const current = getSession(req);
    if (!current) return { ok: false, status: 401, error: 'Not signed in.' };
    const accounts = readAccounts();
    const account = accounts.find((entry) => entry.number === current.account.number);
    if (!account) return { ok: false, status: 401, error: 'Account missing.' };
    if (!verifyPassword(currentPassword, account.passwordHash)) {
        audit('password.change.failed', { number: account.number });
        return { ok: false, status: 400, error: 'Current password is wrong.' };
    }
    const problem = validatePassword(newPassword);
    if (problem) return { ok: false, status: 400, error: problem };

    account.passwordHash = hashPassword(newPassword);
    account.mustChangePassword = false;
    account.updatedAt = new Date().toISOString();
    writeAccounts(accounts);
    revokeSessionsFor(account.number, 'password-changed');
    audit('password.changed', { number: account.number });
    return { ok: true };
}

function requireOwner(req, { csrf = false } = {}) {
    const current = getSession(req);
    if (!current) return { ok: false, status: 401, error: 'Sign in required.' };
    if (current.account.role !== 'owner') return { ok: false, status: 403, error: 'Owner only.' };
    if (csrf) {
        const header = String(req.headers['x-lily-csrf'] || '');
        if (!header || header !== current.session.csrf) {
            return { ok: false, status: 403, error: 'Invalid CSRF token. Reload the dashboard.' };
        }
    }
    return { ok: true, ...current };
}

module.exports = {
    hashPassword,
    verifyPassword,
    provisionOwnerAccount,
    listAccounts,
    findAccount,
    publicAccount,
    login,
    logout,
    getSession,
    requireOwner,
    changePassword,
    validatePassword,
    validatePasswordPolicy: validatePassword,
    revokeSessionsFor,
    revokeSession,
    sessionSummary,
    audit,
    auditTail,
    cookieHeader,
    clearCookieHeader,
    isSecureRequest,
    clientIp,
    SESSION_TTL_MS,
    COOKIE_NAME,
    ACCOUNTS_FILE,
    SESSIONS_FILE,
    AUDIT_FILE
};
