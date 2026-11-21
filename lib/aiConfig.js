'use strict';
/**
 * Three configurable AI providers with ordered failover, multi-model support,
 * multiple API keys per provider/model, and automatic intelligent key rotation.
 *
 * Supported providers:
 *   1. Google Gemini (gemini)
 *   2. Groq (groq)
 *   3. Custom OpenAI-compatible API (custom)
 *
 * Hierarchy:
 *   Provider → Model → Multiple API Keys
 *
 * Files:
 *   config/aiProviders.json   non-secret settings (priority, models, base URLs,
 *                             token/timeout budgets, order)
 *   data/aiProviders.json     API keys only (gitignored, never logged/served, 0600)
 *
 * Safe diagnostics only — an API key is never written to a log, an error
 * message or the dashboard payload.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const aiProviders = require('./aiProviders');

const ROOT = path.join(__dirname, '..');
const CONFIG_FILE = path.join(ROOT, 'config', 'aiProviders.json');
const KEYS_FILE = path.join(ROOT, 'data', 'aiProviders.json');
const LEGACY_FILE = path.join(ROOT, 'data', 'aiAutoReply.json');

const SLOT_IDS = ['primary', 'fallback1', 'fallback2'];
const SLOT_LABELS = { primary: 'Primary', fallback1: 'Fallback 1', fallback2: 'Fallback 2' };

const FAST = { maxTokens: 320, timeoutMs: 22000 };
const DETAILED = { maxTokens: 1100, timeoutMs: 90000 };
const TEST_MAX_TOKENS = 200;
const TEST_TIMEOUT_MS = 45000;
const DEFAULT_COOLDOWN_MS = 60000; // 60 seconds rate limit cooldown

const DEFAULT_PROVIDERS = {
    groq: {
        id: 'groq',
        label: 'Groq',
        enabled: true,
        baseUrl: 'https://api.groq.com/openai/v1',
        models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'],
        vision: false
    },
    gemini: {
        id: 'gemini',
        label: 'Google Gemini',
        enabled: true,
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        models: ['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-pro'],
        vision: true
    },
    custom: {
        id: 'custom',
        label: 'Custom (OpenAI-compatible)',
        enabled: false,
        baseUrl: '',
        models: [],
        vision: false
    }
};

const DEFAULT_PRIORITY = ['groq', 'gemini', 'custom'];

const DEFAULT_SLOTS = [
    {
        id: 'primary',
        label: SLOT_LABELS.primary,
        provider: 'groq',
        baseUrl: 'https://api.groq.com/openai/v1',
        model: 'llama-3.3-70b-versatile',
        apiKeyEnv: 'AI_PRIMARY_API_KEY',
        vision: false,
        enabled: true
    },
    {
        id: 'fallback1',
        label: SLOT_LABELS.fallback1,
        provider: 'gemini',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        model: 'gemini-2.0-flash',
        apiKeyEnv: 'AI_FALLBACK_1_API_KEY',
        vision: true,
        enabled: false
    },
    {
        id: 'fallback2',
        label: SLOT_LABELS.fallback2,
        provider: 'custom',
        baseUrl: '',
        model: '',
        apiKeyEnv: 'AI_FALLBACK_2_API_KEY',
        vision: false,
        enabled: false
    }
];

// In-memory key rate-limit cooldown tracking: keyHash -> timestamp
const keyCooldowns = new Map();
// Key health statistics: keyHash -> { attempts, successes, rateLimits, lastError, lastUsed }
const keyStats = new Map();

function hashKey(key) {
    if (!key) return '';
    return crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 16);
}

function readJsonFile(file, fallback) {
    try {
        if (!fs.existsSync(file)) return fallback;
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        return data && typeof data === 'object' ? data : fallback;
    } catch {
        return fallback;
    }
}

function writeJsonFile(file, data) {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const temp = `${file}.tmp-${process.pid}`;
        fs.writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
        fs.renameSync(temp, file);
        try {
            fs.chmodSync(file, 0o600);
        } catch {}
        return true;
    } catch (err) {
        console.error('[aiConfig] could not save', path.basename(file), err.message);
        return false;
    }
}

function maskKey(key) {
    const value = String(key || '').trim();
    if (!value) return '';
    if (value.startsWith('gsk_')) {
        return `gsk_${value.slice(4, 8)}…${value.slice(-4)}`;
    }
    if (value.startsWith('AIza')) {
        return `AIza${value.slice(4, 8)}…${value.slice(-4)}`;
    }
    if (value.length <= 14) return '••••';
    return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function cleanModel(value) {
    return String(value || '').trim().slice(0, 160);
}

function validModelId(value) {
    return !value || /^[A-Za-z0-9._:\/-]{2,160}$/.test(value);
}

function validBaseUrl(value) {
    if (!value) return true;
    if (!/^https?:\/\//i.test(value)) return false;
    try {
        const url = new URL(value);
        return Boolean(url.hostname) && !/\s/.test(value);
    } catch {
        return false;
    }
}

function normaliseBaseUrl(value) {
    return String(value || '').trim().replace(/\/+$/, '');
}

/* ------------------------------------------------------------------ config */

function defaultConfig() {
    return {
        version: 2,
        providerPriority: DEFAULT_PRIORITY.slice(),
        providers: {
            groq: { ...DEFAULT_PROVIDERS.groq, models: DEFAULT_PROVIDERS.groq.models.slice() },
            gemini: { ...DEFAULT_PROVIDERS.gemini, models: DEFAULT_PROVIDERS.gemini.models.slice() },
            custom: { ...DEFAULT_PROVIDERS.custom, models: DEFAULT_PROVIDERS.custom.models.slice() }
        },
        maxTokens: 800,
        timeoutMs: 35000,
        historyLimit: 10,
        order: SLOT_IDS.slice(),
        fast: { ...FAST },
        detailed: { ...DETAILED },
        slots: DEFAULT_SLOTS.map((slot) => ({ ...slot }))
    };
}

function normaliseSlot(raw, fallback) {
    const slot = raw && typeof raw === 'object' ? raw : {};
    const base = fallback || {};
    const providerId = aiProviders.PROVIDER_IDS.includes(String(slot.provider || '').toLowerCase())
        ? String(slot.provider).toLowerCase()
        : base.provider || 'custom';
    const provider = aiProviders.getProvider(providerId);
    return {
        id: base.id,
        label: String(slot.label || base.label || SLOT_LABELS[base.id] || base.id).slice(0, 40),
        provider: providerId,
        baseUrl: normaliseBaseUrl(slot.baseUrl !== undefined ? slot.baseUrl : base.baseUrl || provider.baseUrl),
        model: cleanModel(slot.model !== undefined ? slot.model : base.model || provider.defaultModel),
        apiKeyEnv: String(slot.apiKeyEnv || base.apiKeyEnv || `AI_${String(base.id || 'slot').toUpperCase()}_API_KEY`).slice(0, 60),
        vision: typeof slot.vision === 'boolean' ? slot.vision : Boolean(base.vision || provider.vision),
        enabled: typeof slot.enabled === 'boolean' ? slot.enabled : Boolean(base.enabled)
    };
}

function readConfig() {
    const data = readJsonFile(CONFIG_FILE, null);
    const config = defaultConfig();
    if (!data) return config;

    if (Array.isArray(data.providerPriority)) {
        const list = data.providerPriority
            .map((p) => String(p).toLowerCase().trim())
            .filter((p) => aiProviders.PROVIDER_IDS.includes(p));
        if (list.length) {
            for (const p of aiProviders.PROVIDER_IDS) {
                if (!list.includes(p)) list.push(p);
            }
            config.providerPriority = list;
        }
    }

    if (data.providers && typeof data.providers === 'object') {
        for (const p of aiProviders.PROVIDER_IDS) {
            if (data.providers[p]) {
                const prov = data.providers[p];
                config.providers[p] = {
                    ...config.providers[p],
                    enabled: typeof prov.enabled === 'boolean' ? prov.enabled : config.providers[p].enabled,
                    baseUrl: prov.baseUrl !== undefined ? normaliseBaseUrl(prov.baseUrl) : config.providers[p].baseUrl,
                    models: Array.isArray(prov.models)
                        ? prov.models.map(cleanModel).filter(Boolean)
                        : config.providers[p].models,
                    vision: typeof prov.vision === 'boolean' ? prov.vision : config.providers[p].vision
                };
            }
        }
    }

    if (Number(data.maxTokens) > 0) config.maxTokens = Number(data.maxTokens);
    if (Number(data.timeoutMs) > 0) config.timeoutMs = Number(data.timeoutMs);
    if (Number(data.historyLimit) > 0) config.historyLimit = Number(data.historyLimit);

    if (Array.isArray(data.order)) {
        const order = data.order.map((id) => String(id)).filter((id) => SLOT_IDS.includes(id));
        for (const id of SLOT_IDS) if (!order.includes(id)) order.push(id);
        config.order = order;
    }
    if (data.fast && typeof data.fast === 'object') {
        config.fast = {
            maxTokens: Number(data.fast.maxTokens) > 0 ? Number(data.fast.maxTokens) : FAST.maxTokens,
            timeoutMs: Number(data.fast.timeoutMs) > 0 ? Number(data.fast.timeoutMs) : FAST.timeoutMs
        };
    }
    if (data.detailed && typeof data.detailed === 'object') {
        config.detailed = {
            maxTokens: Number(data.detailed.maxTokens) > 0 ? Number(data.detailed.maxTokens) : DETAILED.maxTokens,
            timeoutMs: Number(data.detailed.timeoutMs) > 0 ? Number(data.detailed.timeoutMs) : DETAILED.timeoutMs
        };
    }
    if (Array.isArray(data.slots)) {
        config.slots = SLOT_IDS.map((id) => {
            const fallback = DEFAULT_SLOTS.find((slot) => slot.id === id);
            const raw = data.slots.find((slot) => slot && String(slot.id || '').toLowerCase() === id) || {};
            return normaliseSlot(raw, fallback);
        });
    }

    return config;
}

function writeConfig(config) {
    return writeJsonFile(CONFIG_FILE, {
        version: 2,
        providerPriority: config.providerPriority || DEFAULT_PRIORITY,
        providers: config.providers,
        maxTokens: config.maxTokens,
        timeoutMs: config.timeoutMs,
        historyLimit: config.historyLimit,
        order: config.order,
        fast: config.fast,
        detailed: config.detailed,
        slots: config.slots
    });
}

/* ------------------------------------------------------------------ keys */

function readKeys() {
    const data = readJsonFile(KEYS_FILE, {});
    const result = {
        keys: { groq: [], gemini: [], custom: [] },
        slots: {},
        slotProviders: data.slotProviders && typeof data.slotProviders === 'object' ? { ...data.slotProviders } : {}
    };

    // Normalize slot keys (legacy compatibility)
    if (data.keys && typeof data.keys === 'object' && !Array.isArray(data.keys.groq)) {
        for (const id of SLOT_IDS) {
            const val = String(data.keys[id] || '').trim();
            if (val) result.slots[id] = val;
        }
    }
    if (data.slots && typeof data.slots === 'object') {
        for (const id of SLOT_IDS) {
            const val = String(data.slots[id] || '').trim();
            if (val) result.slots[id] = val;
        }
    }

    // Provider multi-keys
    const rawKeys = data.providerKeys || (data.keys && typeof data.keys === 'object' && Array.isArray(data.keys.groq) ? data.keys : {});
    for (const p of aiProviders.PROVIDER_IDS) {
        if (Array.isArray(rawKeys[p])) {
            result.keys[p] = rawKeys[p]
                .filter((item) => item && typeof item.key === 'string' && item.key.trim())
                .map((item, idx) => ({
                    id: String(item.id || `k${idx + 1}`).slice(0, 32),
                    key: String(item.key).trim(),
                    model: cleanModel(item.model),
                    label: String(item.label || `Key ${idx + 1}`).slice(0, 40),
                    addedAt: item.addedAt || new Date().toISOString(),
                    rateLimitedUntil: Number(item.rateLimitedUntil) || 0,
                    failureCount: Number(item.failureCount) || 0,
                    lastUsed: item.lastUsed || null,
                    lastError: item.lastError ? String(item.lastError).slice(0, 200) : null
                }));
        }
    }

    return result;
}

function writeKeys(store) {
    const payload = {
        version: 2,
        slots: store.slots || {},
        slotProviders: store.slotProviders || {},
        keys: store.slots || {}, // legacy compatibility for test assertions
        providerKeys: store.keys || { groq: [], gemini: [], custom: [] },
        updatedAt: new Date().toISOString()
    };
    return writeJsonFile(KEYS_FILE, payload);
}

function getSlot(id) {
    const wanted = String(id || '').toLowerCase();
    return readConfig().slots.find((slot) => slot.id === wanted) || null;
}

function getOrder() {
    return readConfig().order.slice();
}

function getPriority() {
    return readConfig().providerPriority.slice();
}

function setPriority(list) {
    if (!Array.isArray(list) || !list.length) return { ok: false, error: 'Priority must be a list of providers.' };
    const clean = list.map((p) => String(p).toLowerCase().trim()).filter(Boolean);
    for (const p of clean) {
        if (!aiProviders.PROVIDER_IDS.includes(p)) {
            return { ok: false, error: `Invalid provider "${p}". Supported: gemini, groq, custom.` };
        }
    }
    const next = [];
    for (const p of clean) if (!next.includes(p)) next.push(p);
    for (const p of aiProviders.PROVIDER_IDS) if (!next.includes(p)) next.push(p);

    const config = readConfig();
    config.providerPriority = next;

    // Update slots so primary/fallback1/fallback2 reflect provider priority
    const store = readKeys();
    if (!store.slotProviders) store.slotProviders = {};
    config.slots = next.slice(0, 3).map((providerId, index) => {
        const slotId = SLOT_IDS[index];
        const existing = config.slots.find((s) => s.id === slotId);
        const prov = aiProviders.getProvider(providerId);
        const provConfig = config.providers[providerId] || {};
        const baseUrl = provConfig.baseUrl || prov.baseUrl || '';
        const isEnabled = providerId === 'custom' ? Boolean(baseUrl) : (typeof provConfig.enabled === 'boolean' ? provConfig.enabled : true);
        if (store.slotProviders[slotId] && store.slotProviders[slotId] !== providerId) {
            delete store.slots[slotId];
        }
        store.slotProviders[slotId] = providerId;
        return {
            id: slotId,
            label: SLOT_LABELS[slotId],
            provider: providerId,
            baseUrl,
            model: (provConfig.models && provConfig.models[0]) || prov.defaultModel || '',
            apiKeyEnv: existing?.apiKeyEnv || `AI_${slotId.toUpperCase()}_API_KEY`,
            vision: Boolean(provConfig.vision ?? prov.vision),
            enabled: isEnabled
        };
    });
    writeKeys(store);

    if (!writeConfig(config)) return { ok: false, error: 'Could not save priority configuration.' };
    return { ok: true, priority: next };
}

/* ---------------------------------------------------- Provider & Model Management */

function getModels(providerId) {
    const config = readConfig();
    const p = String(providerId || '').toLowerCase();
    const prov = config.providers[p];
    if (prov && Array.isArray(prov.models) && prov.models.length) {
        return prov.models.slice();
    }
    const def = aiProviders.getProvider(p);
    return def.defaultModels ? def.defaultModels.slice() : (def.defaultModel ? [def.defaultModel] : []);
}

function addModel(providerId, model) {
    const p = String(providerId || '').toLowerCase();
    if (!aiProviders.PROVIDER_IDS.includes(p)) {
        return { ok: false, error: `Unknown provider "${p}". Supported: gemini, groq, custom.` };
    }
    const clean = cleanModel(model);
    if (!validModelId(clean) || !clean) return { ok: false, error: 'Invalid model ID.' };

    const config = readConfig();
    if (!config.providers[p]) config.providers[p] = { ...DEFAULT_PROVIDERS[p], models: [] };
    const current = config.providers[p].models || [];
    if (!current.includes(clean)) {
        current.push(clean);
        config.providers[p].models = current;
    }
    // Also update slot model if slot uses this provider
    for (const slot of config.slots) {
        if (slot.provider === p && !slot.model) slot.model = clean;
    }
    if (!writeConfig(config)) return { ok: false, error: 'Could not save model configuration.' };
    return { ok: true, provider: p, models: config.providers[p].models };
}

function removeModel(providerId, model) {
    const p = String(providerId || '').toLowerCase();
    if (!aiProviders.PROVIDER_IDS.includes(p)) {
        return { ok: false, error: `Unknown provider "${p}". Supported: gemini, groq, custom.` };
    }
    const clean = cleanModel(model);
    const config = readConfig();
    if (!config.providers[p]) return { ok: true, provider: p, models: [] };
    config.providers[p].models = (config.providers[p].models || []).filter((m) => m !== clean);
    writeConfig(config);
    return { ok: true, provider: p, models: config.providers[p].models };
}

function setModels(providerId, models) {
    const p = String(providerId || '').toLowerCase();
    if (!aiProviders.PROVIDER_IDS.includes(p)) {
        return { ok: false, error: `Unknown provider "${p}". Supported: gemini, groq, custom.` };
    }
    if (!Array.isArray(models)) return { ok: false, error: 'Models must be an array.' };
    const cleanList = models.map(cleanModel).filter(validModelId).filter(Boolean);
    const config = readConfig();
    if (!config.providers[p]) config.providers[p] = { ...DEFAULT_PROVIDERS[p], models: [] };
    config.providers[p].models = cleanList;
    writeConfig(config);
    return { ok: true, provider: p, models: cleanList };
}

function setBaseUrl(providerId, url) {
    const p = String(providerId || '').toLowerCase();
    if (!aiProviders.PROVIDER_IDS.includes(p)) {
        return { ok: false, error: `Unknown provider "${p}".` };
    }
    const clean = normaliseBaseUrl(url);
    if (!validBaseUrl(clean)) return { ok: false, error: 'Base URL must be a valid http(s) URL.' };

    const config = readConfig();
    if (!config.providers[p]) config.providers[p] = { ...DEFAULT_PROVIDERS[p] };
    config.providers[p].baseUrl = clean;
    if (clean) config.providers[p].enabled = true;
    for (const slot of config.slots) {
        if (slot.provider === p) {
            slot.baseUrl = clean;
            if (clean) slot.enabled = true;
        }
    }
    writeConfig(config);
    return { ok: true, provider: p, baseUrl: clean };
}

/* ---------------------------------------------------- Multi-Key Management */

function generateKeyId(providerId) {
    return `${providerId.slice(0, 3)}_${crypto.randomBytes(3).toString('hex')}`;
}

function addKey(providerId, apiKey, options = {}) {
    const p = String(providerId || '').toLowerCase();
    if (!aiProviders.PROVIDER_IDS.includes(p)) {
        return { ok: false, error: `Unknown provider "${p}". Supported: gemini, groq, custom.` };
    }
    const key = String(apiKey || '').trim();
    if (key.length < 6 || key.length > 300 || /\s/.test(key)) {
        return { ok: false, error: 'That does not look like a valid API key.' };
    }

    const store = readKeys();
    if (!store.keys[p]) store.keys[p] = [];

    // Check duplicate
    const existing = store.keys[p].find((k) => k.key === key);
    if (existing) {
        if (options.model !== undefined) existing.model = cleanModel(options.model);
        if (options.label) existing.label = String(options.label).slice(0, 40);
        writeKeys(store);
        return { ok: true, id: existing.id, maskedKey: maskKey(key), provider: p, reused: true };
    }

    const keyId = options.id || generateKeyId(p);
    const keyEntry = {
        id: keyId,
        key,
        model: cleanModel(options.model),
        label: String(options.label || `Key ${store.keys[p].length + 1}`).slice(0, 40),
        addedAt: new Date().toISOString(),
        rateLimitedUntil: 0,
        failureCount: 0,
        lastUsed: null,
        lastError: null
    };

    store.keys[p].push(keyEntry);

    // Also populate legacy slot key if slot matches
    for (const id of SLOT_IDS) {
        const slot = getSlot(id);
        if (slot && slot.provider === p && !store.slots[id]) {
            store.slots[id] = key;
        }
    }

    if (!writeKeys(store)) return { ok: false, error: 'Could not store API key.' };
    return { ok: true, id: keyId, maskedKey: maskKey(key), provider: p, model: keyEntry.model };
}

function removeKey(providerId, keyId) {
    const p = String(providerId || '').toLowerCase();
    if (!aiProviders.PROVIDER_IDS.includes(p)) {
        return { ok: false, error: `Unknown provider "${p}".` };
    }
    const target = String(keyId || '').trim().toLowerCase();
    const store = readKeys();
    if (!store.keys[p] || !store.keys[p].length) return { ok: false, error: 'No keys configured for this provider.' };

    const initialLen = store.keys[p].length;
    // Allow matching by id, masked key prefix, or 1-based index
    const index = parseInt(target, 10);
    if (!isNaN(index) && index >= 1 && index <= store.keys[p].length) {
        const removed = store.keys[p].splice(index - 1, 1)[0];
        writeKeys(store);
        return { ok: true, removedId: removed.id };
    }

    store.keys[p] = store.keys[p].filter((k) => k.id.toLowerCase() !== target && !maskKey(k.key).toLowerCase().includes(target));
    if (store.keys[p].length === initialLen) {
        return { ok: false, error: `Key "${keyId}" not found.` };
    }

    writeKeys(store);
    return { ok: true, removedId: keyId };
}

function editKey(providerId, keyId, patch = {}) {
    const p = String(providerId || '').toLowerCase();
    const target = String(keyId || '').trim().toLowerCase();
    const store = readKeys();
    const keyObj = (store.keys[p] || []).find((k) => k.id.toLowerCase() === target);
    if (!keyObj) return { ok: false, error: `Key "${keyId}" not found.` };

    if (patch.model !== undefined) keyObj.model = cleanModel(patch.model);
    if (patch.label !== undefined) keyObj.label = String(patch.label).slice(0, 40);
    if (patch.key && String(patch.key).trim()) {
        const newKey = String(patch.key).trim();
        if (newKey.length < 6 || newKey.length > 300 || /\s/.test(newKey)) {
            return { ok: false, error: 'Invalid API key format.' };
        }
        keyObj.key = newKey;
    }
    writeKeys(store);
    return { ok: true, key: { id: keyObj.id, maskedKey: maskKey(keyObj.key), model: keyObj.model, label: keyObj.label } };
}

function getKeysPublic(providerId) {
    const p = String(providerId || '').toLowerCase();
    const store = readKeys();
    const list = store.keys[p] || [];
    const now = Date.now();

    return list.map((k) => {
        const hash = hashKey(k.key);
        const inMemCooldown = keyCooldowns.get(hash) || 0;
        const until = Math.max(k.rateLimitedUntil || 0, inMemCooldown);
        const coolingDown = now < until;
        const cooldownRemainingMs = coolingDown ? until - now : 0;
        const stats = keyStats.get(hash) || {};

        return {
            id: k.id,
            maskedKey: maskKey(k.key),
            model: k.model || '(all models)',
            label: k.label,
            addedAt: k.addedAt,
            coolingDown,
            cooldownRemainingSec: Math.ceil(cooldownRemainingMs / 1000),
            failureCount: k.failureCount || 0,
            lastUsed: k.lastUsed || stats.lastUsed || null,
            lastError: k.lastError || stats.lastError || null
        };
    });
}

function getProviderHealth(providerId) {
    const p = String(providerId || '').toLowerCase();
    const keys = getKeysPublic(p);
    const totalKeys = keys.length;
    const coolingDownKeys = keys.filter((k) => k.coolingDown).length;
    const readyKeys = totalKeys - coolingDownKeys;

    let status = 'no_keys';
    if (totalKeys > 0) {
        if (readyKeys > 0) status = 'healthy';
        else status = 'rate_limited';
    }

    return {
        provider: p,
        totalKeys,
        readyKeys,
        coolingDownKeys,
        status,
        models: getModels(p)
    };
}

/* ---------------------------------------------------- Candidate Key Resolution */

function isKeyInCooldown(key) {
    const now = Date.now();
    const hash = hashKey(key);
    const cooldownEnd = keyCooldowns.get(hash) || 0;
    return now < cooldownEnd;
}

function markKeyRateLimited(key, cooldownMs = DEFAULT_COOLDOWN_MS) {
    const now = Date.now();
    const until = now + cooldownMs;
    const hash = hashKey(key);
    keyCooldowns.set(hash, until);

    const stats = keyStats.get(hash) || { attempts: 0, successes: 0, rateLimits: 0 };
    stats.rateLimits = (stats.rateLimits || 0) + 1;
    stats.lastError = '429 rate limited';
    keyStats.set(hash, stats);

    // Update in-file record asynchronously
    try {
        const store = readKeys();
        for (const p of aiProviders.PROVIDER_IDS) {
            const match = (store.keys[p] || []).find((k) => k.key === key);
            if (match) {
                match.rateLimitedUntil = until;
                match.lastError = '429 rate limited';
                writeKeys(store);
                break;
            }
        }
    } catch {}
}

function markKeySuccess(key) {
    const hash = hashKey(key);
    const stats = keyStats.get(hash) || { attempts: 0, successes: 0, rateLimits: 0 };
    stats.successes = (stats.successes || 0) + 1;
    stats.lastUsed = new Date().toISOString();
    keyStats.set(hash, stats);
}

function markKeyInvalid(key, errorMsg) {
    const hash = hashKey(key);
    const stats = keyStats.get(hash) || { attempts: 0, successes: 0, rateLimits: 0 };
    stats.lastError = errorMsg || 'invalid API key';
    keyStats.set(hash, stats);
}

function clearCooldowns() {
    keyCooldowns.clear();
    try {
        const store = readKeys();
        for (const p of aiProviders.PROVIDER_IDS) {
            for (const k of store.keys[p] || []) {
                k.rateLimitedUntil = 0;
            }
        }
        writeKeys(store);
    } catch {}
}

/**
 * Returns candidate keys for a provider + model combination:
 * Specific keys for this model, generic keys for this provider, plus env keys.
 */
function getCandidateKeys(providerId, model, targetSlot = null) {
    const p = String(providerId || '').toLowerCase();
    const store = readKeys();
    const provKeys = store.keys[p] || [];
    const keys = [];
    const seen = new Set();

    // 1. If targetSlot has an explicit apiKey, it is primary for this slot (if provider matches)
    if (targetSlot && targetSlot.apiKey && (targetSlot.provider === p || targetSlot.providerId === p)) {
        keys.push({ id: `slot_${targetSlot.id}`, key: targetSlot.apiKey, model: targetSlot.model, label: targetSlot.label });
        seen.add(targetSlot.apiKey);
    }

    // 2. Model-specific keys first
    for (const k of provKeys) {
        if (p === 'custom' && targetSlot && targetSlot.baseUrl && k.baseUrl && k.baseUrl !== targetSlot.baseUrl) {
            continue;
        }
        if (k.model && model && k.model.toLowerCase() === model.toLowerCase() && !seen.has(k.key)) {
            keys.push(k);
            seen.add(k.key);
        }
    }

    // 3. Provider-wide keys (no model restriction)
    for (const k of provKeys) {
        if (p === 'custom' && targetSlot && targetSlot.baseUrl && k.baseUrl && k.baseUrl !== targetSlot.baseUrl) {
            continue;
        }
        if (!k.model && !seen.has(k.key)) {
            keys.push(k);
            seen.add(k.key);
        }
    }

    // 4. Environment keys
    const provDef = aiProviders.getProvider(p);
    for (const envName of provDef.envKeys || []) {
        const val = process.env[envName];
        if (val && typeof val === 'string') {
            const list = val.split(',').map((s) => s.trim()).filter(Boolean);
            for (const key of list) {
                if (!seen.has(key)) {
                    keys.push({ id: `env_${envName}`, key, model: '', label: `ENV (${envName})` });
                    seen.add(key);
                }
            }
        }
    }

    return keys;
}

/* ---------------------------------------------------- Legacy selection & Slot Resolution */

function legacySelection() {
    const data = readJsonFile(LEGACY_FILE, {});
    const providerId = aiProviders.PROVIDER_IDS.includes(String(data.provider || '').toLowerCase())
        ? String(data.provider).toLowerCase()
        : 'groq';
    const savedKeys = data.keys && typeof data.keys === 'object' ? data.keys : {};
    return {
        provider: providerId,
        key: String(savedKeys[providerId] || data.apiKey || '').trim(),
        model: cleanModel((data.models && data.models[providerId]) || data.model || '')
    };
}

function resolveSlot(id) {
    const config = readConfig();
    const raw = config.slots.find((slot) => slot.id === id) || getSlot(id);
    if (!raw) return null;
    const provider = aiProviders.getProvider(raw.provider);
    const store = readKeys();
    const slotProvider = store.slotProviders && store.slotProviders[raw.id];
    let apiKey = (!slotProvider || slotProvider === raw.provider) ? String(store.slots[raw.id] || '').trim() : '';
    let keySource = apiKey ? 'saved' : '';

    if (!apiKey) {
        // Check candidate keys from provider store
        const candidates = getCandidateKeys(raw.provider, raw.model);
        if (candidates.length) {
            apiKey = candidates[0].key;
            keySource = 'provider';
        }
    }

    if (!apiKey && raw.apiKeyEnv && process.env[raw.apiKeyEnv]) {
        apiKey = String(process.env[raw.apiKeyEnv] || '').trim();
        keySource = 'env';
    }
    if (!apiKey) {
        for (const name of provider.envKeys || []) {
            const value = String(process.env[name] || '').trim();
            if (value) {
                apiKey = value.split(',')[0].trim();
                keySource = 'env';
                break;
            }
        }
    }
    if (!apiKey && raw.id === 'primary') {
        const legacy = legacySelection();
        if (legacy.provider === raw.provider && legacy.key) {
            apiKey = legacy.key;
            keySource = 'legacy';
        }
    }

    let model = cleanModel(raw.model);
    if (!model && raw.id === 'primary') {
        const legacy = legacySelection();
        if (legacy.provider === raw.provider && legacy.model) model = legacy.model;
    }
    if (!model) {
        const models = getModels(raw.provider);
        model = models[0] || provider.defaultModel || '';
    }

    return {
        id: raw.id,
        label: raw.label,
        providerId: raw.provider,
        providerLabel: provider.label,
        baseUrl: raw.baseUrl || provider.baseUrl || '',
        model,
        apiKey,
        keySource,
        vision: raw.vision || Boolean(provider.vision),
        enabled: raw.enabled,
        apiKeyEnv: raw.apiKeyEnv
    };
}

function getSlotsPublic() {
    return readConfig().slots.map((slot) => {
        const resolved = resolveSlot(slot.id);
        return {
            id: slot.id,
            label: slot.label,
            provider: slot.provider,
            providerLabel: aiProviders.getProvider(slot.provider).label,
            baseUrl: resolved.baseUrl,
            model: resolved.model,
            apiKeyEnv: slot.apiKeyEnv,
            vision: Boolean(resolved.vision),
            enabled: Boolean(slot.enabled),
            keyConfigured: Boolean(resolved.apiKey),
            keySource: resolved.keySource,
            maskedKey: maskKey(resolved.apiKey)
        };
    });
}

function statusSummary() {
    const slots = getSlotsPublic();
    const order = getOrder();
    const usable = order
        .map((id) => slots.find((slot) => slot.id === id))
        .filter((slot) => slot && slot.enabled && slot.keyConfigured);
    return {
        order,
        slots,
        active: usable[0] ? `${usable[0].label} · ${usable[0].providerLabel} · ${usable[0].model}` : null,
        usable: usable.map((slot) => slot.id),
        providerPriority: getPriority()
    };
}

/* ------------------------------------------------------------------ writes */

function saveSlot(id, patch = {}) {
    const slotId = String(id || '').toLowerCase();
    if (!SLOT_IDS.includes(slotId)) return { ok: false, error: 'Unknown provider slot.' };

    const config = readConfig();
    const index = config.slots.findIndex((slot) => slot.id === slotId);
    if (index === -1) return { ok: false, error: 'Unknown provider slot.' };
    const slot = { ...config.slots[index] };

    if (patch.provider !== undefined) {
        const providerId = String(patch.provider || '').toLowerCase();
        if (!aiProviders.PROVIDER_IDS.includes(providerId)) {
            return { ok: false, error: 'Unknown provider. Use gemini, groq, or custom.' };
        }
        if (providerId !== slot.provider) {
            const next = aiProviders.getProvider(providerId);
            slot.provider = providerId;
            if (patch.baseUrl === undefined) slot.baseUrl = next.baseUrl || '';
            if (patch.model === undefined) slot.model = next.defaultModel || '';
            slot.vision = Boolean(next.vision);
        }
    }

    const provider = aiProviders.getProvider(slot.provider);

    if (patch.baseUrl !== undefined) {
        const baseUrl = normaliseBaseUrl(patch.baseUrl);
        if (!validBaseUrl(baseUrl)) return { ok: false, error: 'Base URL must be a valid http(s) URL.' };
        slot.baseUrl = baseUrl;
    }

    if (patch.model !== undefined) {
        const model = cleanModel(patch.model);
        if (!validModelId(model)) return { ok: false, error: 'Invalid model id.' };
        slot.model = model;
    }

    if (patch.label !== undefined) slot.label = String(patch.label || SLOT_LABELS[slotId]).slice(0, 40);
    if (typeof patch.vision === 'boolean') slot.vision = patch.vision;
    if (typeof patch.enabled === 'boolean') slot.enabled = patch.enabled;

    if (patch.apiKey !== undefined && String(patch.apiKey).trim()) {
        const key = String(patch.apiKey).trim();
        if (key.length < 6 || key.length > 300 || /\s/.test(key)) {
            return { ok: false, error: 'That does not look like an API key.' };
        }
        const store = readKeys();
        store.slots[slotId] = key;
        store.slotProviders = store.slotProviders || {};
        store.slotProviders[slotId] = slot.provider;
        keyCooldowns.delete(hashKey(key));
        if (!writeKeys(store)) return { ok: false, error: 'Could not store the key on this server.' };
        if (patch.enabled === undefined) slot.enabled = true;
    }

    if (patch.clearKey) {
        const store = readKeys();
        if (store.slots[slotId]) {
            keyCooldowns.delete(hashKey(store.slots[slotId]));
            delete store.slots[slotId];
        }
        writeKeys(store);
    }

    if (slot.provider === 'custom' && !slot.baseUrl) slot.enabled = false;
    if (!slot.model && !provider.defaultModel) slot.enabled = false;

    config.slots[index] = slot;
    if (!writeConfig(config)) return { ok: false, error: 'Could not save the provider configuration.' };

    return { ok: true, slot: getSlotsPublic().find((entry) => entry.id === slotId), order: getOrder() };
}

function setOrder(order) {
    const wanted = Array.isArray(order) ? order.map((id) => String(id).toLowerCase()) : [];
    if (!wanted.length) return { ok: false, error: 'Order must list the three slots.' };
    for (const id of wanted) {
        if (!SLOT_IDS.includes(id)) return { ok: false, error: `Unknown slot "${id}".` };
    }
    const next = [];
    for (const id of wanted) if (!next.includes(id)) next.push(id);
    for (const id of SLOT_IDS) if (!next.includes(id)) next.push(id);
    if (next.length !== SLOT_IDS.length) return { ok: false, error: 'Order must list every slot exactly once.' };
    const config = readConfig();
    config.order = next;
    if (!writeConfig(config)) return { ok: false, error: 'Could not save the provider order.' };
    return { ok: true, order: next };
}

function setKey(id, apiKey) {
    return saveSlot(id, { apiKey });
}

/* -------------------------------------------------------------------- chat */

function safeMessage(error, key) {
    let message = String(error?.message || error || 'Provider request failed');
    if (key) message = message.split(key).join('••••');
    return message.replace(/\s+/g, ' ').slice(0, 220);
}

function providerTimeoutMs(limits, customTimeout) {
    return Math.max(5000, Number(customTimeout) || Number(limits.timeoutMs) || FAST.timeoutMs);
}

/**
 * Intelligent chat with Provider -> Model -> Multiple API Keys rotation.
 *
 * Rotation Flow:
 * 1. Checks providers in priority order (or configured slot order).
 * 2. For each provider, checks configured models in priority order.
 * 3. For each model, iterates over candidate API keys.
 * 4. When HTTP 429 / rate-limit is detected:
 *    - Key is marked rate-limited with a temporary cooldown.
 *    - Switches immediately to the next available key for the same model and retries.
 *    - If all keys for that model are exhausted, advances to the next configured model.
 *    - If all models for that provider are exhausted, advances to the next provider.
 * 5. Ordinary network errors or 401 invalid keys do not trigger rate-limit cooldowns.
 */
async function chatWithFailover(messages, options = {}) {
    const started = Date.now();
    const config = readConfig();
    const depth = options.depth === 'detailed' ? 'detailed' : 'fast';
    const limits = {
        maxTokens: Number(options.maxTokens) || config[depth].maxTokens || config.maxTokens,
        timeoutMs: Number(options.timeoutMs) || config[depth].timeoutMs || config.timeoutMs
    };
    const attempts = [];
    const skipped = [];
    const wantVision = Boolean(options.vision);

    // Build ordered list of provider targets.
    // If slots are explicitly configured and customized (e.g. in test-ai-engine),
    // we evaluate slots in order, expanding each slot into its model and keys.
    const candidates = [];
    for (const slotId of config.order) {
        const slot = resolveSlot(slotId);
        if (!slot) continue;
        if (!slot.enabled) {
            skipped.push({ slot: slotId, reason: 'disabled' });
            continue;
        }
        if (!slot.baseUrl) {
            skipped.push({ slot: slotId, reason: 'no base URL' });
            continue;
        }
        if (wantVision && !slot.vision) {
            skipped.push({ slot: slotId, reason: 'no vision support' });
            continue;
        }
        candidates.push(slot);
    }

    if (!candidates.length) {
        const error = new Error(
            wantVision
                ? 'No vision-capable AI provider is configured.'
                : 'No AI provider is configured with a base URL, model and API key.'
        );
        error.attempts = attempts;
        error.skipped = skipped;
        error.code = wantVision ? 'NO_VISION_PROVIDER' : 'NO_PROVIDER';
        throw error;
    }

    for (const slot of candidates) {
        const providerId = slot.providerId;
        const providerLabel = slot.providerLabel;
        const baseUrl = slot.baseUrl;

        // Models to try for this provider slot: slot's primary model first, then remaining models
        const provModels = getModels(providerId);
        const modelsToTry = [];
        if (slot.model && !modelsToTry.includes(slot.model)) modelsToTry.push(slot.model);
        for (const m of provModels) {
            if (!modelsToTry.includes(m)) modelsToTry.push(m);
        }
        if (!modelsToTry.length && slot.model) modelsToTry.push(slot.model);

        let providerSucceeded = false;

        for (const model of modelsToTry) {
            // Get candidate keys for this provider + model
            const allKeys = getCandidateKeys(providerId, model, slot);

            if (!allKeys.length) {
                continue;
            }

            // Filter out keys currently cooling down; if all are cooling down, try anyway
            let usableKeys = allKeys.filter((k) => !isKeyInCooldown(k.key));
            if (!usableKeys.length) {
                usableKeys = allKeys.slice();
            }

            for (const keyObj of usableKeys) {
                const key = keyObj.key;
                const slotStarted = Date.now();
                try {
                    const text = await aiProviders.chat(messages, {
                        provider: providerId,
                        apiKey: key,
                        baseUrl,
                        model,
                        temperature: options.temperature,
                        maxTokens: limits.maxTokens,
                        timeout: providerTimeoutMs(limits, options.timeout)
                    });

                    attempts.push({
                        slot: slot.id,
                        provider: providerLabel,
                        model,
                        keyId: keyObj.id,
                        ok: true,
                        ms: Date.now() - slotStarted
                    });

                    markKeySuccess(key);

                    return {
                        text,
                        slot: slot.id,
                        provider: providerLabel,
                        providerId,
                        model,
                        keyId: keyObj.id,
                        maskedKey: maskKey(key),
                        depth,
                        attempts,
                        skipped,
                        ms: Date.now() - started
                    };
                } catch (err) {
                    const status = err.status || (String(err?.message || '').includes('429') ? 429 : (String(err?.message || '').includes('401') ? 401 : null));
                    const isRateLimit = aiProviders.isRateLimitError(err, status);
                    const isInvalid = aiProviders.isInvalidKeyError(err, status);
                    const reason = safeMessage(err, key);

                    attempts.push({
                        slot: slot.id,
                        provider: providerLabel,
                        model,
                        keyId: keyObj.id,
                        ok: false,
                        error: reason,
                        ms: Date.now() - slotStarted
                    });

                    if (isRateLimit) {
                        markKeyRateLimited(key, DEFAULT_COOLDOWN_MS);
                        console.warn(`[aiRotation] ${providerLabel} key (${keyObj.id || maskKey(key)}) rate-limited (429). Rotating to next key for model ${model}...`);
                        // Automatically tries the next key in usableKeys for this model
                        continue;
                    } else if (isInvalid) {
                        markKeyInvalid(key, reason);
                        console.warn(`[aiRotation] ${providerLabel} key (${keyObj.id || maskKey(key)}) is invalid (401). Skipping key...`);
                        continue;
                    } else {
                        console.error(`[aiConfig] ${slot.label} (${providerLabel}/${model}) failed: ${reason}`);
                        // Network/internal error — move to next key or model
                        continue;
                    }
                }
            }
            // If all keys for this model failed, loop continues to next model for this provider
        }
    }

    const error = new Error('Every configured AI provider failed.');
    error.attempts = attempts;
    error.skipped = skipped;
    error.code = 'ALL_PROVIDERS_FAILED';
    throw error;
}

/* ---------------------------------------------------- Testing & Diagnostics */

async function testSlot(id, prompt = 'Say hello in one short line.', overrides = {}) {
    const resolved = resolveSlot(id);
    if (!resolved) return { ok: false, error: 'Unknown provider slot.' };

    const providerId = aiProviders.PROVIDER_IDS.includes(String(overrides.provider || '').toLowerCase())
        ? String(overrides.provider).toLowerCase()
        : resolved.providerId;
    const baseUrl = normaliseBaseUrl(overrides.baseUrl !== undefined ? overrides.baseUrl : resolved.baseUrl);
    const model = cleanModel(overrides.model !== undefined ? overrides.model : resolved.model);

    if (overrides.baseUrl !== undefined && !validBaseUrl(baseUrl)) {
        return { ok: false, slot: id, error: 'Base URL must be a valid http(s) URL.' };
    }
    if (overrides.model !== undefined && !validModelId(model)) {
        return { ok: false, slot: id, error: 'Invalid model id.' };
    }

    const slot = {
        ...resolved,
        providerId,
        providerLabel: aiProviders.getProvider(providerId).label,
        baseUrl,
        model,
        apiKey: String(overrides.apiKey || '').trim() || resolved.apiKey
    };
    if (!slot.apiKey) return { ok: false, slot: id, error: `${slot.label}: no API key configured.` };
    if (!slot.baseUrl) return { ok: false, slot: id, error: `${slot.label}: no base URL configured.` };
    if (!slot.model) return { ok: false, slot: id, error: `${slot.label}: no model configured.` };
    const started = Date.now();
    try {
        const text = await aiProviders.chat(
            [
                { role: 'system', content: 'You are AYHA. Answer in one short line.' },
                { role: 'user', content: String(prompt || 'Say hello').slice(0, 500) }
            ],
            {
                provider: slot.providerId,
                apiKey: slot.apiKey,
                baseUrl: slot.baseUrl,
                model: slot.model,
                maxTokens: TEST_MAX_TOKENS,
                timeout: TEST_TIMEOUT_MS
            }
        );
        return {
            ok: true,
            slot: slot.id,
            provider: slot.providerLabel,
            model: slot.model,
            reply: text,
            ms: Date.now() - started
        };
    } catch (err) {
        return {
            ok: false,
            slot: slot.id,
            provider: slot.providerLabel,
            model: slot.model,
            error: safeMessage(err, slot.apiKey),
            ms: Date.now() - started
        };
    }
}

async function testKey(providerId, keyIdOrKey, prompt = 'Say hello in one short line.') {
    const p = String(providerId || '').toLowerCase();
    const prov = aiProviders.getProvider(p);
    const store = readKeys();
    let rawKey = String(keyIdOrKey || '').trim();

    // Check if keyId was passed
    const match = (store.keys[p] || []).find((k) => k.id.toLowerCase() === rawKey.toLowerCase());
    if (match) rawKey = match.key;

    if (!rawKey) return { ok: false, error: 'No API key provided.' };

    const models = getModels(p);
    const model = models[0] || prov.defaultModel;
    const config = readConfig();
    const baseUrl = (config.providers[p] && config.providers[p].baseUrl) || prov.baseUrl;

    const started = Date.now();
    try {
        const text = await aiProviders.chat(
            [
                { role: 'system', content: 'You are AYHA. Answer in one short line.' },
                { role: 'user', content: String(prompt || 'Say hello').slice(0, 500) }
            ],
            {
                provider: p,
                apiKey: rawKey,
                baseUrl,
                model,
                maxTokens: TEST_MAX_TOKENS,
                timeout: TEST_TIMEOUT_MS
            }
        );
        return {
            ok: true,
            provider: prov.label,
            model,
            reply: text,
            maskedKey: maskKey(rawKey),
            ms: Date.now() - started
        };
    } catch (err) {
        return {
            ok: false,
            provider: prov.label,
            model,
            error: safeMessage(err, rawKey),
            maskedKey: maskKey(rawKey),
            ms: Date.now() - started
        };
    }
}

async function listModels(idOrProvider, search = '') {
    const term = String(idOrProvider || '').toLowerCase();
    let providerId = term;
    let baseUrl = '';
    let apiKey = '';

    if (SLOT_IDS.includes(term)) {
        const slot = resolveSlot(term);
        if (!slot) return { ok: false, models: [], reason: 'Unknown provider slot.' };
        providerId = slot.providerId;
        baseUrl = slot.baseUrl;
        apiKey = slot.apiKey;
    } else if (aiProviders.PROVIDER_IDS.includes(term)) {
        const prov = aiProviders.getProvider(term);
        const config = readConfig();
        baseUrl = (config.providers[term] && config.providers[term].baseUrl) || prov.baseUrl;
        const candidates = getCandidateKeys(term);
        if (candidates.length) apiKey = candidates[0].key;
    }

    if (!apiKey) {
        // Return configured models as safe fallback
        const configured = getModels(providerId);
        return { ok: true, models: configured, reason: 'Showing configured models (no key for live query)' };
    }

    const result = await aiProviders.listModels({ provider: providerId, baseUrl, apiKey });
    const searchTerm = String(search || '').trim().toLowerCase();
    const models = searchTerm
        ? result.models.filter((m) => m.toLowerCase().includes(searchTerm))
        : result.models;

    return { ...result, models: models.slice(0, 400), provider: providerId };
}

function primarySlot() {
    const order = getOrder();
    for (const id of order) {
        const slot = resolveSlot(id);
        if (slot && slot.enabled && slot.apiKey && slot.baseUrl && slot.model) return slot;
    }
    return resolveSlot(order[0]) || null;
}

module.exports = {
    SLOT_IDS,
    SLOT_LABELS,
    CONFIG_FILE,
    KEYS_FILE,
    readConfig,
    writeConfig,
    getSlot,
    getOrder,
    getSlotsPublic,
    statusSummary,
    resolveSlot,
    primarySlot,
    saveSlot,
    setOrder,
    setKey,
    // Multi-key & multi-model architecture
    getPriority,
    setPriority,
    getModels,
    addModel,
    removeModel,
    setModels,
    setBaseUrl,
    addKey,
    removeKey,
    editKey,
    getKeysPublic,
    getProviderHealth,
    getCandidateKeys,
    testKey,
    testSlot,
    listModels,
    chatWithFailover,
    clearCooldowns,
    maskKey,
    validBaseUrl,
    validModelId
};
