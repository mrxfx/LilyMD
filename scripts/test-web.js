'use strict';
/**
 * Real HTTP tests for the web platform (pairing contract, auth, dashboard API).
 *
 *   node scripts/test-web.js
 *
 * Boots the standalone server on an ephemeral port, drives it over HTTP, and
 * restores every data file it touched. Requires no node_modules: pairing
 * dependencies are absent here, which is exactly why /api/pair must answer with
 * JSON 503 instead of an HTML page.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 34567;
const BASE = `http://127.0.0.1:${PORT}`;
const TOUCHED = [
    'webAccounts.json',
    'webSessions.json',
    'webAudit.log',
    'disabledCommands.json',
    'aiAutoReply.json',
    'autoread.json',
    'messageCount.json'
];

let passed = 0;
let failed = 0;
const backups = new Map();

function check(name, condition, detail) {
    if (condition) {
        passed += 1;
        console.log(`  ✓ ${name}`);
    } else {
        failed += 1;
        console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
    }
}

function backupData() {
    for (const file of TOUCHED) {
        const full = path.join(ROOT, 'data', file);
        backups.set(file, fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null);
    }
}

function restoreData() {
    for (const file of TOUCHED) {
        const full = path.join(ROOT, 'data', file);
        const previous = backups.get(file);
        try {
            if (previous === null || previous === undefined) {
                if (fs.existsSync(full)) fs.unlinkSync(full);
            } else {
                fs.writeFileSync(full, previous);
            }
        } catch (err) {
            console.error('restore failed for', file, err.message);
        }
    }
}

function request(pathname, options = {}) {
    return new Promise((resolve, reject) => {
        const payload = options.body ? JSON.stringify(options.body) : null;
        const req = http.request(
            BASE + pathname,
            {
                method: options.method || 'GET',
                headers: Object.assign(
                    payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {},
                    options.headers || {}
                )
            },
            (res) => {
                const chunks = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () => {
                    const text = Buffer.concat(chunks).toString('utf8');
                    let json = null;
                    const type = String(res.headers['content-type'] || '');
                    if (type.includes('application/json')) {
                        try { json = JSON.parse(text); } catch (err) { json = null; }
                    }
                    resolve({ status: res.statusCode, headers: res.headers, text, json, type });
                });
            }
        );
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

function cookieFrom(response) {
    const raw = response.headers['set-cookie'];
    if (!raw) return '';
    return raw.map((value) => value.split(';')[0]).join('; ');
}

async function waitForServer(deadlineMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < deadlineMs) {
        try {
            const res = await request('/api/info');
            if (res.status === 200) return true;
        } catch (err) {
            // not listening yet
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return false;
}

(async () => {
    backupData();

    const server = spawn(process.execPath, [path.join(ROOT, 'web', 'server.js')], {
        cwd: ROOT,
        env: Object.assign({}, process.env, { WEB_PORT: String(PORT), NODE_ENV: 'test' }),
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let serverLog = '';
    server.stdout.on('data', (chunk) => { serverLog += chunk.toString(); });
    server.stderr.on('data', (chunk) => { serverLog += chunk.toString(); });

    try {
        const ready = await waitForServer();
        if (!ready) throw new Error('server did not start:\n' + serverLog);

        console.log('\nPages & static assets');
        for (const page of ['/', '/login', '/dashboard', '/app.js', '/dashboard.js', '/dashboard.css', '/config.js', '/assets/logo.png']) {
            const res = await request(page);
            check(`GET ${page} → 200`, res.status === 200, `got ${res.status}`);
        }

        console.log('\nPairing API contract (JSON always)');
        const pair = await request('/api/pair', { method: 'POST', body: { number: '916033352400' } });
        check('POST /api/pair answers JSON', pair.type.includes('application/json'), pair.type);
        check('missing dependencies → 503 JSON with code', pair.status === 503 && pair.json && pair.json.code === 'PAIRING_UNAVAILABLE', `${pair.status} ${pair.text.slice(0, 80)}`);

        const badNumber = await request('/api/pair', { method: 'POST', body: { number: '12' } });
        check('short number → 400 JSON', badNumber.status === 400 && badNumber.json && badNumber.json.code === 'BAD_NUMBER', badNumber.text);

        const badJson = await request('/api/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: null });
        check('empty body → 400 JSON (never HTML)', badJson.type.includes('application/json'), badJson.type);

        const missing = await request('/api/status?id=nope');
        check('unknown pairing job → 404 JSON', missing.status === 404 && missing.json && missing.json.code === 'JOB_EXPIRED', missing.text);

        const unknownApi = await request('/api/dash/status');
        check('dashboard unauthenticated → 401 JSON', unknownApi.status === 401 && unknownApi.json, unknownApi.text);

        console.log('\nOwner account provisioning');
        // The provisioning function is the same one the pairing flow calls.
        const auth = require(path.join(ROOT, 'lib', 'webAuth'));
        const denied = auth.provisionOwnerAccount('919999999999');
        check('non-owner number cannot be provisioned', denied === null);

        const provisioned = auth.provisionOwnerAccount('916033352400');
        check('owner account created with a temp password', Boolean(provisioned && provisioned.tempPassword));
        check('temp password is 10+ chars', provisioned.tempPassword.length >= 10, provisioned.tempPassword.length);
        check('account forces a password change', provisioned.mustChangePassword === true);

        const stored = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'webAccounts.json'), 'utf8'));
        const plaintextLeak = JSON.stringify(stored).includes(provisioned.tempPassword);
        check('only a hash is stored (no plaintext password)', !plaintextLeak);
        check('stored hash uses scrypt', /scrypt\$/.test(stored.accounts[0].passwordHash));

        const audit = fs.existsSync(path.join(ROOT, 'data', 'webAudit.log'))
            ? fs.readFileSync(path.join(ROOT, 'data', 'webAudit.log'), 'utf8')
            : '';
        check('audit log does not contain the password', !audit.includes(provisioned.tempPassword));

        console.log('\nAuthentication');
        const wrong = await request('/api/auth/login', { method: 'POST', body: { number: '916033352400', password: 'nope-nope-1' } });
        check('wrong password → 401', wrong.status === 401, wrong.text);

        const login = await request('/api/auth/login', {
            method: 'POST',
            body: { number: '916033352400', password: provisioned.tempPassword }
        });
        check('correct password → 200', login.status === 200, login.text);
        check('login returns a CSRF token', Boolean(login.json && login.json.csrf));
        const cookie = cookieFrom(login);
        check('session cookie is HttpOnly', String(login.headers['set-cookie']).includes('HttpOnly'));
        check('session cookie is SameSite', /SameSite=(Lax|None)/.test(String(login.headers['set-cookie'])));
        check('session id is not in the JSON body', !login.text.includes(cookie.split('=')[1] || 'no-cookie'));

        const authed = { cookie };
        const me = await request('/api/auth/me', { headers: authed });
        check('GET /api/auth/me → 200 with account', me.status === 200 && me.json.account.number === '916033352400', me.text);

        const noAccount = await request('/api/auth/login', {
            method: 'POST',
            body: { number: '916033271400', password: 'x' }
        });
        check('owner number without an account → 401', noAccount.status === 401, noAccount.text);

        console.log('\nDashboard API (real data)');
        const status = await request('/api/dash/status', { headers: authed });
        check('status → 200', status.status === 200, status.text);
        check('status reports connection state', status.json && typeof status.json.connected === 'boolean');
        check('status includes uptime from the process', status.json.uptimeSeconds >= 0);
        check('status counts real commands', status.json.commands > 50, String(status.json.commands));

        const settings = await request('/api/dash/settings', { headers: authed });
        check('settings → 200', settings.status === 200, settings.text);
        check('settings never exposes the API key', !JSON.stringify(settings.json).includes('sk-or-v1-'), 'full key leaked');

        const commands = await request('/api/dash/commands', { headers: authed });
        check('commands listed', commands.status === 200 && commands.json.commands.length > 50);

        console.log('\nMutation + CSRF + persistence');
        const noCsrf = await request('/api/dash/settings/toggle', {
            method: 'POST',
            headers: Object.assign({}, authed, { 'content-type': 'application/json' }),
            body: { key: 'autoread', value: true }
        });
        check('mutation without CSRF token → 403', noCsrf.status === 403, noCsrf.text);

        const withCsrf = Object.assign({}, authed, { 'content-type': 'application/json', 'x-lily-csrf': login.json.csrf });

        const toggle = await request('/api/dash/settings/toggle', {
            method: 'POST',
            headers: withCsrf,
            body: { key: 'autoread', value: true }
        });
        check('toggle with CSRF → 200', toggle.status === 200, toggle.text);
        const autoreadFile = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'autoread.json'), 'utf8'));
        check('toggle persisted to data/autoread.json', autoreadFile.enabled === true);

        await request('/api/dash/settings/toggle', { method: 'POST', headers: withCsrf, body: { key: 'autoread', value: false } });

        const mode = await request('/api/dash/settings/mode', { method: 'POST', headers: withCsrf, body: { mode: 'private' } });
        const modeFile = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'messageCount.json'), 'utf8'));
        check('mode change persisted', mode.status === 200 && modeFile.isPublic === false);
        await request('/api/dash/settings/mode', { method: 'POST', headers: withCsrf, body: { mode: 'public' } });

        const cmd = await request('/api/dash/commands/toggle', { method: 'POST', headers: withCsrf, body: { name: 'meme', enabled: false } });
        const disabled = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'disabledCommands.json'), 'utf8'));
        check('command disable persisted', cmd.status === 200 && disabled.includes('meme'));
        await request('/api/dash/commands/toggle', { method: 'POST', headers: withCsrf, body: { name: 'meme', enabled: true } });

        const autoreply = await request('/api/dash/autoreply', {
            method: 'POST',
            headers: withCsrf,
            body: { mode: 'all', cooldownSec: 7 }
        });
        const aiConfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'aiAutoReply.json'), 'utf8'));
        check('auto-reply mode + cooldown persisted', autoreply.status === 200 && aiConfig.mode === 'all' && aiConfig.cooldownSec === 7);

        const badMode = await request('/api/dash/autoreply', { method: 'POST', headers: withCsrf, body: { mode: 'everywhere' } });
        check('invalid auto-reply mode rejected', badMode.status === 400);

        const ai = await request('/api/dash/ai', {
            method: 'POST',
            headers: withCsrf,
            body: { model: 'openrouter/free', personality: 'venom', language: 'hinglish', style: 'short and savage' }
        });
        const aiSaved = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'aiAutoReply.json'), 'utf8'));
        check('AI personality/language/style saved', ai.status === 200 && aiSaved.personality === 'venom' && aiSaved.language === 'hinglish');

        const accounts = await request('/api/dash/owners', { headers: authed });
        check('owners list shows the provisioned account', accounts.json.accounts.some((a) => a.number === '916033352400'));
        check('password hash is never returned', !JSON.stringify(accounts.json).includes('passwordHash'));

        const sessions = await request('/api/dash/owners', { headers: authed });
        check('session list shows hashed-prefix ids only', sessions.json.sessions.every((s) => s.id.length === 12));

        const revoke = await request('/api/dash/sessions/revoke', {
            method: 'POST',
            headers: withCsrf,
            body: { id: sessions.json.sessions[0].id }
        });
        check('revoking a session works', revoke.status === 200 && revoke.json.removed >= 1);
        const afterRevoke = await request('/api/dash/status', { headers: authed });
        check('revoked session is rejected', afterRevoke.status === 401, afterRevoke.text);

        console.log('\nPassword change + lockout');
        const relogin = await request('/api/auth/login', {
            method: 'POST',
            body: { number: '916033352400', password: provisioned.tempPassword }
        });
        const reloginCookie = cookieFrom(relogin);
        const reloginCsrf = relogin.json.csrf;

        const mismatchHeaders = Object.assign({}, { cookie: reloginCookie }, { 'content-type': 'application/json', 'x-lily-csrf': reloginCsrf });
        const weak = await request('/api/auth/password', {
            method: 'POST',
            headers: mismatchHeaders,
            body: { currentPassword: provisioned.tempPassword, newPassword: 'short' }
        });
        check('weak new password rejected', weak.status === 400, weak.text);

        const changed = await request('/api/auth/password', {
            method: 'POST',
            headers: mismatchHeaders,
            body: { currentPassword: provisioned.tempPassword, newPassword: 'LilyOwner2026' }
        });
        check('password change accepted', changed.status === 200, changed.text);

        const oldSession = await request('/api/auth/me', { headers: { cookie: reloginCookie } });
        check('password change revoked old sessions', oldSession.status === 401, oldSession.text);

        const newLogin = await request('/api/auth/login', {
            method: 'POST',
            body: { number: '916033352400', password: 'LilyOwner2026' }
        });
        check('new password works', newLogin.status === 200, newLogin.text);
        check('must-change flag cleared after change', newLogin.json.account.mustChangePassword === false);

        let lockedStatus = 0;
        for (let attempt = 0; attempt < 5; attempt += 1) {
            const res = await request('/api/auth/login', {
                method: 'POST',
                body: { number: '916033352400', password: 'wrong-' + attempt + '-pass' }
            });
            lockedStatus = res.status;
        }
        const locked = await request('/api/auth/login', {
            method: 'POST',
            body: { number: '916033352400', password: 'LilyOwner2026' }
        });
        check('account locks after 5 failures', lockedStatus === 401 && locked.status === 429, `${lockedStatus} → ${locked.status}`);

        console.log('\nFiles stay private');
        for (const secret of ['webAccounts.json', 'webSessions.json', 'webAudit.log']) {
            const res = await request('/' + secret);
            check(`/${secret} is not served`, res.status !== 200, String(res.status));
        }

        console.log(`\nWeb platform: ${passed} passed, ${failed} failed`);
        if (failed) process.exitCode = 1;
    } catch (err) {
        console.error('\nTEST RUN FAILED:', err.message);
        console.error(serverLog.slice(-2000));
        process.exitCode = 1;
    } finally {
        server.kill();
        restoreData();
    }
})();
