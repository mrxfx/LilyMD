'use strict';
/**
 * AYHA — Independent Model Selection + Multi-API-Key Rotation
 *
 * Three completely independent providers:
 *   1. Groq (groq)
 *   2. Google Gemini (gemini)
 *   3. Custom OpenAI-compatible API (custom)
 *
 * Hierarchy & Architecture:
 *   - Each provider has up to 4 independently configurable models (Model 1..4).
 *   - Each model has up to 4 dedicated API keys (Key 1..4) -> Up to 16 keys per provider.
 *   - Manual Model Selection: The owner manually selects which model AYHA uses.
 *   - Strict Key Rotation: AYHA rotates API keys assigned to the selected model
 *     on rate limit (429) or unavailability. It NEVER automatically switches
 *     to Model 2 or another model of the same provider when a key fails.
 *   - Stickiness: Remembers the last successful key to minimize unnecessary failures.
 *   - Provider Failover: If all keys for the selected model fail, it falls back
 *     to the next provider in the configured priority order.
 *
 * Safe diagnostics: API keys are NEVER logged or echoed in WhatsApp/logs/dashboards.
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

const MODEL_SLOT_COUNT = 4;
const KEY_SLOT_COUNT = 4;

const FAST = { maxTokens: 800, timeoutMs: 35000 };
const DETAILED = { maxTokens: 2500, timeoutMs: 90000 };
const TEST_MAX_TOKENS = 200;
const TEST_TIMEOUT_MS = 45000;
const DEFAULT_COOLDOWN_MS = 60000; // 60 seconds rate limit cooldown

const DEFAULT_MODELS = {
    groq: [
        { index: 1, id: 'openai/gpt-oss-20b', label: 'Fast everyday chatting', enabled: true },
        { index: 2, id: 'openai/gpt-oss-120b', label: 'Better quality responses', enabled: true },
        { index: 3, id: 'qwen/qwen3.8-27b', label: 'Advanced reasoning / multilingual', enabled: true },
        { index: 4, id: 'meta-models/muse-spark-open', label: 'Configured alternative', enabled: true }
    ],
    gemini: [
        { index: 1, id: 'gemini-3.6-flash', label: 'Daily conversations & primary auto-reply', enabled: true },
        { index: 2, id: 'gemini-3.1-flash-lite', label: 'Lightweight, ultra-fast replies', enabled: true },
        { index: 3, id: 'gemini-3.5-flash', label: 'General-purpose alternative & deep context', enabled: true },
        { index: 4, id: 'gemini-3.5-flash-lite', label: 'Lightweight alternative', enabled: true }
    ],
    custom: [
        { index: 1, id: 'openrouter/free', label: 'Custom Model 1', enabled: true },
        { index: 2, id: 'meta-llama/llama-3.3-70b-instruct', label: 'Custom Model 2', enabled: true },
        { index: 3, id: 'deepseek/deepseek-chat', label: 'Custom Model 3', enabled: true },
        { index: 4, id: 'mistralai/mistral-7b-instruct', label: 'Custom Model 4', enabled: true }
    ]
};

const DEFAULT_BASE_URLS = {
    groq: 'https://api.groq.com/openai/v1',
    gemini: 'https://generativelanguage.googleapis.com/v1beta',
    custom: 'https://openrouter.ai/api/v1'
};

const DEFAULT_PROVIDERS = {
    groq: {
        id: 'groq',
        label: 'Groq',
        enabled: true,
        baseUrl: DEFAULT_BASE_URLS.groq,
        models: DEFAULT_MODELS.groq.map((m) => m.id),
        defaultModel: 'openai/gpt-oss-20b',
        vision: false
    },
    gemini: {
        id: 'gemini',
        label: 'Google Gemini',
        enabled: true,
        baseUrl: DEFAULT_BASE_URLS.gemini,
        models: DEFAULT_MODELS.gemini.map((m) => m.id),
        defaultModel: 'gemini-3.6-flash',
        vision: true
    },
    custom: {
        id: 'custom',
        label: 'Custom (OpenAI-compatible)',
        enabled: false,
        baseUrl: DEFAULT_BASE_URLS.custom,
        models: DEFAULT_MODELS.custom.map((m) => m.id),
        defaultModel: 'openrouter/free',
        vision: false
    }
};

const DEFAULT_PRIORITY = ['groq', 'gemini', 'custom'];

const GROQ_MODEL_RANKINGS = [
    {
        priority: 1,
        model: 'openai/gpt-oss-20b',
        recommended: true,
        tag: 'Production · Daily chatting',
        speed: 'Ultra-Fast (~500+ tps)',
        strengths: 'Balanced speed and quality, highest RPM/TPM quota headroom on Groq',
        bestUse: 'Daily chatting, balanced speed and quality'
    },
    {
        priority: 2,
        model: 'openai/gpt-oss-120b',
        recommended: false,
        tag: 'Production · Better reasoning',
        speed: 'Moderate (~150-200 tps)',
        strengths: 'Complex questions, high-depth analysis, deeper multi-step reasoning',
        bestUse: 'Complex questions, better reasoning'
    },
    {
        priority: 3,
        model: 'qwen/qwen3.8-27b',
        recommended: false,
        tag: 'Newer Model · General chat & reasoning',
        speed: 'Fast (~350 tps)',
        strengths: 'Multilingual fluency (English, Bengali, Hindi), strong reasoning',
        bestUse: 'Alternative general chat and reasoning'
    },
    {
        priority: 4,
        model: 'meta-models/muse-spark-open',
        recommended: false,
        tag: 'Newer Model · General-purpose',
        speed: 'Fast',
        strengths: 'General-purpose open model',
        bestUse: 'Another general-purpose alternative'
    }
];

const GEMINI_MODEL_RANKINGS = [
    {
        priority: 1,
        model: 'gemini-3.6-flash',
        recommended: true,
        tag: 'Daily conversations · Primary',
        speed: 'Fast',
        strengths: 'Optimal balance of speed, multimodal intelligence, Bengali/Banglish/English fluency',
        bestUse: 'Daily conversations & primary auto-reply'
    },
    {
        priority: 2,
        model: 'gemini-3.1-flash-lite',
        recommended: false,
        tag: 'Lightweight & ultra-fast · Fallback',
        speed: 'Ultra-Fast',
        strengths: 'Minimal latency, lightweight resource consumption, instant failover responses',
        bestUse: 'Lightweight, ultra-fast replies & fallback'
    },
    {
        priority: 3,
        model: 'gemini-3.5-flash',
        recommended: false,
        tag: 'General-purpose alternative',
        speed: 'Fast',
        strengths: 'Stable, proven general-purpose conversational performance & reasoning',
        bestUse: 'General-purpose alternative'
    },
    {
        priority: 4,
        model: 'gemini-3.5-flash-lite',
        recommended: false,
        tag: 'Lightweight alternative',
        speed: 'Ultra-Fast',
        strengths: 'Lightweight secondary option for high-throughput chats',
        bestUse: 'Lightweight alternative'
    }
];

const DEFAULT_SLOTS = [
    {
        id: 'primary',
        label: SLOT_LABELS.primary,
        provider: 'groq',
        baseUrl: DEFAULT_BASE_URLS.groq,
        model: 'openai/gpt-oss-20b',
        apiKeyEnv: 'GROQ_API_KEY',
        vision: false,
        enabled: true
    },
    {
        id: 'fallback1',
        label: SLOT_LABELS.fallback1,
        provider: 'gemini',
        baseUrl: DEFAULT_BASE_URLS.gemini,
        model: 'gemini-3.6-flash',
        apiKeyEnv: 'GEMINI_API_KEY',
        vision: true,
        enabled: true
    },
    {
        id: 'fallback2',
        label: SLOT_LABELS.fallback2,
        provider: 'custom',
        baseUrl: DEFAULT_BASE_URLS.custom,
        model: 'openrouter/free',
        apiKeyEnv: 'OPENROUTER_API_KEY',
        vision: false,
        enabled: true
    }
];

function isPlaceholderKey(key) {
    if (!key || typeof key !== 'string') return true;
    const clean = key.trim();
    if (clean.length < 6) return true;
    const lower = clean.toLowerCase();
    if (
        lower.includes('your_') ||
        lower.includes('placeholder') ||
        lower.includes('paste_') ||
        lower.includes('example') ||
        lower.includes('change_me') ||
        lower.includes('todo') ||
        lower.includes('fake_') ||
        lower === 'gsk_...' ||
        lower === 'aiza...'
    ) {
        return true;
    }
    return false;
}

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

/* ------------------------------------------------------------------ Provider Store Factory */

function createDefaultProviderStore(providerId) {
    const models = [];
    const defModels = DEFAULT_MODELS[providerId] || [];
    for (let m = 1; m <= MODEL_SLOT_COUNT; m++) {
        const def = defModels[m - 1] || { index: m, id: '', label: `Model ${m}`, enabled: true };
        models.push({
            index: m,
            id: def.id,
            label: def.label,
            enabled: def.enabled !== false
        });
    }

    const keySlots = [];
    for (let k = 1; k <= KEY_SLOT_COUNT; k++) {
        keySlots.push({
            index: k,
            id: `${providerId}_key_${k}`,
            key: '',
            label: k === 1 ? 'Primary Key' : `Backup Key ${k}`,
            status: 'empty',
            rateLimitedUntil: 0,
            failureCount: 0,
            lastUsed: null,
            lastError: null
        });
    }

    return {
        selectedModel: 1,
        lastWorkingKey: 1,
        baseUrl: DEFAULT_BASE_URLS[providerId] || '',
        models,
        keys: keySlots
    };
}

function loadEnvModel(providerId, modelIndex) {
    const p = providerId.toUpperCase();
    const envVar = `${p}_MODEL_${modelIndex}`;
    const val = process.env[envVar];
    if (val && typeof val === 'string' && validModelId(val.trim())) {
        return cleanModel(val.trim());
    }
    return '';
}

function loadEnvKey(providerId, keyIndex) {
    const p = providerId.toUpperCase();
    const candidates = [
        `${p}_API_KEY_${keyIndex}`,
        `${p}_KEY_${keyIndex}`
    ];
    if (keyIndex === 1) {
        candidates.push(`${p}_API_KEY`, `${p}_KEY`);
        if (providerId === 'custom') {
            candidates.push('OPENROUTER_API_KEY', 'AI_CUSTOM_API_KEY');
        }
    }

    for (const envVar of candidates) {
        const val = process.env[envVar];
        if (val && typeof val === 'string' && val.trim().length >= 6 && !isPlaceholderKey(val)) {
            return val.trim();
        }
    }
    return '';
}

/* ------------------------------------------------------------------ config */

function defaultConfig() {
    return {
        version: 3,
        activeProvider: 'groq',
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
    let rawProv = String(slot.provider || '').toLowerCase().trim();
    if (rawProv === 'openrouter') rawProv = 'custom';
    const providerId = aiProviders.PROVIDER_IDS.includes(rawProv)
        ? rawProv
        : base.provider || 'custom';
    const provider = aiProviders.getProvider(providerId);

    let baseUrl = slot.baseUrl !== undefined ? slot.baseUrl : base.baseUrl || provider.baseUrl;
    if (providerId === 'groq' && baseUrl && baseUrl.includes('openrouter.ai')) {
        baseUrl = provider.baseUrl;
    }
    let model = slot.model !== undefined ? slot.model : base.model || provider.defaultModel;
    if (providerId === 'groq' && model && model.includes('openrouter')) {
        model = provider.defaultModel;
    }

    return {
        id: base.id,
        label: String(slot.label || base.label || SLOT_LABELS[base.id] || base.id).slice(0, 40),
        provider: providerId,
        baseUrl: normaliseBaseUrl(baseUrl),
        model: cleanModel(model),
        apiKeyEnv: String(slot.apiKeyEnv || base.apiKeyEnv || `AI_${String(base.id || 'slot').toUpperCase()}_API_KEY`).slice(0, 60),
        vision: typeof slot.vision === 'boolean' ? slot.vision : Boolean(base.vision || provider.vision),
        enabled: typeof slot.enabled === 'boolean' ? slot.enabled : Boolean(base.enabled)
    };
}

function readConfig() {
    const data = readJsonFile(CONFIG_FILE, null);
    const config = defaultConfig();
    if (!data) return config;

    if (data.activeProvider && aiProviders.PROVIDER_IDS.includes(data.activeProvider)) {
        config.activeProvider = data.activeProvider;
    }

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
        version: 3,
        activeProvider: config.activeProvider || 'groq',
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
    const store = {
        version: 3,
        activeProvider: data.activeProvider || 'groq',
        providerPriority: Array.isArray(data.providerPriority) && data.providerPriority.length ? data.providerPriority : DEFAULT_PRIORITY.slice(),
        slots: data.slots || {},
        slotProviders: data.slotProviders && typeof data.slotProviders === 'object' ? { ...data.slotProviders } : {},
        providers: {},
        keys: { groq: [], gemini: [], custom: [] } // For backward compatibility with legacy tests
    };

    if (!aiProviders.PROVIDER_IDS.includes(store.activeProvider)) {
        store.activeProvider = 'groq';
    }

    for (const p of aiProviders.PROVIDER_IDS) {
        const defaultProv = createDefaultProviderStore(p);
        const savedProv = (data.providers && data.providers[p]) || {};

        const selModel = parseInt(savedProv.selectedModel, 10);
        defaultProv.selectedModel = (selModel >= 1 && selModel <= MODEL_SLOT_COUNT) ? selModel : 1;
        const lk = parseInt(savedProv.lastWorkingKey, 10);
        defaultProv.lastWorkingKey = (lk >= 1 && lk <= KEY_SLOT_COUNT) ? lk : 1;

        if (savedProv.baseUrl) {
            defaultProv.baseUrl = normaliseBaseUrl(savedProv.baseUrl);
        }
        if (p === 'custom' && process.env.CUSTOM_BASE_URL) {
            defaultProv.baseUrl = normaliseBaseUrl(process.env.CUSTOM_BASE_URL);
        }

        // Models (up to 4)
        for (let m = 1; m <= MODEL_SLOT_COUNT; m++) {
            const modelSlot = defaultProv.models[m - 1];
            const savedModel = (savedProv.models || []).find((x) => x && x.index === m) || {};

            const envModel = loadEnvModel(p, m);
            if (envModel) {
                modelSlot.id = envModel;
            } else if (savedModel.id) {
                modelSlot.id = cleanModel(savedModel.id);
            }
            if (savedModel.label) modelSlot.label = String(savedModel.label).slice(0, 60);
            if (typeof savedModel.enabled === 'boolean') modelSlot.enabled = savedModel.enabled;
        }

        // Shared API Keys (up to 4 shared keys for this provider)
        for (let k = 1; k <= KEY_SLOT_COUNT; k++) {
            const keySlot = defaultProv.keys[k - 1];
            let savedKey = (savedProv.keys || []).find((x) => x && x.index === k);
            // Backward migration from old per-model key store if found
            if (!savedKey && savedProv.models && savedProv.models[0]?.keys) {
                savedKey = savedProv.models[0].keys.find((x) => x && x.index === k);
            }
            savedKey = savedKey || {};

            const envKey = loadEnvKey(p, k);
            let rawKey = '';
            if (savedKey.key && !isPlaceholderKey(savedKey.key)) {
                rawKey = String(savedKey.key).trim();
            } else if (envKey) {
                rawKey = envKey;
            }

            keySlot.key = rawKey;
            const hash = hashKey(rawKey);
            const memCool = rawKey ? (keyCooldowns.get(hash) || 0) : 0;
            keySlot.status = rawKey ? (Date.now() < memCool ? 'coolingDown' : (savedKey.status || 'active')) : 'empty';
            keySlot.rateLimitedUntil = Math.max(Number(savedKey.rateLimitedUntil) || 0, memCool);
            keySlot.failureCount = Number(savedKey.failureCount) || 0;
            keySlot.lastUsed = savedKey.lastUsed || null;
            keySlot.lastError = savedKey.lastError || null;
            if (savedKey.label) keySlot.label = String(savedKey.label).slice(0, 40);
            if (savedKey.id) keySlot.id = String(savedKey.id).slice(0, 32);

            // Populate legacy store.keys[p] array for backwards compatibility
            if (rawKey) {
                store.keys[p].push({
                    id: keySlot.id,
                    key: rawKey,
                    index: k,
                    keyIndex: k,
                    label: keySlot.label,
                    rateLimitedUntil: keySlot.rateLimitedUntil,
                    failureCount: keySlot.failureCount,
                    lastUsed: keySlot.lastUsed,
                    lastError: keySlot.lastError
                });
            }
        }
        store.providers[p] = defaultProv;
    }

    // Populate legacy store.slots
    for (const slotId of SLOT_IDS) {
        if (data.slots && data.slots[slotId]) {
            store.slots[slotId] = String(data.slots[slotId]).trim();
        } else if (data.keys && typeof data.keys === 'object' && !Array.isArray(data.keys.groq) && data.keys[slotId]) {
            store.slots[slotId] = String(data.keys[slotId]).trim();
        }
    }

    // Also merge any providerKeys from legacy store
    if (data.providerKeys && typeof data.providerKeys === 'object') {
        for (const p of aiProviders.PROVIDER_IDS) {
            if (Array.isArray(data.providerKeys[p])) {
                for (const item of data.providerKeys[p]) {
                    if (item && item.key && !store.keys[p].some((x) => x.key === item.key)) {
                        store.keys[p].push(item);
                    }
                }
            }
        }
    }

    return store;
}

function writeKeys(store) {
    const payload = {
        version: 3,
        activeProvider: store.activeProvider || 'groq',
        providerPriority: store.providerPriority || DEFAULT_PRIORITY.slice(),
        slots: store.slots || {},
        slotProviders: store.slotProviders || {},
        keys: store.slots || {}, // legacy compatibility
        providers: store.providers || {},
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
    store.providerPriority = next.slice();
    store.activeProvider = next[0];
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

/* ---------------------------------------------------- Independent Model & Key Architecture */

function getActiveProvider() {
    return readKeys().activeProvider || 'groq';
}

function setActiveProvider(providerId) {
    const p = String(providerId || '').toLowerCase().trim();
    if (!aiProviders.PROVIDER_IDS.includes(p)) {
        return { ok: false, error: `Invalid provider "${p}". Supported: gemini, groq, custom.` };
    }
    const store = readKeys();
    store.activeProvider = p;
    const currentPriority = store.providerPriority || DEFAULT_PRIORITY.slice();
    store.providerPriority = [p, ...currentPriority.filter((id) => id !== p)];
    writeKeys(store);

    const config = readConfig();
    config.activeProvider = p;
    config.providerPriority = store.providerPriority.slice();
    writeConfig(config);

    return { ok: true, activeProvider: p, priority: store.providerPriority };
}

function getSelectedModel(providerId) {
    const p = String(providerId || '').toLowerCase().trim();
    const store = readKeys();
    const prov = store.providers[p];
    if (!prov) return { ok: false, error: `Unknown provider "${p}".` };
    const m = prov.selectedModel || 1;
    const model = prov.models[m - 1];
    return {
        ok: true,
        provider: p,
        selectedModel: m,
        modelId: model?.id || '',
        label: model?.label || '',
        enabled: model?.enabled !== false
    };
}

function selectModel(providerId, modelIndex) {
    const p = String(providerId || '').toLowerCase().trim();
    if (!aiProviders.PROVIDER_IDS.includes(p)) {
        return { ok: false, error: `Unknown provider "${p}". Supported: gemini, groq, custom.` };
    }
    const idx = parseInt(modelIndex, 10);
    if (isNaN(idx) || idx < 1 || idx > MODEL_SLOT_COUNT) {
        return { ok: false, error: `Model slot must be a number between 1 and ${MODEL_SLOT_COUNT}.` };
    }
    const store = readKeys();
    store.providers[p].selectedModel = idx;
    store.activeProvider = p; // Selecting a provider's model activates that provider
    writeKeys(store);

    // Keep primary slot in sync with active model
    const config = readConfig();
    const prim = config.slots.find((s) => s.id === 'primary');
    if (prim && prim.provider === p) {
        prim.model = store.providers[p].models[idx - 1].id;
    }
    writeConfig(config);

    const modelObj = store.providers[p].models[idx - 1];
    return {
        ok: true,
        provider: p,
        selectedModel: idx,
        modelId: modelObj?.id || '',
        label: modelObj?.label || '',
        keysConfigured: (modelObj?.keys || []).filter((k) => k.key).length
    };
}

function setModelId(providerId, modelIndex, modelId, label = null) {
    const p = String(providerId || '').toLowerCase().trim();
    if (!aiProviders.PROVIDER_IDS.includes(p)) {
        return { ok: false, error: `Unknown provider "${p}".` };
    }
    const idx = parseInt(modelIndex, 10);
    if (isNaN(idx) || idx < 1 || idx > MODEL_SLOT_COUNT) {
        return { ok: false, error: `Model slot must be between 1 and ${MODEL_SLOT_COUNT}.` };
    }
    const clean = cleanModel(modelId);
    if (!clean || !validModelId(clean)) {
        return { ok: false, error: 'Invalid model ID format.' };
    }
    if (aiProviders.isBlockedNonTextModel && aiProviders.isBlockedNonTextModel(clean)) {
        return { ok: false, error: `Model "${clean}" is a specialized non-text model (audio/TTS/robotics/embedding) and cannot be used for text auto-replies.` };
    }

    const store = readKeys();
    const modelSlot = store.providers[p].models[idx - 1];
    modelSlot.id = clean;
    if (label) modelSlot.label = String(label).slice(0, 60);
    writeKeys(store);

    // Update config slots if matching
    const config = readConfig();
    for (const slot of config.slots) {
        if (slot.provider === p && store.providers[p].selectedModel === idx) {
            slot.model = clean;
        }
    }
    writeConfig(config);

    return { ok: true, provider: p, modelIndex: idx, modelId: clean, label: modelSlot.label };
}

function setKeySlot(providerId, a, b, c, d) {
    const p = String(providerId || '').toLowerCase().trim();
    if (!aiProviders.PROVIDER_IDS.includes(p)) {
        return { ok: false, error: `Unknown provider "${p}". Supported: gemini, groq, custom.` };
    }

    let keyIndex, rawKey, label;
    let modelIndex = null;
    if (typeof c === 'string' && (typeof b === 'number' || !isNaN(parseInt(b, 10))) && (typeof a === 'number' || !isNaN(parseInt(a, 10)))) {
        // Called as (providerId, modelIndex, keyIndex, rawKey, label)
        modelIndex = parseInt(a, 10);
        keyIndex = parseInt(b, 10);
        rawKey = c;
        label = d;
    } else {
        // Called as (providerId, keyIndex, rawKey, label)
        keyIndex = parseInt(a, 10);
        rawKey = b;
        label = c;
    }

    if (isNaN(keyIndex) || keyIndex < 1 || keyIndex > KEY_SLOT_COUNT) {
        return { ok: false, error: `Key slot must be between 1 and ${KEY_SLOT_COUNT}.` };
    }

    const key = String(rawKey || '').trim();
    if (key && (key.length < 6 || key.length > 300 || /\s/.test(key) || isPlaceholderKey(key))) {
        return { ok: false, error: 'Invalid API key format (placeholders and whitespace are rejected).' };
    }

    const store = readKeys();
    const prov = store.providers[p];
    if (!prov) return { ok: false, error: `Unknown provider "${p}".` };
    const keyObj = prov.keys[keyIndex - 1];

    keyObj.key = key;
    keyObj.status = key ? 'active' : 'empty';
    keyObj.rateLimitedUntil = 0;
    keyObj.failureCount = 0;
    keyObj.lastError = null;
    if (label) keyObj.label = String(label).slice(0, 40);

    const hash = hashKey(key);
    keyCooldowns.delete(hash);

    // If setting Key 1, sync with legacy slot for backwards compatibility
    if (keyIndex === 1) {
        for (const slotId of SLOT_IDS) {
            const slot = getSlot(slotId);
            if (slot && slot.provider === p && (!store.slots[slotId] || store.slots[slotId] === key)) {
                store.slots[slotId] = key;
            }
        }
    }

    writeKeys(store);
    return {
        ok: true,
        provider: p,
        modelIndex: modelIndex || prov.selectedModel,
        keyIndex,
        maskedKey: maskKey(key),
        status: keyObj.status
    };
}

function clearKeySlot(providerId, a, b) {
    const keyIndex = (b !== undefined && !isNaN(parseInt(b, 10))) ? parseInt(b, 10) : parseInt(a, 10);
    return setKeySlot(providerId, keyIndex, '');
}

function getKeySlot(providerId, a, b) {
    const p = String(providerId || '').toLowerCase().trim();
    const store = readKeys();
    const prov = store.providers[p];
    if (!prov) return null;

    const keyIndex = (b !== undefined && !isNaN(parseInt(b, 10))) ? parseInt(b, 10) : parseInt(a, 10);
    const modelIndex = (b !== undefined && !isNaN(parseInt(b, 10))) ? parseInt(a, 10) : prov.selectedModel;
    if (isNaN(keyIndex) || keyIndex < 1 || keyIndex > KEY_SLOT_COUNT) return null;

    const keyObj = prov.keys[keyIndex - 1];
    if (!keyObj) return null;
    const hash = hashKey(keyObj.key);
    const memCooldown = keyCooldowns.get(hash) || 0;
    const coolingDown = Date.now() < Math.max(keyObj.rateLimitedUntil || 0, memCooldown);
    const modelObj = prov.models[modelIndex - 1];

    return {
        provider: p,
        modelIndex: modelIndex || prov.selectedModel,
        modelId: modelObj?.id || '',
        keyIndex,
        configured: Boolean(keyObj.key),
        maskedKey: maskKey(keyObj.key),
        status: coolingDown ? 'coolingDown' : keyObj.status,
        coolingDown,
        rateLimitedUntil: keyObj.rateLimitedUntil,
        failureCount: keyObj.failureCount,
        lastUsed: keyObj.lastUsed,
        lastError: keyObj.lastError
    };
}

function getKeys(providerId) {
    const p = String(providerId || '').toLowerCase().trim();
    const store = readKeys();
    const prov = store.providers[p];
    if (!prov) return [];
    const now = Date.now();

    return prov.keys.map((k) => {
        const hash = hashKey(k.key);
        const cooldown = Math.max(k.rateLimitedUntil || 0, keyCooldowns.get(hash) || 0);
        const coolingDown = now < cooldown;
        return {
            index: k.index,
            id: k.id,
            label: k.label,
            configured: Boolean(k.key),
            maskedKey: maskKey(k.key),
            status: coolingDown ? 'coolingDown' : (k.key ? k.status : 'empty'),
            coolingDown,
            cooldownSec: coolingDown ? Math.ceil((cooldown - now) / 1000) : 0,
            lastUsed: k.lastUsed,
            lastError: k.lastError
        };
    });
}

function enableModel(providerId, modelIndex, enabled) {
    const p = String(providerId || '').toLowerCase().trim();
    const idx = parseInt(modelIndex, 10);
    if (!aiProviders.PROVIDER_IDS.includes(p) || isNaN(idx) || idx < 1 || idx > MODEL_SLOT_COUNT) {
        return { ok: false, error: 'Invalid provider or model slot.' };
    }
    const store = readKeys();
    store.providers[p].models[idx - 1].enabled = Boolean(enabled);
    writeKeys(store);
    return { ok: true, provider: p, modelIndex: idx, enabled: Boolean(enabled) };
}

function getProviderOverview(providerId) {
    const p = String(providerId || '').toLowerCase().trim();
    const store = readKeys();
    const prov = store.providers[p];
    if (!prov) return null;
    const def = aiProviders.getProvider(p);
    const now = Date.now();

    const models = prov.models.map((m) => ({
        index: m.index,
        id: m.id,
        label: m.label,
        enabled: m.enabled !== false,
        isSelected: m.index === prov.selectedModel
    }));

    const keys = prov.keys.map((k) => {
        const hash = hashKey(k.key);
        const cooldown = Math.max(k.rateLimitedUntil || 0, keyCooldowns.get(hash) || 0);
        const coolingDown = now < cooldown;
        return {
            index: k.index,
            id: k.id,
            label: k.label,
            configured: Boolean(k.key),
            maskedKey: maskKey(k.key),
            status: coolingDown ? 'coolingDown' : (k.key ? k.status : 'empty'),
            coolingDown,
            cooldownSec: coolingDown ? Math.ceil((cooldown - now) / 1000) : 0,
            lastUsed: k.lastUsed,
            lastError: k.lastError
        };
    });

    const configuredKeys = keys.filter((k) => k.configured);
    const availableKeys = configuredKeys.filter((k) => !k.coolingDown && k.status !== 'invalid');

    return {
        id: p,
        label: def.label,
        baseUrl: prov.baseUrl,
        selectedModel: prov.selectedModel,
        selectedModelId: prov.models[prov.selectedModel - 1]?.id || '',
        isActive: store.activeProvider === p,
        lastWorkingKey: prov.lastWorkingKey || 1,
        totalKeys: configuredKeys.length,
        availableKeys: availableKeys.length,
        models,
        keys
    };
}

function getAllProvidersOverview() {
    const store = readKeys();
    return {
        activeProvider: store.activeProvider,
        priority: store.providerPriority,
        providers: aiProviders.PROVIDER_IDS.map((p) => getProviderOverview(p))
    };
}

function getProviderHealth(providerId) {
    const p = String(providerId || '').toLowerCase().trim();
    const overview = getProviderOverview(p);
    if (!overview) {
        return { status: 'no_keys', totalKeys: 0, readyKeys: 0, coolingDownKeys: 0, models: [] };
    }
    const configuredKeys = overview.keys.filter((k) => k.configured);
    const readyKeys = configuredKeys.filter((k) => !k.coolingDown && k.status !== 'invalid');
    const coolingDownKeys = configuredKeys.filter((k) => k.coolingDown);
    let status = 'healthy';
    if (!configuredKeys.length) status = 'no_keys';
    else if (!readyKeys.length && coolingDownKeys.length) status = 'rate_limited';

    return {
        status,
        totalKeys: configuredKeys.length,
        readyKeys: readyKeys.length,
        coolingDownKeys: coolingDownKeys.length,
        models: overview.models.filter((m) => m.enabled && m.id).map((m) => m.id)
    };
}

/* ---------------------------------------------------- Compatibility Helpers */

function getModels(providerId) {
    const config = readConfig();
    const p = String(providerId || '').toLowerCase();
    const store = readKeys();
    if (store.providers && store.providers[p] && store.providers[p].models) {
        return store.providers[p].models.map((m) => m.id).filter(Boolean);
    }
    const prov = config.providers[p];
    if (prov && Array.isArray(prov.models) && prov.models.length) {
        return prov.models.map((m) => typeof m === 'object' ? m.id : m).filter(Boolean);
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
    if (aiProviders.isBlockedNonTextModel && aiProviders.isBlockedNonTextModel(clean)) {
        return { ok: false, error: `Model "${clean}" is a specialized non-text model (audio/TTS/robotics/embedding) and cannot be used for text auto-replies.` };
    }

    const store = readKeys();
    const prov = store.providers[p];
    let slotAssigned = false;
    for (let i = 0; i < MODEL_SLOT_COUNT; i++) {
        if (!prov.models[i].id || prov.models[i].id === clean) {
            prov.models[i].id = clean;
            slotAssigned = true;
            break;
        }
    }
    if (!slotAssigned) {
        prov.models[MODEL_SLOT_COUNT - 1].id = clean;
    }
    writeKeys(store);

    const config = readConfig();
    if (!config.providers[p]) config.providers[p] = { ...DEFAULT_PROVIDERS[p], models: [] };
    const current = getModels(p);
    if (!current.includes(clean)) current.push(clean);
    config.providers[p].models = current;
    writeConfig(config);

    return { ok: true, provider: p, models: current };
}

function removeModel(providerId, model) {
    const p = String(providerId || '').toLowerCase();
    if (!aiProviders.PROVIDER_IDS.includes(p)) {
        return { ok: false, error: `Unknown provider "${p}". Supported: gemini, groq, custom.` };
    }
    const clean = cleanModel(model);
    const store = readKeys();
    if (store.providers[p]) {
        for (const m of store.providers[p].models) {
            if (m.id === clean) m.id = '';
        }
        writeKeys(store);
    }
    const config = readConfig();
    if (config.providers[p]) {
        config.providers[p].models = (config.providers[p].models || []).filter((m) => m !== clean);
        writeConfig(config);
    }
    return { ok: true, provider: p, models: getModels(p) };
}

function setModels(providerId, models) {
    const p = String(providerId || '').toLowerCase();
    if (!aiProviders.PROVIDER_IDS.includes(p)) {
        return { ok: false, error: `Unknown provider "${p}". Supported: gemini, groq, custom.` };
    }
    if (!Array.isArray(models)) return { ok: false, error: 'Models must be an array.' };
    const cleanList = models.map(cleanModel).filter(validModelId).filter(Boolean);

    const store = readKeys();
    if (store.providers[p]) {
        for (let i = 0; i < MODEL_SLOT_COUNT; i++) {
            store.providers[p].models[i].id = cleanList[i] || '';
        }
        writeKeys(store);
    }

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

    const store = readKeys();
    if (store.providers[p]) store.providers[p].baseUrl = clean;
    writeKeys(store);

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

function generateKeyId(providerId) {
    return `${providerId.slice(0, 3)}_${crypto.randomBytes(3).toString('hex')}`;
}

function addKey(providerId, apiKey, options = {}) {
    const p = String(providerId || '').toLowerCase();
    if (!aiProviders.PROVIDER_IDS.includes(p)) {
        return { ok: false, error: `Unknown provider "${p}". Supported: gemini, groq, custom.` };
    }
    const key = String(apiKey || '').trim();
    if (key.length < 6 || key.length > 300 || /\s/.test(key) || isPlaceholderKey(key)) {
        return { ok: false, error: 'That does not look like a valid API key (placeholder keys are rejected).' };
    }

    const store = readKeys();
    const prov = store.providers[p];
    if (!prov) return { ok: false, error: `Unknown provider "${p}".` };

    let targetKeySlot = prov.keys.find((k) => k.key === key);
    let keyIdx = targetKeySlot ? targetKeySlot.index : null;

    if (!targetKeySlot) {
        targetKeySlot = prov.keys.find((k) => !k.key);
        if (targetKeySlot) {
            keyIdx = targetKeySlot.index;
        } else {
            // Overwrite Key 4 if all 4 are full
            targetKeySlot = prov.keys[KEY_SLOT_COUNT - 1];
            keyIdx = KEY_SLOT_COUNT;
        }
    }

    const keyId = options.id || targetKeySlot.id || `${p}_key_${keyIdx}`;
    targetKeySlot.id = keyId;
    targetKeySlot.key = key;
    targetKeySlot.label = String(options.label || (keyIdx === 1 ? 'Primary Key' : `Backup Key ${keyIdx}`)).slice(0, 40);
    targetKeySlot.status = 'active';
    targetKeySlot.rateLimitedUntil = 0;
    targetKeySlot.failureCount = 0;

    // Sync legacy slot
    for (const id of SLOT_IDS) {
        const slot = getSlot(id);
        if (slot && slot.provider === p && (!store.slots[id] || keyIdx === 1)) {
            store.slots[id] = key;
        }
    }

    if (!store.keys[p]) store.keys[p] = [];
    const legacyExisting = store.keys[p].find((k) => k.key === key);
    if (!legacyExisting) {
        store.keys[p].push({
            id: keyId,
            key,
            index: keyIdx,
            keyIndex: keyIdx,
            label: targetKeySlot.label,
            rateLimitedUntil: 0,
            failureCount: 0
        });
    }

    writeKeys(store);
    return { ok: true, id: keyId, maskedKey: maskKey(key), provider: p, keyIndex: keyIdx };
}

function removeKey(providerId, keyId) {
    const p = String(providerId || '').toLowerCase();
    if (!aiProviders.PROVIDER_IDS.includes(p)) {
        return { ok: false, error: `Unknown provider "${p}".` };
    }
    const target = String(keyId || '').trim().toLowerCase();
    const store = readKeys();
    const prov = store.providers[p];
    if (!prov) return { ok: false, error: 'No keys configured for this provider.' };

    let removed = false;
    let removedId = '';

    for (const k of prov.keys) {
        if (k.id.toLowerCase() === target || maskKey(k.key).toLowerCase().includes(target) || k.key === keyId || String(k.index) === target) {
            removedId = k.id;
            k.key = '';
            k.status = 'empty';
            k.rateLimitedUntil = 0;
            k.failureCount = 0;
            removed = true;
        }
    }

    if (store.keys && Array.isArray(store.keys[p])) {
        store.keys[p] = store.keys[p].filter((k) => k.id.toLowerCase() !== target && k.key !== keyId);
    }

    writeKeys(store);
    return { ok: true, removedId: removedId || keyId };
}

function editKey(providerId, keyId, patch = {}) {
    const p = String(providerId || '').toLowerCase();
    const target = String(keyId || '').trim().toLowerCase();
    const store = readKeys();
    const prov = store.providers[p];
    if (!prov) return { ok: false, error: 'Provider not found.' };

    let foundKey = prov.keys.find((k) => k.id.toLowerCase() === target || String(k.index) === target);
    if (!foundKey) return { ok: false, error: `Key "${keyId}" not found.` };

    if (patch.label !== undefined) foundKey.label = String(patch.label).slice(0, 40);
    if (patch.key && String(patch.key).trim()) {
        const newKey = String(patch.key).trim();
        if (newKey.length < 6 || newKey.length > 300 || /\s/.test(newKey)) {
            return { ok: false, error: 'Invalid API key format.' };
        }
        foundKey.key = newKey;
    }
    writeKeys(store);
    return { ok: true, key: { id: foundKey.id, maskedKey: maskKey(foundKey.key), label: foundKey.label } };
}

function getKeysPublic(providerId) {
    const p = String(providerId || '').toLowerCase();
    const store = readKeys();
    const prov = store.providers[p];
    if (!prov) return [];
    const now = Date.now();
    const list = [];

    for (const k of prov.keys) {
        if (k.key) {
            const hash = hashKey(k.key);
            const inMemCooldown = keyCooldowns.get(hash) || 0;
            const until = Math.max(k.rateLimitedUntil || 0, inMemCooldown);
            const coolingDown = now < until;
            const cooldownRemainingMs = coolingDown ? until - now : 0;
            const stats = keyStats.get(hash) || {};

            list.push({
                id: k.id,
                maskedKey: maskKey(k.key),
                keyIndex: k.index,
                label: k.label,
                coolingDown,
                cooldownRemainingSec: Math.ceil(cooldownRemainingMs / 1000),
                failureCount: k.failureCount || 0,
                lastUsed: k.lastUsed || stats.lastUsed || null,
                lastError: k.lastError || stats.lastError || null
            });
        }
    }

    return list;
}

function markKeyRateLimited(key, cooldownMs = DEFAULT_COOLDOWN_MS) {
    const hash = hashKey(key);
    const until = Date.now() + cooldownMs;
    keyCooldowns.set(hash, until);

    const stats = keyStats.get(hash) || { attempts: 0, successes: 0, rateLimits: 0 };
    stats.rateLimits = (stats.rateLimits || 0) + 1;
    stats.lastError = '429 rate limit';
    keyStats.set(hash, stats);

    try {
        const store = readKeys();
        for (const p of aiProviders.PROVIDER_IDS) {
            if (store.providers[p] && store.providers[p].keys) {
                for (const k of store.providers[p].keys) {
                    if (k.key === key) {
                        k.rateLimitedUntil = until;
                        k.status = 'coolingDown';
                        k.lastError = '429 rate limit exceeded';
                        break;
                    }
                }
            }
        }
        writeKeys(store);
    } catch {}
}

function markKeySuccess(key) {
    const hash = hashKey(key);
    keyCooldowns.delete(hash);
    const stats = keyStats.get(hash) || { attempts: 0, successes: 0, rateLimits: 0 };
    stats.successes = (stats.successes || 0) + 1;
    stats.lastError = null;
    keyStats.set(hash, stats);
}

function markKeyInvalid(key, errorMsg) {
    const hash = hashKey(key);
    const stats = keyStats.get(hash) || { attempts: 0, successes: 0, rateLimits: 0 };
    stats.lastError = errorMsg || 'invalid API key';
    keyStats.set(hash, stats);

    try {
        const store = readKeys();
        for (const p of aiProviders.PROVIDER_IDS) {
            if (store.providers[p] && store.providers[p].keys) {
                for (const k of store.providers[p].keys) {
                    if (k.key === key) {
                        k.status = 'invalid';
                        k.lastError = errorMsg || 'invalid API key';
                        break;
                    }
                }
            }
        }
        writeKeys(store);
    } catch {}
}

function clearCooldowns() {
    keyCooldowns.clear();
    try {
        const store = readKeys();
        for (const p of aiProviders.PROVIDER_IDS) {
            if (store.providers[p] && store.providers[p].keys) {
                for (const k of store.providers[p].keys) {
                    k.rateLimitedUntil = 0;
                    if (k.status === 'coolingDown') k.status = 'active';
                }
            }
        }
        writeKeys(store);
    } catch {}
}

function getCandidateKeys(providerId, model, targetSlot = null) {
    const p = String(providerId || '').toLowerCase();
    const store = readKeys();
    const prov = store.providers[p];
    const keys = [];
    const seen = new Set();

    // 1. If targetSlot has explicit apiKey, it is primary for this slot
    const targetApiKey = targetSlot && typeof targetSlot.apiKey === 'string' ? targetSlot.apiKey.trim() : '';
    if (targetApiKey && targetApiKey.length >= 6 && !isPlaceholderKey(targetApiKey) && (targetSlot.provider === p || targetSlot.providerId === p)) {
        keys.push({ id: `slot_${targetSlot.id}`, key: targetApiKey, label: targetSlot.label, keyIndex: 1 });
        seen.add(targetApiKey);
    }

    if (prov && Array.isArray(prov.keys)) {
        const startIdx = prov.lastWorkingKey || 1;
        const ordered = [];
        for (let i = 0; i < KEY_SLOT_COUNT; i++) {
            const k = prov.keys[((startIdx - 1 + i) % KEY_SLOT_COUNT)];
            if (k && k.key && !seen.has(k.key)) {
                ordered.push(k);
                seen.add(k.key);
            }
        }
        for (const k of ordered) {
            keys.push({ id: k.id, key: k.key, label: k.label, keyIndex: k.index });
        }
    }

    if (!keys.length && store.keys && Array.isArray(store.keys[p])) {
        for (const lk of store.keys[p]) {
            if (lk && lk.key && !seen.has(lk.key)) {
                keys.push({ id: lk.id, key: lk.key, label: lk.label, keyIndex: lk.index || 1 });
                seen.add(lk.key);
            }
        }
    }

    return keys;
}

/* ---------------------------------------------------- Slot Resolution */

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
        const candidates = getCandidateKeys(raw.provider, raw.model, raw);
        if (candidates.length) {
            apiKey = candidates[0].key;
            keySource = 'provider';
        }
    }

    if (!apiKey && raw.apiKeyEnv && process.env[raw.apiKeyEnv]) {
        apiKey = String(process.env[raw.apiKeyEnv] || '').trim();
        keySource = 'env';
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

    const provStore = store.providers[raw.provider];
    const baseUrl = raw.baseUrl || (provStore && provStore.baseUrl) || provider.baseUrl || '';

    return {
        id: raw.id,
        label: raw.label,
        providerId: raw.provider,
        providerLabel: provider.label,
        baseUrl,
        model,
        apiKey,
        keySource,
        vision: raw.vision || Boolean(provider.vision),
        enabled: raw.enabled,
        apiKeyEnv: raw.apiKeyEnv,
        keyConfigured: Boolean(apiKey),
        maskedKey: maskKey(apiKey)
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

function primarySlot() {
    const order = getOrder();
    for (const id of order) {
        const slot = resolveSlot(id);
        if (slot && slot.enabled && slot.apiKey && slot.baseUrl && slot.model) return slot;
    }
    return resolveSlot(order[0]) || null;
}

function saveSlot(id, patch = {}) {
    const wanted = String(id || '').toLowerCase();
    if (!SLOT_IDS.includes(wanted)) {
        return { ok: false, error: `Invalid slot "${id}". Expected one of: ${SLOT_IDS.join(', ')}.` };
    }

    const config = readConfig();
    const slot = config.slots.find((s) => s.id === wanted);
    if (!slot) return { ok: false, error: `Slot ${wanted} not found.` };

    let targetProvider = slot.provider;
    if (patch.provider !== undefined) {
        const rawProv = String(patch.provider).toLowerCase().trim();
        const p = rawProv === 'openrouter' ? 'custom' : rawProv;
        if (!aiProviders.PROVIDER_IDS.includes(p)) {
            return { ok: false, error: `Invalid provider "${patch.provider}".` };
        }
        slot.provider = p;
        targetProvider = p;
    }

    if (patch.baseUrl !== undefined) {
        const clean = normaliseBaseUrl(patch.baseUrl);
        if (!validBaseUrl(clean)) {
            return { ok: false, error: 'Base URL must start with http:// or https://' };
        }
        slot.baseUrl = clean;
    }
    if (patch.model !== undefined) {
        const clean = cleanModel(patch.model);
        if (!validModelId(clean)) {
            return { ok: false, error: 'Model ID must contain letters, numbers, hyphens, slashes and dots only.' };
        }
        slot.model = clean;
    }
    if (patch.vision !== undefined) slot.vision = Boolean(patch.vision);
    if (patch.enabled !== undefined) slot.enabled = Boolean(patch.enabled);

    const store = readKeys();
    if (!store.slotProviders) store.slotProviders = {};
    store.slotProviders[wanted] = targetProvider;

    if (patch.clearKey) {
        delete store.slots[wanted];
        writeKeys(store);
    } else if (patch.apiKey !== undefined) {
        const cleanKey = String(patch.apiKey || '').trim();
        if (cleanKey && isPlaceholderKey(cleanKey)) {
            return { ok: false, error: 'Placeholder API key was rejected.' };
        }
        if (cleanKey) {
            store.slots[wanted] = cleanKey;
            writeKeys(store);
        } else {
            delete store.slots[wanted];
            writeKeys(store);
        }
    }

    if (!writeConfig(config)) return { ok: false, error: 'Failed to write configuration file.' };
    return { ok: true, slot: resolveSlot(wanted) };
}

function setOrder(order) {
    if (!Array.isArray(order) || order.length === 0) {
        return { ok: false, error: 'Order must be a non-empty array of slots.' };
    }
    const clean = order.map((id) => String(id).toLowerCase().trim());
    for (const id of clean) {
        if (!SLOT_IDS.includes(id)) {
            return { ok: false, error: `Invalid slot "${id}". Valid slots: ${SLOT_IDS.join(', ')}.` };
        }
    }
    const finalOrder = [];
    for (const id of clean) if (!finalOrder.includes(id)) finalOrder.push(id);
    for (const id of SLOT_IDS) if (!finalOrder.includes(id)) finalOrder.push(id);

    const config = readConfig();
    config.order = finalOrder;
    if (!writeConfig(config)) return { ok: false, error: 'Failed to save slot order.' };
    return { ok: true, order: finalOrder };
}

function setKey(id, apiKey) {
    return saveSlot(id, { apiKey });
}

/* ---------------------------------------------------- chatWithFailover */

function providerTimeoutMs(limits, custom) {
    if (custom && Number(custom) > 0) return Number(custom);
    return limits.timeoutMs || FAST.timeoutMs;
}

function safeMessage(err, rawKey) {
    const raw = String(err?.message || err || 'Unknown AI error');
    if (!rawKey || typeof rawKey !== 'string') return raw;
    const clean = rawKey.trim();
    if (clean.length < 6) return raw;
    return raw.split(clean).join(maskKey(clean));
}

/**
 * Executes a conversation turn with independent model selection & strict key rotation.
 *
 * Requirements:
 * 1. Model stays strictly on the user-selected model.
 * 2. It rotates keys belonging to this model on 429 / failure.
 * 3. Never switches to Model 2 of the same provider!
 * 4. Remembers the last successful key (stickiness).
 * 5. Falls back to next provider only if all keys for this model fail.
 */
async function chatWithFailover(messages, options = {}) {
    const started = Date.now();
    const config = readConfig();
    const store = readKeys();
    const depth = options.depth === 'detailed' ? 'detailed' : 'fast';
    const limits = {
        maxTokens: Number(options.maxTokens) || config[depth].maxTokens || config.maxTokens,
        timeoutMs: Number(options.timeoutMs) || config[depth].timeoutMs || config.timeoutMs
    };
    const attempts = [];
    const skipped = [];
    const wantVision = Boolean(options.vision);

    // Build ordered list of targets.
    // Check if slots are customized (e.g. unit tests setting slots directly)
    const targets = [];
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
        targets.push(slot);
    }

    if (!targets.length) {
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

    for (const slot of targets) {
        const providerId = slot.providerId;
        const providerLabel = slot.providerLabel;
        const provStore = store.providers[providerId];
        const baseUrl = slot.baseUrl;

        // Model to use for this provider is STRICTLY determined by:
        // 1. Explicit slot model if customized
        // 2. Or the provider's selectedModel (Model 1..4)
        const selectedModelIdx = provStore ? (provStore.selectedModel || 1) : 1;
        const modelObj = provStore ? provStore.models[selectedModelIdx - 1] : null;
        const modelId = slot.model || modelObj?.id || provStore?.models[0]?.id || '';

        if (!modelId || (aiProviders.isBlockedNonTextModel && aiProviders.isBlockedNonTextModel(modelId))) {
            skipped.push({ slot: slot.id, provider: providerLabel, reason: 'invalid or non-text model' });
            continue;
        }

        // Gather all keys belonging to this provider's shared key pool
        const modelKeys = [];
        const seenKeys = new Set();

        // 1. If slot has explicit apiKey, try it first
        if (slot.apiKey && !isPlaceholderKey(slot.apiKey)) {
            modelKeys.push({ id: `slot_${slot.id}`, key: slot.apiKey, keyIndex: 1, label: slot.label });
            seenKeys.add(slot.apiKey);
        }

        // 2. Shared keys assigned to this provider (starting from lastWorkingKey)
        if (provStore && Array.isArray(provStore.keys)) {
            const startKeyIdx = provStore.lastWorkingKey || 1;
            const orderedKeySlots = [];
            for (let i = 0; i < KEY_SLOT_COUNT; i++) {
                const k = provStore.keys[((startKeyIdx - 1 + i) % KEY_SLOT_COUNT)];
                if (k && k.key && !isPlaceholderKey(k.key) && !seenKeys.has(k.key)) {
                    orderedKeySlots.push(k);
                    seenKeys.add(k.key);
                }
            }
            for (const k of orderedKeySlots) {
                modelKeys.push({ id: k.id, key: k.key, keyIndex: k.index, label: k.label });
            }
        }

        // 3. Fallback candidate keys for this provider if modelKeys is still empty
        if (!modelKeys.length) {
            const candidates = getCandidateKeys(providerId, modelId, slot);
            for (const c of candidates) {
                if (c && c.key && !seenKeys.has(c.key)) {
                    modelKeys.push({ id: c.id, key: c.key, keyIndex: c.keyIndex || 1, label: c.label });
                    seenKeys.add(c.key);
                }
            }
        }

        if (!modelKeys.length) {
            skipped.push({ slot: slot.id, provider: providerLabel, model: modelId, reason: 'no API keys' });
            continue;
        }

        // Filter out keys in cooldown
        const now = Date.now();
        let usableKeys = modelKeys.filter((k) => {
            const hash = hashKey(k.key);
            const cool = keyCooldowns.get(hash) || 0;
            return now >= cool;
        });
        if (!usableKeys.length) usableKeys = modelKeys.slice();

        // STRICT REQUIREMENT:
        // Try only keys assigned to this provider for the selected model.
        // NEVER switch to another model of the same provider automatically!
        let providerSuccess = false;

        for (const keyItem of usableKeys) {
            const rawKey = keyItem.key;
            const slotStarted = Date.now();
            try {
                const text = await aiProviders.chat(messages, {
                    provider: providerId,
                    apiKey: rawKey,
                    baseUrl,
                    model: modelId,
                    temperature: options.temperature,
                    maxTokens: limits.maxTokens,
                    timeout: providerTimeoutMs(limits, options.timeout)
                });

                attempts.push({
                    slot: slot.id,
                    provider: providerLabel,
                    model: modelId,
                    keyId: keyItem.id,
                    ok: true,
                    ms: Date.now() - slotStarted
                });

                // Update stickiness: remember last working key in provider store!
                if (provStore) {
                    provStore.lastWorkingKey = keyItem.keyIndex || 1;
                    const keySlot = provStore.keys[keyItem.keyIndex - 1];
                    if (keySlot) {
                        keySlot.status = 'active';
                        keySlot.lastUsed = new Date().toISOString();
                    }
                    writeKeys(store);
                }
                markKeySuccess(rawKey);

                return {
                    text,
                    slot: slot.id,
                    provider: providerLabel,
                    providerId,
                    model: modelId,
                    modelIndex: selectedModelIdx,
                    keyIndex: keyItem.keyIndex || 1,
                    maskedKey: maskKey(rawKey),
                    depth,
                    attempts,
                    skipped,
                    ms: Date.now() - started
                };
            } catch (err) {
                const status = err.status || (String(err?.message || '').includes('429') ? 429 : (String(err?.message || '').includes('401') ? 401 : null));
                const isRateLimit = aiProviders.isRateLimitError(err, status);
                const isInvalid = aiProviders.isInvalidKeyError(err, status);
                const isModelNotFound = (aiProviders.isModelNotFoundError && aiProviders.isModelNotFoundError(err, status)) || status === 404;
                const reason = safeMessage(err, rawKey);

                attempts.push({
                    slot: slot.id,
                    provider: providerLabel,
                    model: modelId,
                    keyId: keyItem.id,
                    ok: false,
                    error: reason,
                    ms: Date.now() - slotStarted
                });

                if (isRateLimit) {
                    markKeyRateLimited(rawKey, DEFAULT_COOLDOWN_MS);
                    console.warn(`[aiRotation] ${providerLabel} key (${keyItem.id || maskKey(rawKey)}) rate-limited (429). Rotating to next key for model ${modelId}...`);
                    continue; // Try next key of this same model
                } else if (isInvalid) {
                    markKeyInvalid(rawKey, reason);
                    console.warn(`[aiRotation] ${providerLabel} key (${keyItem.id || maskKey(rawKey)}) is invalid (401). Skipping key...`);
                    continue; // Try next key of this same model
                } else if (isModelNotFound) {
                    console.warn(`[aiRotation] ${providerLabel} model ${modelId} not found (404).`);
                    break; // Break key loop for this model
                } else {
                    console.error(`[aiConfig] ${slot.label} (${providerLabel}/${modelId}) failed: ${reason}`);
                    continue; // Try next key of this same model
                }
            }
        }
        // If all keys for this model failed, loop moves to NEXT SLOT/PROVIDER,
        // NEVER to Model 2 of the same provider!
    }

    const error = new Error(
        attempts.length
            ? `All AI providers failed: ${attempts.map((a) => `${a.provider || a.slot}: ${a.error || 'failed'}`).join(' | ')}`
            : 'No AI provider is configured with a base URL, model and API key.'
    );
    error.attempts = attempts;
    error.skipped = skipped;
    error.code = 'ALL_PROVIDERS_FAILED';
    throw error;
}

/* ---------------------------------------------------- Testing & Diagnostics */

async function testSlot(id, prompt = 'Say hello in one short line.', overrides = {}) {
    const started = Date.now();
    const resolved = resolveSlot(id);
    if (!resolved) return { ok: false, error: `Slot "${id}" not found.` };
    const slot = { ...resolved, ...overrides };

    if (!slot.baseUrl) return { ok: false, slot: slot.id, provider: slot.providerLabel, error: 'No base URL configured.' };
    if (!slot.model) return { ok: false, slot: slot.id, provider: slot.providerLabel, error: 'No model configured.' };
    if (!slot.apiKey) return { ok: false, slot: slot.id, provider: slot.providerLabel, error: 'No API key configured.' };

    try {
        const text = await aiProviders.chat(
            [
                { role: 'system', content: 'You are AYHA. Answer in one short sentence.' },
                { role: 'user', content: String(prompt || 'Say hello').slice(0, 300) }
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
    const provDef = aiProviders.getProvider(p);
    const store = readKeys();
    let rawKey = String(keyIdOrKey || '').trim();

    // Check if keyId was passed
    const candidates = getCandidateKeys(p, '');
    const match = candidates.find((k) => k.id && k.id.toLowerCase() === rawKey.toLowerCase());
    if (match) rawKey = match.key;

    const models = getModels(p);
    const model = models[0] || provDef.defaultModel;

    if (!rawKey) {
        if (candidates.length) rawKey = candidates[0].key;
    }

    if (!rawKey) {
        return { ok: false, error: `No API key configured for ${provDef.label}. Set one with .aiprovider key ${p} <key>` };
    }

    const provStore = store.providers[p];
    const baseUrl = (provStore && provStore.baseUrl) || provDef.baseUrl;
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
            provider: provDef.label,
            providerId: p,
            model,
            maskedKey: maskKey(rawKey),
            reply: text,
            ms: Date.now() - started
        };
    } catch (err) {
        return {
            ok: false,
            provider: provDef.label,
            providerId: p,
            model,
            maskedKey: maskKey(rawKey),
            error: safeMessage(err, rawKey),
            ms: Date.now() - started
        };
    }
}

async function testModelKey(providerId, modelIndex = null, keyIndex = null, prompt = 'Say hello in one short line.') {
    const p = String(providerId || '').toLowerCase().trim();
    const provDef = aiProviders.getProvider(p);
    const store = readKeys();
    const prov = store.providers[p];
    if (!prov) return { ok: false, error: `Unknown provider "${p}".` };

    const mIdx = (modelIndex !== null && modelIndex !== undefined && String(modelIndex).trim() !== '')
        ? parseInt(modelIndex, 10)
        : (prov.selectedModel || 1);

    if (isNaN(mIdx) || mIdx < 1 || mIdx > MODEL_SLOT_COUNT) {
        return { ok: false, error: `Invalid model slot index (1-${MODEL_SLOT_COUNT}).` };
    }
    const modelObj = prov.models[mIdx - 1];
    if (!modelObj || !modelObj.id) {
        return { ok: false, error: `No model ID configured for ${provDef.label} Model ${mIdx}.` };
    }

    let rawKey = '';
    let usedKeyIndex = null;
    let masked = '';

    if (keyIndex !== null && keyIndex !== undefined && String(keyIndex).trim() !== '') {
        const kIdx = parseInt(keyIndex, 10);
        if (isNaN(kIdx) || kIdx < 1 || kIdx > KEY_SLOT_COUNT) {
            return { ok: false, error: `Invalid key slot index (1-${KEY_SLOT_COUNT}).` };
        }
        const keyObj = prov.keys[kIdx - 1];
        if (!keyObj || !keyObj.key) {
            return { ok: false, error: `No API key configured in ${provDef.label} Key ${kIdx}.` };
        }
        rawKey = keyObj.key;
        usedKeyIndex = kIdx;
        masked = maskKey(rawKey);
    } else {
        const startIdx = prov.lastWorkingKey || 1;
        const candidateKeys = [];
        for (let i = 0; i < KEY_SLOT_COUNT; i++) {
            const idx = ((startIdx - 1 + i) % KEY_SLOT_COUNT);
            const k = prov.keys[idx];
            if (k && k.key && !isPlaceholderKey(k.key)) {
                candidateKeys.push(k);
            }
        }
        if (!candidateKeys.length) {
            return { ok: false, error: `No API keys configured for ${provDef.label}.` };
        }
        rawKey = candidateKeys[0].key;
        usedKeyIndex = candidateKeys[0].index;
        masked = maskKey(rawKey);
    }

    const started = Date.now();
    try {
        const reply = await aiProviders.chat(
            [
                { role: 'system', content: 'You are AYHA. Answer in one short sentence.' },
                { role: 'user', content: String(prompt || 'Say hello').slice(0, 300) }
            ],
            {
                provider: p,
                apiKey: rawKey,
                baseUrl: prov.baseUrl,
                model: modelObj.id,
                maxTokens: TEST_MAX_TOKENS,
                timeout: TEST_TIMEOUT_MS
            }
        );
        return {
            ok: true,
            provider: provDef.label,
            providerId: p,
            model: modelObj.id,
            modelIndex: mIdx,
            keyIndex: usedKeyIndex,
            maskedKey: masked,
            reply,
            ms: Date.now() - started
        };
    } catch (err) {
        return {
            ok: false,
            provider: provDef.label,
            providerId: p,
            model: modelObj.id,
            modelIndex: mIdx,
            keyIndex: usedKeyIndex,
            error: safeMessage(err, rawKey),
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
        const store = readKeys();
        const provStore = store.providers[term];
        baseUrl = (provStore && provStore.baseUrl) || prov.baseUrl;
        const candidates = getCandidateKeys(term);
        if (candidates.length) apiKey = candidates[0].key;
    }

    if (!apiKey) {
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

function resetConfig() {
    const config = defaultConfig();
    writeConfig(config);
    const store = {
        version: 3,
        activeProvider: 'groq',
        providerPriority: DEFAULT_PRIORITY.slice(),
        slots: {},
        slotProviders: {},
        providers: {},
        keys: { groq: [], gemini: [], custom: [] }
    };
    for (const p of aiProviders.PROVIDER_IDS) {
        store.providers[p] = createDefaultProviderStore(p);
    }
    writeKeys(store);
    return config;
}

function setActiveModel(modelId, providerId = null) {
    const clean = cleanModel(modelId);
    if (!validModelId(clean) || !clean) {
        return { ok: false, error: 'Invalid model ID.' };
    }
    if (aiProviders.isBlockedNonTextModel && aiProviders.isBlockedNonTextModel(clean)) {
        return { ok: false, error: `Model "${clean}" is a specialized non-text model (audio/transcribe/TTS/robotics/embedding) and cannot be used for text chat.` };
    }
    const store = readKeys();
    const p = providerId ? String(providerId).toLowerCase().trim() : (store.activeProvider || 'groq');
    if (!aiProviders.PROVIDER_IDS.includes(p)) {
        return { ok: false, error: `Invalid provider "${p}".` };
    }

    const prov = store.providers[p];
    const mIdx = prov.selectedModel || 1;
    prov.models[mIdx - 1].id = clean;
    writeKeys(store);

    const config = readConfig();
    const prim = config.slots.find((s) => s.id === 'primary');
    if (prim && prim.provider === p) prim.model = clean;
    writeConfig(config);

    return { ok: true, provider: p, model: clean, modelIndex: mIdx };
}

function getGroqRankings() {
    return GROQ_MODEL_RANKINGS.slice();
}

function getGeminiRankings() {
    return GEMINI_MODEL_RANKINGS.slice();
}

module.exports = {
    SLOT_IDS,
    SLOT_LABELS,
    CONFIG_FILE,
    KEYS_FILE,
    MODEL_SLOT_COUNT,
    KEY_SLOT_COUNT,
    readConfig,
    writeConfig,
    readKeys,
    getSlot,
    getOrder,
    getSlotsPublic,
    statusSummary,
    resolveSlot,
    primarySlot,
    saveSlot,
    setOrder,
    setKey,
    // Independent multi-model & multi-key architecture
    getActiveProvider,
    setActiveProvider,
    getSelectedModel,
    selectModel,
    setModelId,
    setKeySlot,
    getKeySlot,
    clearKeySlot,
    enableModel,
    getProviderOverview,
    getAllProvidersOverview,
    testModelKey,
    // Multi-key & multi-model backward compatibility
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
    validModelId,
    // Central AYHA controls & rankings
    resetConfig,
    setActiveModel,
    getGroqRankings,
    getGeminiRankings,
    isPlaceholderKey,
    DEFAULT_PROVIDERS,
    GROQ_MODEL_RANKINGS,
    GEMINI_MODEL_RANKINGS
};
