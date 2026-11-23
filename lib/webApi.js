'use strict';
/**
 * Dashboard API — every route reads and writes the bot's real state.
 *
 * No demo data: status comes from the running process and the bot's own data
 * files, toggles are the same JSON files the in-chat commands use, and the AI
 * routes call the configured OpenRouter endpoint.
 *
 * All routes are owner-only (lib/webAuth) and mutations also require the CSRF
 * token, so the browser can never grant itself anything.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const store = require('./webStore');
const auth = require('./webAuth');
const aiProviders = require('./aiProviders');
const aiConfig = require('./aiConfig');
const aiStyle = require('./aiStyle');
const aiContacts = require('./aiContacts');
const aiControls = require('./aiControls');
const statusReaction = require('./statusReaction');
const vision = require('./vision');
const { ownerNumbers } = require('./ownerNumbers');

const ROOT = path.join(__dirname, '..');
const COMMANDS_DIR = path.join(ROOT, 'commands');
const AI_CONFIG_FILE = store.dataPath('aiAutoReply.json');
const AI_MEMORY_FILE = store.dataPath('aiMemory.json');
const AI_USAGE_FILE = store.dataPath('aiUsage.json');
const MESSAGE_COUNT_FILE = store.dataPath('messageCount.json');
const DISABLED_COMMANDS_FILE = store.dataPath('disabledCommands.json');

const AI_AGENTS = ['companion', 'professional', 'venom', 'tutor', 'coder'];
const MAX_INSTRUCTIONS_CHARS = 2000;

const STARTED_AT = new Date();
const events = []; // in-memory ring for SSE + Logs page
const MAX_EVENTS = 80;

let runtime = {
    getConnected: () => false,
    getSocket: () => null,
    disconnect: null,
    reconnect: null,
    listGroups: null
};

function setRuntime(next = {}) {
    runtime = { ...runtime, ...next };
}

function emit(type, message, level = 'info') {
    const event = { at: new Date().toISOString(), type, message, level };
    events.push(event);
    if (events.length > MAX_EVENTS) events.shift();
    return event;
}

/* ------------------------------------------------------------------- files */

function readJson(file, fallback) {
    return store.readJson(file, fallback);
}

function writeJson(file, value) {
    return store.writeJson(file, value);
}

function botSettings() {
    try {
        return require('../settings');
    } catch {
        return {};
    }
}

function readFlag(name, fallback = false) {
    const data = readJson(store.dataPath(name), {});
    return typeof data.enabled === 'boolean' ? data.enabled : fallback;
}

function writeFlag(name, enabled) {
    const data = readJson(store.dataPath(name), {});
    data.enabled = Boolean(enabled);
    writeJson(store.dataPath(name), data);
    return data.enabled;
}

function readAiConfig() {
    const data = readJson(AI_CONFIG_FILE, {});
    return {
        enabled: Boolean(data.enabled),
        mode: ['off', 'private', 'group', 'all'].includes(data.mode) ? data.mode : 'private',
        provider: aiProviders.PROVIDER_IDS.includes(String(data.provider || '').toLowerCase())
            ? String(data.provider).toLowerCase()
            : 'openrouter',
        style: typeof data.style === 'string' ? data.style : '',
        instructions: typeof data.instructions === 'string' ? data.instructions : '',
        model: typeof data.model === 'string' ? data.model : '',
        apiKey: typeof data.apiKey === 'string' ? data.apiKey : '',
        keys: data.keys && typeof data.keys === 'object' ? { ...data.keys } : {},
        models: data.models && typeof data.models === 'object' ? { ...data.models } : {},
        allowlist: Array.isArray(data.allowlist) ? data.allowlist.map(String) : [],
        blocked: Array.isArray(data.blocked) ? data.blocked.map(String) : [],
        cooldownSec: Number.isFinite(Number(data.cooldownSec)) ? Math.max(0, Number(data.cooldownSec)) : 3,
        personality: AI_AGENTS.includes(data.personality) ? data.personality : 'companion',
        language: ['auto', 'english', 'hindi', 'hinglish', 'bengali', 'benlish'].includes(data.language) ? data.language : 'auto',
        updatedAt: data.updatedAt || null
    };
}

function writeAiConfig(patch) {
    const next = { ...readAiConfig(), ...patch, updatedAt: new Date().toISOString() };
    writeJson(AI_CONFIG_FILE, next);
    return next;
}

function maskKey(key) {
    const value = String(key || '');
    if (!value) return '';
    if (value.length <= 14) return '••••';
    return `${value.slice(0, 8)}…${value.slice(-4)}`;
}

// Which provider's key/model is in use — dashboard selection, else OpenRouter.
function resolveAiKey(config, providerId = config.provider) {
    const provider = aiProviders.getProvider(providerId);
    const saved = String((config.keys || {})[provider.id] || '').trim();
    if (saved) return saved;
    for (const name of provider.envKeys) {
        const value = String(process.env[name] || '').trim();
        if (value) return value;
    }
    if (provider.id === 'openrouter') {
        const settings = botSettings();
        return String(config.apiKey || settings.aiAutoReplyKey || settings.openrouterApiKey || '').trim();
    }
    return '';
}

function resolveAiModel(config, providerId = config.provider) {
    const provider = aiProviders.getProvider(providerId);
    const saved = String((config.models || {})[provider.id] || '').trim();
    if (saved) return saved;
    if (provider.id === 'openrouter') {
        const settings = botSettings();
        return String(
            config.model || settings.aiAutoReplyModel || settings.openrouterModel || process.env.OPENROUTER_MODEL || provider.defaultModel
        ).trim();
    }
    return provider.defaultModel;
}

function readAiMemory() {
    const style = aiStyle.getStyleData();
    const facts = {};
    for (const sample of style.samples.slice(-40)) Object.assign(facts, aiContacts.learnFacts({}, sample));
    const contacts = aiContacts.listContacts();
    return {
        styleSamples: style.samples,
        profile: style.profile,
        guidance: style.guidance,
        facts,
        contacts,
        contactCount: contacts.length,
        updatedAt: style.updatedAt || null
    };
}

function aiUsage() {
    const data = readJson(AI_USAGE_FILE, {});
    const users = data.users && typeof data.users === 'object' ? data.users : data;
    let total = 0;
    let today = 0;
    const todayKey = new Date().toISOString().slice(0, 10);
    for (const entry of Object.values(users || {})) {
        if (!entry || typeof entry !== 'object') continue;
        total += Number(entry.total || 0);
        if (entry.date === todayKey) today += Number(entry.count || 0);
    }
    return { total, today };
}

function messageTotals() {
    const data = readJson(MESSAGE_COUNT_FILE, {});
    let messages = 0;
    for (const value of Object.values(data.messageCount || {})) {
        if (typeof value === 'number') messages += value;
        else if (value && typeof value === 'object') messages += Number(value.count || 0);
    }
    return { messages, publicMode: data.isPublic !== false };
}

function listCommands() {
    let files = [];
    try {
        files = fs.readdirSync(COMMANDS_DIR).filter((file) => file.endsWith('.js'));
    } catch {
        return [];
    }
    const disabled = new Set(readJson(DISABLED_COMMANDS_FILE, []));
    return files
        .map((file) => {
            const name = file.replace(/\.js$/, '');
            let category = 'general';
            if (/antilink|antibot|antidelete|anticall|pmblocker|antitag|antibadword|ban|kick|mute|promote|demote|warn/.test(name)) category = 'moderation';
            else if (/sticker|simage|attp|take|emojimix|stickercrop|textmaker|meme|imagine|removebg|blur/.test(name)) category = 'media';
            else if (/ai|chatbot|character|flirt|simp|stupid|insult|compliment|joke|quote|fact|truth|dare/.test(name)) category = 'ai & fun';
            else if (/song|video|play|spotify|instagram|facebook|twitter|tiktok|youtube|download|dl|reactions|gif/.test(name)) category = 'downloads';
            else if (/settings|mode|owner|sudo|update|help|ping|alive|pair|website|github|setpp|clearsession|cleartmp/.test(name)) category = 'system';
            return { name, file, category, enabled: !disabled.has(name) };
        })
        .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
}

function toggleCommand(name, enabled) {
    const allowed = listCommands().map((entry) => entry.name);
    if (!allowed.includes(name)) return null;
    const disabled = new Set(readJson(DISABLED_COMMANDS_FILE, []));
    if (enabled) disabled.delete(name);
    else disabled.add(name);
    writeJson(DISABLED_COMMANDS_FILE, [...disabled]);
    emit('command.toggle', `${name} ${enabled ? 'enabled' : 'disabled'}`);
    return { name, enabled };
}

function socketUser() {
    const sock = runtime.getSocket ? runtime.getSocket() : null;
    const id = sock?.user?.id || sock?.user?.jid || sock?.authState?.creds?.me?.id || '';
    if (id) {
        const clean = String(id).split(':')[0].split('@')[0].replace(/[^0-9]/g, '');
        if (clean) return clean;
    }
    const accounts = auth.listAccounts();
    if (accounts.length > 0 && accounts[0].number) {
        return accounts[0].number;
    }
    const owners = ownerNumbers();
    return owners[0] || null;
}

function status() {
    const config = readAiConfig();
    const memory = readAiMemory();
    const usage = aiUsage();
    const totals = messageTotals();
    const commands = listCommands();
    const connected = Boolean(runtime.getConnected && runtime.getConnected());
    const settings = botSettings();
    const userNumber = connected ? socketUser() : null;
    return {
        botName: settings.botName || 'Lily MD',
        aiName: settings.aiName || 'AYHA',
        version: settings.version || require(path.join(ROOT, 'package.json')).version,
        connected,
        whatsappNumber: userNumber,
        state: connected ? 'connected' : 'disconnected',
        uptimeSeconds: Math.round(process.uptime()),
        startedAt: STARTED_AT.toISOString(),
        node: process.version,
        platform: process.platform,
        publicMode: totals.publicMode,
        commands: commands.length,
        enabledCommands: commands.filter((entry) => entry.enabled).length,
        messages: totals.messages,
        aiRequests: usage.total,
        aiToday: usage.today,
        autoReply: {
            enabled: config.enabled,
            mode: config.mode,
            model: aiConfig.primarySlot()?.model || resolveAiModel(config),
            provider: aiConfig.primarySlot()?.providerLabel || null,
            slot: aiConfig.primarySlot()?.id || null,
            keyConfigured: Boolean(aiConfig.primarySlot()?.apiKey)
        },
        memory: {
            styleSamples: memory.styleSamples.length,
            facts: Object.keys(memory.facts).length
        },
        owners: ownerNumbers().length
    };
}

/* ----------------------------------------------------------------- settings */

const TOGGLES = {
    anticall: { file: 'anticall.json', label: 'Anti-call', group: 'protection' },
    antidelete: { file: 'antidelete.json', label: 'Anti-delete', group: 'protection' },
    pmblocker: { file: 'pmblocker.json', label: 'PM blocker', group: 'protection' },
    antibot: { file: 'antibot.json', label: 'Anti-bot', group: 'protection' },
    autoread: { file: 'autoread.json', label: 'Auto-read', group: 'automation' },
    autotyping: { file: 'autotyping.json', label: 'Auto-typing', group: 'automation' },
    vision: { file: 'vision.json', label: 'Image Vision', group: 'intelligence' }
};

function settingsSnapshot() {
    const toggles = {};
    for (const [key, meta] of Object.entries(TOGGLES)) {
        toggles[key] = { value: readFlag(meta.file), label: meta.label, group: meta.group };
    }
    const autoStatus = readJson(store.dataPath('autoStatus.json'), {});
    const pm = readJson(store.dataPath('pmblocker.json'), {});
    const totals = messageTotals();
    const config = readAiConfig();
    const settings = botSettings();
    return {
        toggles,
        vision: vision.getStatus(),
        autoStatus: {
            enabled: Boolean(autoStatus.enabled),
            reactOn: Boolean(autoStatus.reactOn),
            reaction: statusReaction.getReaction(),
            reactionEmoji: statusReaction.emojiCount(statusReaction.getReaction())
        },
        pmMessage: pm.message || '',
        mode: totals.publicMode ? 'public' : 'private',
        prefix: '.',
        websiteUrl: settings.websiteUrl || process.env.WEBSITE_URL || 'https://lilymd.onrender.com',
        githubRepo: settings.githubRepo || process.env.GITHUB_REPO || '',
        aiDailyLimit: Number(settings.aiDailyLimit ?? process.env.AI_DAILY_LIMIT ?? 30),
        controls: aiControls.status(),
        ai: {
            provider: config.provider,
            providerLabel: aiProviders.getProvider(config.provider).label,
            providers: aiProviders.listProviders(),
            model: resolveAiModel(config),
            providerSlots: aiConfig.getSlotsPublic(),
            providerOrder: aiConfig.getOrder(),
            providerSummary: aiConfig.statusSummary(),
            limits: {
                fast: aiConfig.readConfig().fast,
                detailed: aiConfig.readConfig().detailed
            },
            fallbackReply: config.fallbackReply,
            visionReply: config.visionReply,
            models: config.models,
            keyConfigured: Boolean(resolveAiKey(config)),
            keysConfigured: Object.fromEntries(
                aiProviders.PROVIDER_IDS.map((id) => [id, Boolean(resolveAiKey(config, id))])
            ),
            maskedKey: maskKey(resolveAiKey(config)),
            baseUrl: settings.openrouterBaseUrl || process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
            enabled: config.enabled,
            mode: config.mode,
            style: config.style,
            instructions: config.instructions,
            agents: AI_AGENTS,
            personality: config.personality,
            language: config.language,
            allowlist: config.allowlist,
            blocked: config.blocked,
            cooldownSec: config.cooldownSec
        },
        ownerNumbers: ownerNumbers()
    };
}

function setToggle(key, value, extra = {}) {
    const meta = TOGGLES[key];
    if (!meta) return null;
    if (key === 'vision') {
        vision.setEnabled(value);
    } else if (key === 'pmblocker') {
        const data = readJson(store.dataPath(meta.file), {});
        data.enabled = Boolean(value);
        if (typeof extra.message === 'string' && extra.message.trim()) data.message = extra.message.trim().slice(0, 400);
        writeJson(store.dataPath(meta.file), data);
    } else {
        writeFlag(meta.file, value);
    }
    emit('setting.toggle', `${meta.label} ${value ? 'on' : 'off'}`);
    return { key, value: Boolean(value) };
}

function setAutoStatus(patch) {
    const data = statusReaction.readConfig();
    if (typeof patch.enabled === 'boolean') data.enabled = patch.enabled;
    if (typeof patch.reactOn === 'boolean') data.reactOn = patch.reactOn;
    if (patch.reaction !== undefined) {
        const saved = statusReaction.setReaction(patch.reaction);
        if (!saved.ok) return { error: saved.error };
        data.statusReaction = saved.value;
    }
    statusReaction.updateConfig(data);
    emit('setting.autostatus', `view=${Boolean(data.enabled)} react=${Boolean(data.reactOn)}`);
    const next = statusReaction.readConfig();
    return {
        enabled: next.enabled,
        reactOn: next.reactOn,
        reaction: next.statusReaction
    };
}

function setMode(mode) {
    if (!['public', 'private'].includes(mode)) return null;
    const data = readJson(MESSAGE_COUNT_FILE, { messageCount: {}, isPublic: true });
    data.isPublic = mode === 'public';
    writeJson(MESSAGE_COUNT_FILE, data);
    emit('setting.mode', `bot is now ${mode}`);
    return mode;
}

/* --------------------------------------------------------------------- AI */

function postJson(urlString, payload, apiKey, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlString);
        const body = JSON.stringify(payload);
        const req = https.request(
            {
                hostname: url.hostname,
                port: url.port || 443,
                path: url.pathname + url.search,
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(body),
                    authorization: `Bearer ${apiKey}`,
                    'http-referer': process.env.WEBSITE_URL || 'https://lilymd.onrender.com',
                    'x-title': 'Lily MD'
                },
                timeout: timeoutMs
            },
            (res) => {
                const chunks = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () => {
                    const text = Buffer.concat(chunks).toString('utf8');
                    let json = null;
                    try {
                        json = JSON.parse(text);
                    } catch {
                        // keep raw for the error message
                    }
                    resolve({ status: res.statusCode, json, text });
                });
            }
        );
        req.on('timeout', () => req.destroy(new Error(`Timed out after ${timeoutMs}ms`)));
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

async function testAi(prompt, overrides = {}) {
    const settings = botSettings();
    if (overrides.slot) return aiConfig.testSlot(String(overrides.slot), prompt);
    try {
        const result = await aiConfig.chatWithFailover(
            [
                {
                    role: 'system',
                    content: `You are ${settings.aiName || 'AYHA'}, the assistant inside ${settings.botName || 'Lily MD'}. Answer in 1-2 short lines.`
                },
                { role: 'user', content: String(prompt || 'Hello').slice(0, 2000) }
            ],
            { depth: 'fast', maxTokens: 200 }
        );
        return {
            ok: true,
            reply: result.text,
            model: result.model,
            provider: result.provider,
            slot: result.slot,
            attempts: result.attempts,
            ms: result.ms
        };
    } catch (err) {
        return {
            ok: false,
            error: err?.message || String(err),
            attempts: err?.attempts || [],
            provider: aiConfig.statusSummary().active || 'none'
        };
    }
}

/* --------------------------------------------------------------- database */

function dataInventory() {
    const entries = [];
    let total = 0;
    try {
        for (const file of fs.readdirSync(store.DATA_DIR)) {
            const full = path.join(store.DATA_DIR, file);
            const stat = fs.statSync(full);
            if (!stat.isFile()) continue;
            entries.push({ name: file, bytes: stat.size, modifiedAt: stat.mtime.toISOString() });
            total += stat.size;
        }
    } catch {
        // data dir missing
    }
    let sessionBackup = null;
    try {
        const backup = path.join(ROOT, 'session.card');
        const legacyBackup = path.join(ROOT, 'session-backup.txt');
        if (fs.existsSync(backup)) sessionBackup = fs.statSync(backup).mtime.toISOString();
        else if (fs.existsSync(legacyBackup)) sessionBackup = fs.statSync(legacyBackup).mtime.toISOString();
    } catch {}
    return {
        files: entries.sort((a, b) => b.bytes - a.bytes),
        totalBytes: total,
        sessionBackupAt: sessionBackup,
        sessionPresent: fs.existsSync(path.join(ROOT, 'session')),
        memory: {
            styleSamples: readAiMemory().styleSamples.length,
            facts: Object.keys(readAiMemory().facts).length
        }
    };
}

function clearAiMemory() {
    aiStyle.clearStyle();
    aiContacts.clearContacts();
    writeJson(AI_MEMORY_FILE, { styleSamples: [], facts: {}, updatedAt: new Date().toISOString() });
    emit('memory.clear', 'AYHA memory cleared');
    return true;
}

/* -------------------------------------------------------------------- http */

function sendJson(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(body)
    });
    res.end(body);
}

function readBody(req, limit = 32 * 1024) {
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

async function bodyJson(req) {
    try {
        return JSON.parse((await readBody(req)) || '{}');
    } catch {
        return null;
    }
}

function no(res, result) {
    sendJson(res, result.status || 400, { error: result.error || 'Request failed.' });
    return true;
}

/**
 * True when the browser page is on another origin than this bot.
 * The session cookie then needs SameSite=None + Secure, otherwise the browser
 * stores it but never sends it back on cross-origin dashboard requests.
 */
function isCrossSiteRequest(req) {
    const origin = String(req.headers.origin || '');
    if (!origin) return false;
    const host = String(req.headers.host || '');
    try {
        return new URL(origin).host !== host;
    } catch {
        return false;
    }
}

function requireAuth(res, req, { csrf }) {
    const result = auth.requireOwner(req, { csrf });
    if (!result.ok) {
        no(res, result);
        return null;
    }
    return result;
}

/**
 * Dashboard + auth routes. Returns true when the request was handled.
 */
async function handleApi(req, res, url) {
    const route = url.pathname;

    /* -------- public auth routes -------- */
    if (route === '/api/auth/login' && req.method === 'POST') {
        const body = await bodyJson(req);
        if (!body) return no(res, { status: 400, error: 'Invalid request body.' });
        const result = auth.login(body.number, body.password, req);
        if (!result.ok) return no(res, result);
        res.setHeader(
            'set-cookie',
            auth.cookieHeader(result.token, auth.isSecureRequest(req), isCrossSiteRequest(req))
        );
        sendJson(res, 200, { ok: true, account: result.account, csrf: result.csrf, token: result.token });
        return true;
    }

    if (route === '/api/auth/logout' && req.method === 'POST') {
        const current = auth.getSession(req);
        if (!current) {
            sendJson(res, 200, { ok: true });
            return true;
        }
        const header = String(req.headers['x-lily-csrf'] || '');
        if (header !== current.session.csrf) return no(res, { status: 403, error: 'Invalid CSRF token.' });
        auth.logout(req);
        res.setHeader(
            'set-cookie',
            auth.clearCookieHeader(auth.isSecureRequest(req), isCrossSiteRequest(req))
        );
        sendJson(res, 200, { ok: true });
        return true;
    }

    if (route === '/api/auth/me' && req.method === 'GET') {
        const current = auth.getSession(req);
        if (!current) return no(res, { status: 401, error: 'Sign in required.' });
        sendJson(res, 200, {
            account: auth.publicAccount(current.account),
            csrf: current.session.csrf,
            expiresAt: current.session.expiresAt
        });
        return true;
    }

    if (route === '/api/auth/password' && req.method === 'POST') {
        const current = auth.requireOwner(req, { csrf: true });
        if (!current.ok) return no(res, current);
        const body = await bodyJson(req);
        if (!body) return no(res, { status: 400, error: 'Invalid request body.' });
        const result = auth.changePassword(req, body.currentPassword, body.newPassword);
        if (!result.ok) return no(res, result);
        res.setHeader(
            'set-cookie',
            auth.clearCookieHeader(auth.isSecureRequest(req), isCrossSiteRequest(req))
        );
        sendJson(res, 200, { ok: true, message: 'Password changed. Sign in again.' });
        return true;
    }

    /* -------- dashboard (owner only) -------- */
    if (!route.startsWith('/api/dash/')) return false;
    const mutating = req.method === 'POST' || req.method === 'DELETE';
    const session = requireAuth(res, req, { csrf: mutating });
    if (!session) return true;
    const path_ = route.slice('/api/dash/'.length);

    if (req.method === 'GET') {
        switch (path_) {
            case 'status':
                sendJson(res, 200, status());
                return true;
            case 'settings':
                sendJson(res, 200, settingsSnapshot());
                return true;
            case 'commands':
                sendJson(res, 200, { commands: listCommands() });
                return true;
            case 'connection':
                sendJson(res, 200, {
                    connected: Boolean(runtime.getConnected && runtime.getConnected()),
                    number: socketUser(),
                    canReconnect: Boolean(runtime.reconnect),
                    canDisconnect: Boolean(runtime.disconnect),
                    pairingUrl: `${process.env.WEBSITE_URL || ''}` || null
                });
                return true;
            case 'groups': {
                if (!runtime.listGroups) {
                    sendJson(res, 200, { groups: [], reason: 'Bot is offline or group listing is unavailable.' });
                    return true;
                }
                try {
                    const groups = await runtime.listGroups();
                    sendJson(res, 200, { groups });
                } catch (err) {
                    sendJson(res, 200, { groups: [], reason: err.message });
                }
                return true;
            }
            case 'owners':
                sendJson(res, 200, {
                    accounts: auth.listAccounts(),
                    configured: ownerNumbers(),
                    sessions: auth.sessionSummary()
                });
                return true;
            case 'memory':
                sendJson(res, 200, {
                    ...readAiMemory(),
                    usage: aiUsage()
                });
                return true;
            case 'ai/providers':
                sendJson(res, 200, {
                    slots: aiConfig.getSlotsPublic(),
                    order: aiConfig.getOrder(),
                    summary: aiConfig.statusSummary(),
                    fast: aiConfig.readConfig().fast,
                    detailed: aiConfig.readConfig().detailed
                });
                return true;
            case 'ai/providers/models': {
                const slot = String(url.searchParams.get('slot') || '');
                const search = String(url.searchParams.get('q') || '');
                sendJson(res, 200, await aiConfig.listModels(slot, search));
                return true;
            }
            case 'ai/contacts':
                sendJson(res, 200, { contacts: aiContacts.listContacts() });
                return true;
            case 'ai/controls':
                sendJson(res, 200, aiControls.status());
                return true;
            case 'database':
                sendJson(res, 200, dataInventory());
                return true;
            case 'logs':
                sendJson(res, 200, { events: [...events].reverse(), audit: auth.auditTail(80) });
                return true;
            default:
                return no(res, { status: 404, error: 'Unknown dashboard route.' });
        }
    }

    if (req.method === 'POST') {
        const body = await bodyJson(req);
        if (!body) return no(res, { status: 400, error: 'Invalid request body.' });

        switch (path_) {
            case 'settings/toggle': {
                const result = setToggle(String(body.key || ''), Boolean(body.value), body);
                if (!result) return no(res, { status: 400, error: 'Unknown setting.' });
                sendJson(res, 200, { ok: true, setting: result });
                return true;
            }
            case 'settings/autostatus': {
                const result = setAutoStatus(body);
                if (result && result.error) return no(res, { status: 400, error: result.error });
                sendJson(res, 200, { ok: true, autoStatus: result });
                return true;
            }
            case 'settings/mode': {
                const mode = setMode(String(body.mode || ''));
                if (!mode) return no(res, { status: 400, error: 'Mode must be public or private.' });
                sendJson(res, 200, { ok: true, mode });
                return true;
            }
            case 'vision':
            case 'settings/vision': {
                if (typeof body.enabled === 'boolean') {
                    vision.setEnabled(body.enabled);
                }
                emit('setting.vision', `vision=${vision.isEnabled() ? 'on' : 'off'}`);
                sendJson(res, 200, { ok: true, vision: vision.getStatus() });
                return true;
            }
            case 'ai': {
                const patch = {};
                const current = readAiConfig();
                if (typeof body.provider === 'string') {
                    const provider = String(body.provider).toLowerCase();
                    if (!aiProviders.PROVIDER_IDS.includes(provider)) {
                        return no(res, { status: 400, error: 'Unknown AI provider.' });
                    }
                    patch.provider = provider;
                }
                // Keys and models are stored per provider, so switching back to a
                // provider keeps its key instead of wiping it.
                const target = aiProviders.getProvider(patch.provider || current.provider);
                if (typeof body.model === 'string') {
                    if (body.model && !/^[A-Za-z0-9._:\/-]{3,120}$/.test(body.model)) {
                        return no(res, { status: 400, error: 'Invalid model name.' });
                    }
                    patch.models = { ...current.models, [target.id]: body.model.trim() };
                    if (target.id === 'openrouter') patch.model = body.model.trim();
                }
                if (typeof body.apiKey === 'string' && body.apiKey.trim()) {
                    const key = body.apiKey.trim();
                    if (!/^[A-Za-z0-9_.-]{20,}$/.test(key)) {
                        return no(res, { status: 400, error: 'That does not look like an API key.' });
                    }
                    patch.keys = { ...current.keys, [target.id]: key };
                    if (target.id === 'openrouter') patch.apiKey = key;
                }
                if (body.clearKey) {
                    patch.keys = { ...current.keys, [target.id]: '' };
                    if (target.id === 'openrouter') patch.apiKey = '';
                }
                if (typeof body.style === 'string') patch.style = body.style.slice(0, 600);
                if (typeof body.instructions === 'string') {
                    patch.instructions = body.instructions.slice(0, MAX_INSTRUCTIONS_CHARS);
                }
                if (typeof body.clearInstructions === 'boolean' && body.clearInstructions) patch.instructions = '';
                if (typeof body.personality === 'string' && AI_AGENTS.includes(body.personality)) {
                    patch.personality = body.personality;
                }
                if (typeof body.language === 'string' && ['auto', 'english', 'hindi', 'hinglish', 'bengali', 'benlish'].includes(body.language)) {
                    patch.language = body.language;
                }
                if (typeof body.fallbackReply === 'string') patch.fallbackReply = body.fallbackReply.slice(0, 200);
                if (typeof body.visionReply === 'string') patch.visionReply = body.visionReply.slice(0, 200);
                if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
                const saved = writeAiConfig(patch);
                emit('ai.config', `provider=${saved.provider} model=${resolveAiModel(saved)} key=${Boolean(resolveAiKey(saved))}`);
                sendJson(res, 200, {
                    ok: true,
                    ai: {
                        provider: saved.provider,
                        model: resolveAiModel(saved),
                        keyConfigured: Boolean(resolveAiKey(saved)),
                        maskedKey: maskKey(resolveAiKey(saved)),
                        enabled: saved.enabled,
                        style: saved.style,
                        instructions: saved.instructions,
                        personality: saved.personality
                    }
                });
                return true;
            }
            case 'ai/test': {
                const result = await testAi(body.prompt, body.slot ? { slot: String(body.slot) } : {});
                sendJson(res, result.ok ? 200 : 502, result);
                return true;
            }
            case 'ai/providers': {
                const slot = String(body.slot || '').toLowerCase();
                if (!aiConfig.SLOT_IDS.includes(slot)) {
                    return no(res, { status: 400, error: 'Slot must be primary, fallback1 or fallback2.' });
                }
                const result = aiConfig.saveSlot(slot, {
                    provider: body.provider,
                    baseUrl: body.baseUrl,
                    model: body.model,
                    apiKey: body.apiKey,
                    clearKey: body.clearKey,
                    vision: typeof body.vision === 'boolean' ? body.vision : undefined,
                    enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
                    label: body.label
                });
                if (!result.ok) return no(res, { status: 400, error: result.error });
                emit('ai.provider', `${slot} saved`);
                sendJson(res, 200, {
                    ok: true,
                    slot: result.slot,
                    order: result.order,
                    summary: aiConfig.statusSummary()
                });
                return true;
            }
            case 'ai/providers/order': {
                const result = aiConfig.setOrder(body.order);
                if (!result.ok) return no(res, { status: 400, error: result.error });
                emit('ai.provider', `order=${result.order.join(',')}`);
                sendJson(res, 200, { ok: true, order: result.order, summary: aiConfig.statusSummary() });
                return true;
            }
            case 'ai/providers/test': {
                const slot = String(body.slot || '').toLowerCase();
                if (!aiConfig.SLOT_IDS.includes(slot)) {
                    return no(res, { status: 400, error: 'Slot must be primary, fallback1 or fallback2.' });
                }
                const result = await aiConfig.testSlot(slot, body.prompt, {
                    provider: body.provider,
                    baseUrl: body.baseUrl,
                    model: body.model,
                    apiKey: body.apiKey
                });
                sendJson(res, result.ok ? 200 : 502, result);
                return true;
            }
            case 'ai/controls': {
                const action = String(body.action || '').toLowerCase();
                if (action === 'pause') {
                    const result = aiControls.pause(body.duration);
                    if (!result.ok) return no(res, { status: 400, error: result.error });
                    emit('ai.controls', `paused for ${aiControls.humanDuration(result.ms)}`);
                    sendJson(res, 200, { ok: true, pauseUntil: result.pauseUntil, controls: aiControls.status() });
                    return true;
                }
                if (action === 'resume') {
                    aiControls.resume();
                    if (body.id) {
                        const contact = aiContacts.findContact(String(body.id));
                        if (contact) aiControls.clearHandoff(contact.chatId);
                    }
                    emit('ai.controls', 'resumed');
                    sendJson(res, 200, { ok: true, controls: aiControls.status() });
                    return true;
                }
                const patch = {};
                if (body.quietHours && typeof body.quietHours === 'object') {
                    const current = aiControls.readControls().quietHours;
                    const start = body.quietHours.start !== undefined ? String(body.quietHours.start) : current.start;
                    const end = body.quietHours.end !== undefined ? String(body.quietHours.end) : current.end;
                    if (!aiControls.validClock(start) || !aiControls.validClock(end) || start === end) {
                        return no(res, { status: 400, error: 'Quiet hours need two different HH:MM times.' });
                    }
                    patch.quietHours = {
                        enabled: typeof body.quietHours.enabled === 'boolean' ? body.quietHours.enabled : current.enabled,
                        start,
                        end,
                        timezone: current.timezone
                    };
                }
                if (body.sensitiveMode !== undefined) {
                    if (!aiControls.SENSITIVE_MODES.includes(body.sensitiveMode)) {
                        return no(res, { status: 400, error: 'sensitiveMode must be hold or off.' });
                    }
                    patch.sensitiveMode = body.sensitiveMode;
                }
                if (typeof body.notifyOwner === 'boolean') patch.notifyOwner = body.notifyOwner;
                if (body.handoffMinutes !== undefined) {
                    const minutes = Number(body.handoffMinutes);
                    if (!Number.isFinite(minutes) || minutes < 0 || minutes > aiControls.MAX_HANDOFF_MINUTES) {
                        return no(res, { status: 400, error: 'handoffMinutes must be between 0 and 1440.' });
                    }
                    patch.handoffMinutes = Math.round(minutes);
                }
                if (body.defaultDelaySec !== undefined) {
                    const delay = Number(body.defaultDelaySec);
                    if (!Number.isFinite(delay) || delay < 0 || delay > aiControls.MAX_DELAY_SEC) {
                        return no(res, { status: 400, error: `defaultDelaySec must be 0-${aiControls.MAX_DELAY_SEC}.` });
                    }
                    patch.defaultDelaySec = Math.round(delay);
                }
                if (body.neverAdd) {
                    const result = aiControls.addNever(body.neverAdd);
                    if (!result.ok) return no(res, { status: 400, error: result.error });
                }
                if (body.neverRemove) aiControls.removeNever(body.neverRemove);
                if (body.clearNever === true) patch.neverReply = [];
                const saved = aiControls.saveControls(patch);
                emit('ai.controls', `quiet=${saved.quietHours.enabled} guard=${saved.sensitiveMode} handoff=${saved.handoffMinutes}m`);
                sendJson(res, 200, { ok: true, controls: aiControls.status() });
                return true;
            }
            case 'ai/contacts/settings': {
                const contact = aiContacts.findContact(String(body.id || ''));
                if (!contact) return no(res, { status: 404, error: 'No stored contact matches that id.' });
                const result = aiControls.configureContact(contact.chatId, {
                    autoReply: body.autoReply,
                    never: typeof body.never === 'boolean' ? body.never : undefined,
                    tone: body.tone,
                    language: body.language,
                    delaySec: body.delaySec === undefined ? undefined : body.delaySec === null ? null : Number(body.delaySec),
                    reset: body.reset === true
                });
                if (!result.ok) return no(res, { status: 400, error: result.error });
                emit('ai.contact', `rules updated for ${contact.chatId}`);
                sendJson(res, 200, { ok: true, contact: aiContacts.listContacts().find((entry) => entry.chatId === contact.chatId) });
                return true;
            }
            case 'ai/contacts/delete': {
                if (body.all === true) {
                    aiContacts.clearContacts();
                    emit('ai.contacts', 'all contact memories cleared');
                    sendJson(res, 200, { ok: true, removed: 'all' });
                    return true;
                }
                const result = aiContacts.deleteContactBy(String(body.id || ''));
                if (!result.ok) return no(res, { status: 404, error: result.reason });
                emit('ai.contacts', `contact memory removed (${result.removed})`);
                sendJson(res, 200, { ok: true, removed: result.removed });
                return true;
            }
            case 'autoreply': {
                const patch = {};
                if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
                if (typeof body.mode === 'string') {
                    if (!['off', 'private', 'group', 'all'].includes(body.mode)) {
                        return no(res, { status: 400, error: 'Mode must be off, private, group or all.' });
                    }
                    patch.mode = body.mode;
                    if (body.mode === 'off') patch.enabled = false;
                }
                if (Array.isArray(body.allowlist)) patch.allowlist = body.allowlist.map((v) => String(v).replace(/[^0-9]/g, '')).filter(Boolean).slice(0, 200);
                if (Array.isArray(body.blocked)) patch.blocked = body.blocked.map((v) => String(v).replace(/[^0-9]/g, '')).filter(Boolean).slice(0, 200);
                if (Number.isFinite(Number(body.cooldownSec))) patch.cooldownSec = Math.min(120, Math.max(0, Number(body.cooldownSec)));
                const saved = writeAiConfig(patch);
                emit('autoreply.config', `mode=${saved.mode} enabled=${saved.enabled}`);
                sendJson(res, 200, {
                    ok: true,
                    autoreply: {
                        enabled: saved.enabled,
                        mode: saved.mode,
                        allowlist: saved.allowlist,
                        blocked: saved.blocked,
                        cooldownSec: saved.cooldownSec
                    }
                });
                return true;
            }
            case 'commands/toggle': {
                const name = String(body.name || '').replace(/[^a-zA-Z0-9_-]/g, '');
                const result = toggleCommand(name, Boolean(body.enabled));
                if (!result) return no(res, { status: 400, error: 'Unknown command.' });
                sendJson(res, 200, { ok: true, command: result });
                return true;
            }
            case 'memory/clear':
                clearAiMemory();
                sendJson(res, 200, { ok: true });
                return true;
            case 'connection/action': {
                const action = String(body.action || '');
                if (body.confirm !== true) return no(res, { status: 400, error: 'Confirmation required.' });
                if (action === 'disconnect') {
                    if (!runtime.disconnect) return no(res, { status: 501, error: 'This server cannot disconnect the bot.' });
                    await runtime.disconnect();
                    emit('connection.disconnect', 'bot disconnected from the dashboard', 'warn');
                    sendJson(res, 200, { ok: true, message: 'Disconnecting…' });
                    return true;
                }
                if (action === 'reconnect') {
                    if (!runtime.reconnect) return no(res, { status: 501, error: 'This server cannot reconnect the bot.' });
                    await runtime.reconnect();
                    emit('connection.reconnect', 'reconnect requested from the dashboard', 'warn');
                    sendJson(res, 200, { ok: true, message: 'Reconnecting…' });
                    return true;
                }
                return no(res, { status: 400, error: 'Unknown action.' });
            }
            case 'owners/reset-password': {
                const number = String(body.number || '').replace(/[^0-9]/g, '');
                if (!ownerNumbers().includes(number)) return no(res, { status: 400, error: 'Not an authorized owner number.' });
                const sock = runtime.getSocket ? runtime.getSocket() : null;
                if (!sock) return no(res, { status: 503, error: 'Bot is offline — the password can only be delivered over WhatsApp.' });
                const provisioned = auth.provisionOwnerAccount(number);
                if (!provisioned) return no(res, { status: 400, error: 'Could not provision that number.' });
                try {
                    await sock.sendMessage(`${number}@s.whatsapp.net`, {
                        text: `🔐 *Lily MD dashboard password*\n\nOwner: ${number}\nTemporary password: *${provisioned.tempPassword}*\n\nSign in at the dashboard and change it immediately. If you did not ask for this, tell the other owner.`
                    });
                } catch (err) {
                    return no(res, { status: 502, error: `Could not send the password: ${err.message}` });
                }
                emit('owner.reset', `temporary password sent to ${number}`, 'warn');
                sendJson(res, 200, { ok: true, message: 'Temporary password sent to that WhatsApp number.' });
                return true;
            }
            case 'sessions/revoke': {
                const id = String(body.id || '');
                if (!id || id.length < 6) return no(res, { status: 400, error: 'Session id required.' });
                const removed = auth.revokeSession(id);
                sendJson(res, 200, { ok: true, removed });
                return true;
            }
            default:
                return no(res, { status: 404, error: 'Unknown dashboard route.' });
        }
    }

    return no(res, { status: 405, error: 'Method not allowed.' });
}

/** Server-Sent Events: one initial snapshot, then status every 5s. */
function handleEvents(req, res) {
    const current = auth.requireOwner(req);
    if (!current.ok) {
        sendJson(res, current.status || 401, { error: current.error });
        return true;
    }
    res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no'
    });

    const send = () => {
        try {
            res.write(`event: status\ndata: ${JSON.stringify(status())}\n\n`);
        } catch {
            // client gone
        }
    };
    send();
    const timer = setInterval(send, 5000);
    const ping = setInterval(() => {
        try {
            res.write(': ping\n\n');
        } catch {}
    }, 20000);
    req.on('close', () => {
        clearInterval(timer);
        clearInterval(ping);
    });
    return true;
}

module.exports = {
    handleApi,
    handleEvents,
    setRuntime,
    getRuntime: () => runtime,
    status,
    emit,
    listCommands,
    testAi,
    maskKey,
    settingsSnapshot,
    setToggle
};
