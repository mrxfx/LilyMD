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
    path.join('data', 'webAccounts.json'),
    path.join('data', 'webSessions.json'),
    path.join('data', 'webAudit.log'),
    path.join('data', 'disabledCommands.json'),
    path.join('data', 'aiAutoReply.json'),
    path.join('data', 'aiProviders.json'),
    path.join('data', 'aiContacts.json'),
    path.join('data', 'aiStyle.json'),
    path.join('data', 'aiControls.json'),
    path.join('data', 'autoStatus.json'),
    path.join('data', 'autoread.json'),
    path.join('data', 'messageCount.json'),
    path.join('config', 'aiProviders.json')
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
        const full = path.join(ROOT, file);
        backups.set(file, fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null);
    }
}

function restoreData() {
    for (const file of TOUCHED) {
        const full = path.join(ROOT, file);
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

        const qrPair = await request('/api/pair/qr', { method: 'POST' });
        check('POST /api/pair/qr answers JSON', qrPair.type.includes('application/json'), qrPair.type);
        check('QR missing dependencies → 503 JSON with code', qrPair.status === 503 && qrPair.json && qrPair.json.code === 'PAIRING_UNAVAILABLE');

        const cancelBad = await request('/api/pair/cancel', { method: 'POST', body: {} });
        check('cancel without id → 400 JSON', cancelBad.status === 400 && cancelBad.json);

        const cancelUnknown = await request('/api/pair/cancel', { method: 'POST', body: { id: 'unknown-id' } });
        check('cancel unknown id → 200 with canceled false', cancelUnknown.status === 200 && cancelUnknown.json.canceled === false);

        const publicCommands = await request('/api/commands');
        check('GET /api/commands → 200 with command list', publicCommands.status === 200 && Array.isArray(publicCommands.json.commands) && publicCommands.json.total > 0);

        const generalStatus = await request('/api/status');
        check('GET /api/status without id → 200 general health', generalStatus.status === 200 && generalStatus.json.ok === true && typeof generalStatus.json.uptime === 'number');

        const healthApi = await request('/api/health');
        check('GET /api/health → 200 health info', healthApi.status === 200 && healthApi.json.status === 'ok');

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

        console.log('\nAI provider slots & contact memory');
        const settings2 = await request('/api/dash/settings', { headers: authed });
        check('settings expose the three provider slots', settings2.json.ai.providerSlots.length === 3, String(settings2.json.ai.providerSlots.length));
        check('settings never include a raw API key', !JSON.stringify(settings2.json).includes('sk-or-v1-'));
        check('settings include the failover order', Array.isArray(settings2.json.ai.providerOrder) && settings2.json.ai.providerOrder.length === 3);

        const providersRes = await request('/api/dash/ai/providers', { headers: authed });
        check('provider slots endpoint → 200', providersRes.status === 200 && providersRes.json.slots.length === 3, providersRes.text);
        check('slots carry base URL and model but no key', providersRes.json.slots.every((s) => typeof s.baseUrl === 'string' && typeof s.model === 'string' && !('apiKey' in s)));

        const badBase = await request('/api/dash/ai/providers', { method: 'POST', headers: withCsrf, body: { slot: 'fallback2', baseUrl: 'javascript:alert(1)' } });
        check('invalid base URL rejected', badBase.status === 400, badBase.text);
        const badSlot = await request('/api/dash/ai/providers', { method: 'POST', headers: withCsrf, body: { slot: 'fourth', model: 'm' } });
        check('unknown slot rejected', badSlot.status === 400);
        const badOrder = await request('/api/dash/ai/providers/order', { method: 'POST', headers: withCsrf, body: { order: ['primary', 'nope'] } });
        check('order with an unknown slot rejected', badOrder.status === 400);
        const orderOk = await request('/api/dash/ai/providers/order', { method: 'POST', headers: withCsrf, body: { order: ['fallback1', 'primary', 'fallback2'] } });
        check('valid order saved', orderOk.status === 200 && orderOk.json.order[0] === 'fallback1', orderOk.text);
        await request('/api/dash/ai/providers/order', { method: 'POST', headers: withCsrf, body: { order: ['primary', 'fallback1', 'fallback2'] } });

        const modelList = await request('/api/dash/ai/providers/models?slot=primary', { headers: authed });
        check('model listing answers JSON gracefully', modelList.status === 200 && typeof modelList.json.ok === 'boolean', modelList.text);
        console.log('\nSmart reply controls');
        const controlsRes = await request('/api/dash/ai/controls', { headers: authed });
        check('controls endpoint → 200', controlsRes.status === 200 && controlsRes.json.pause && controlsRes.json.quiet, controlsRes.text);
        check('settings include controls', settings2.json.controls && typeof settings2.json.controls.handoffMinutes === 'number');

        const paused = await request('/api/dash/ai/controls', { method: 'POST', headers: withCsrf, body: { action: 'pause', duration: '30m' } });
        check('pause accepted', paused.status === 200 && paused.json.controls.pause.paused === true, paused.text);
        const pausedSettings = await request('/api/dash/settings', { headers: authed });
        check('pause is visible in settings', pausedSettings.json.controls.pause.paused === true);
        const resumed = await request('/api/dash/ai/controls', { method: 'POST', headers: withCsrf, body: { action: 'resume' } });
        check('resume accepted', resumed.status === 200 && resumed.json.controls.pause.paused === false, resumed.text);
        const badPause = await request('/api/dash/ai/controls', { method: 'POST', headers: withCsrf, body: { action: 'pause', duration: 'whenever' } });
        check('invalid pause duration rejected', badPause.status === 400, badPause.text);

        const badQuiet = await request('/api/dash/ai/controls', { method: 'POST', headers: withCsrf, body: { quietHours: { enabled: true, start: '25:00', end: '07:00' } } });
        check('invalid quiet hours rejected', badQuiet.status === 400, badQuiet.text);
        const quietOk = await request('/api/dash/ai/controls', { method: 'POST', headers: withCsrf, body: { quietHours: { enabled: true, start: '23:00', end: '07:00' } } });
        check('quiet hours saved', quietOk.status === 200 && quietOk.json.controls.quiet.enabled === true && quietOk.json.controls.quiet.start === '23:00', quietOk.text);
        await request('/api/dash/ai/controls', { method: 'POST', headers: withCsrf, body: { quietHours: { enabled: false, start: '23:00', end: '07:00' } } });

        const badHandoff = await request('/api/dash/ai/controls', { method: 'POST', headers: withCsrf, body: { handoffMinutes: 5000 } });
        check('invalid handoff duration rejected', badHandoff.status === 400, badHandoff.text);
        const handoffOk = await request('/api/dash/ai/controls', { method: 'POST', headers: withCsrf, body: { handoffMinutes: 30 } });
        check('handoff duration saved', handoffOk.status === 200 && handoffOk.json.controls.handoffMinutes === 30, handoffOk.text);

        const badNever = await request('/api/dash/ai/controls', { method: 'POST', headers: withCsrf, body: { neverAdd: '12' } });
        check('short never-reply number rejected', badNever.status === 400, badNever.text);
        const neverOk = await request('/api/dash/ai/controls', { method: 'POST', headers: withCsrf, body: { neverAdd: '916033271400' } });
        check('never-reply number saved', neverOk.status === 200 && neverOk.json.controls.neverReply.includes('916033271400'), neverOk.text);
        await request('/api/dash/ai/controls', { method: 'POST', headers: withCsrf, body: { neverRemove: '916033271400' } });

        const contactRulesMissing = await request('/api/dash/ai/contacts/settings', { method: 'POST', headers: withCsrf, body: { id: '000000000000', autoReply: 'off' } });
        check('contact rules for unknown contact → 404', contactRulesMissing.status === 404, contactRulesMissing.text);

        console.log('\nStatus reaction setting');
        const reactionSet = await request('/api/dash/settings/autostatus', { method: 'POST', headers: withCsrf, body: { reaction: '🔥' } });
        check('status reaction saved', reactionSet.status === 200 && reactionSet.json.autoStatus.reaction === '🔥', reactionSet.text);
        const reactionBad = await request('/api/dash/settings/autostatus', { method: 'POST', headers: withCsrf, body: { reaction: 'heart' } });
        check('non-emoji status reaction rejected', reactionBad.status === 400, reactionBad.text);
        const reactionSettings = await request('/api/dash/settings', { headers: authed });
        check('settings expose the status reaction', reactionSettings.json.autoStatus.reaction === '🔥', JSON.stringify(reactionSettings.json.autoStatus));

        const contactsRes = await request('/api/dash/ai/contacts', { headers: authed });
        check('contact memory endpoint → 200', contactsRes.status === 200 && Array.isArray(contactsRes.json.contacts), contactsRes.text);
        const delMissing = await request('/api/dash/ai/contacts/delete', { method: 'POST', headers: withCsrf, body: { id: '000000000000' } });
        check('deleting an unknown contact → 404', delMissing.status === 404, delMissing.text);

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
