'use strict';
/**
 * Three configurable AI providers with ordered failover.
 *
 *   config/aiProviders.json   non-secret settings (base URL, model, provider,
 *                             vision flag, order, token/timeout budgets)
 *   data/aiProviders.json     API keys only (gitignored, never logged/served)
 *   env (…​_API_KEY)          keys for servers where a file is undesirable
 *
 * Request flow: primary → fallback 1 → fallback 2. A slot is skipped when it is
 * disabled, has no key, or (for an image) has no vision support. Nothing retries
 * forever: each slot is attempted once with a bounded timeout.
 *
 * Safe diagnostics only — an API key is never written to a log, an error
 * message or the dashboard payload.
 */
const fs = require('fs');
const path = require('path');
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

const DEFAULT_SLOTS = [
    {
        id: 'primary',
        label: SLOT_LABELS.primary,
        provider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        model: 'openrouter/free',
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

function readJsonFile(file, fallback) {
    try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        return data && typeof data === 'object' ? data : fallback;
    } catch (err) {
        return fallback;
    }
}

function writeJsonFile(file, data) {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(data, null, 2));
        return true;
    } catch (err) {
        console.error('[aiConfig] could not save', path.basename(file), err.message);
        return false;
    }
}

function maskKey(key) {
    const value = String(key || '');
    if (!value) return '';
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
    } catch (err) {
        return false;
    }
}

function normaliseBaseUrl(value) {
    return String(value || '').trim().replace(/\/+$/, '');
}

/* ------------------------------------------------------------------ config */

function defaultConfig() {
    return {
        version: 1,
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
    if (data) {
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
    }
    return config;
}

function writeConfig(config) {
    return writeJsonFile(CONFIG_FILE, {
        version: 1,
        order: config.order,
        fast: config.fast,
        detailed: config.detailed,
        slots: config.slots
    });
}

function readKeys() {
    const data = readJsonFile(KEYS_FILE, {});
    return data.keys && typeof data.keys === 'object' ? { ...data.keys } : {};
}

function writeKeys(keys) {
    const clean = {};
    for (const id of SLOT_IDS) {
        const value = String(keys[id] || '').trim();
        if (value) clean[id] = value;
    }
    return writeJsonFile(KEYS_FILE, { keys: clean, updatedAt: new Date().toISOString() });
}

function getSlot(id) {
    const wanted = String(id || '').toLowerCase();
    return readConfig().slots.find((slot) => slot.id === wanted) || null;
}

function getOrder() {
    return readConfig().order.slice();
}

function legacySelection() {
    const data = readJsonFile(LEGACY_FILE, {});
    const providerId = aiProviders.PROVIDER_IDS.includes(String(data.provider || '').toLowerCase())
        ? String(data.provider).toLowerCase()
        : 'openrouter';
    const savedKeys = data.keys && typeof data.keys === 'object' ? data.keys : {};
    return {
        provider: providerId,
        key: String(savedKeys[providerId] || data.apiKey || '').trim(),
        model: cleanModel((data.models && data.models[providerId]) || data.model || '')
    };
}

/**
 * Resolve one slot into what a request needs. Key order:
 * dashboard-saved key → slot env var → provider env vars → legacy selection
 * (primary only, so an existing setup keeps working after the upgrade).
 */
function resolveSlot(id) {
    const config = readConfig();
    const raw = config.slots.find((slot) => slot.id === id) || getSlot(id);
    if (!raw) return null;
    const provider = aiProviders.getProvider(raw.provider);
    const keys = readKeys();
    let apiKey = String(keys[raw.id] || '').trim();
    let keySource = apiKey ? 'saved' : '';
    if (!apiKey && raw.apiKeyEnv && process.env[raw.apiKeyEnv]) {
        apiKey = String(process.env[raw.apiKeyEnv] || '').trim();
        keySource = 'env';
    }
    if (!apiKey) {
        for (const name of provider.envKeys || []) {
            const value = String(process.env[name] || '').trim();
            if (value) {
                apiKey = value;
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
    if (!model) model = provider.defaultModel || '';

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

/** Dashboard/command view — masked key, never the secret. */
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
        usable: usable.map((slot) => slot.id)
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
    const provider = aiProviders.getProvider(slot.provider);

    if (patch.provider !== undefined) {
        const providerId = String(patch.provider || '').toLowerCase();
        if (!aiProviders.PROVIDER_IDS.includes(providerId)) {
            return { ok: false, error: 'Unknown provider. Use openrouter, gemini, huggingface, openai, groq or custom.' };
        }
        if (providerId !== slot.provider) {
            // Switching preset also adopts that preset's endpoint and default model,
            // unless the caller sends its own base URL/model in the same request.
            const next = aiProviders.getProvider(providerId);
            slot.provider = providerId;
            if (patch.baseUrl === undefined) slot.baseUrl = next.baseUrl || '';
            if (patch.model === undefined) slot.model = next.defaultModel || '';
            slot.vision = Boolean(next.vision);
        }
    }

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
        if (key.length < 8 || key.length > 300 || /\s/.test(key)) {
            return { ok: false, error: 'That does not look like an API key.' };
        }
        const keys = readKeys();
        keys[slotId] = key;
        if (!writeKeys(keys)) return { ok: false, error: 'Could not store the key on this server.' };
        // Saving a key readies the slot unless the caller turned it off explicitly.
        if (patch.enabled === undefined) slot.enabled = true;
    }

    if (patch.clearKey) {
        const keys = readKeys();
        delete keys[slotId];
        if (!writeKeys(keys)) return { ok: false, error: 'Could not update the stored keys.' };
    }

    // A custom endpoint with no base URL can never work — guard the config.
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
    // Provider errors can be long HTML/JSON blobs — keep the diagnostic short.
    return message.replace(/\s+/g, ' ').slice(0, 220);
}

function providerTimeoutMs(limits, slot) {
    return Math.max(5000, Number(limits.timeoutMs) || FAST.timeoutMs);
}

/**
 * One chat call with ordered failover.
 * options: { depth: 'fast'|'detailed', vision: boolean, temperature, maxTokens, timeoutMs }
 * Returns { text, slot, provider, model, attempts, ms } or throws with .attempts.
 */
async function chatWithFailover(messages, options = {}) {
    const started = Date.now();
    const config = readConfig();
    const depth = options.depth === 'detailed' ? 'detailed' : 'fast';
    const limits = {
        maxTokens: Number(options.maxTokens) || config[depth].maxTokens,
        timeoutMs: Number(options.timeoutMs) || config[depth].timeoutMs
    };
    // attempts = providers actually called (each at most once).
    // skipped  = slots left out for configuration reasons, in failover order.
    const attempts = [];
    const skipped = [];
    const wantVision = Boolean(options.vision);

    const candidates = [];
    for (const id of config.order) {
        const resolved = resolveSlot(id);
        if (!resolved) continue;
        if (!resolved.enabled) {
            skipped.push({ slot: id, reason: 'disabled' });
            continue;
        }
        if (!resolved.apiKey) {
            skipped.push({ slot: id, reason: 'no API key' });
            continue;
        }
        if (!resolved.baseUrl) {
            skipped.push({ slot: id, reason: 'no base URL' });
            continue;
        }
        if (!resolved.model) {
            skipped.push({ slot: id, reason: 'no model' });
            continue;
        }
        if (wantVision && !resolved.vision) {
            skipped.push({ slot: id, reason: 'no vision support' });
            continue;
        }
        candidates.push(resolved);
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
        const slotStarted = Date.now();
        try {
            const text = await aiProviders.chat(messages, {
                provider: slot.providerId,
                apiKey: slot.apiKey,
                baseUrl: slot.baseUrl,
                model: slot.model,
                temperature: options.temperature,
                maxTokens: limits.maxTokens,
                timeout: providerTimeoutMs(limits, slot)
            });
            attempts.push({ slot: slot.id, ok: true, ms: Date.now() - slotStarted });
            return {
                text,
                slot: slot.id,
                provider: slot.providerLabel,
                providerId: slot.providerId,
                model: slot.model,
                depth,
                attempts,
                skipped,
                ms: Date.now() - started
            };
        } catch (err) {
            const reason = safeMessage(err, slot.apiKey);
            attempts.push({ slot: slot.id, ok: false, error: reason, ms: Date.now() - slotStarted });
            console.error(`[aiConfig] ${slot.label} (${slot.providerLabel}/${slot.model}) failed: ${reason}`);
        }
    }

    const error = new Error('Every configured AI provider failed.');
    error.attempts = attempts;
    error.skipped = skipped;
    error.code = 'ALL_PROVIDERS_FAILED';
    throw error;
}

/**
 * One provider test, used by the dashboard, .aiprovider test and the "test
 * before saving" form. `overrides` can carry an unsaved provider / base URL /
 * model / key; nothing is written to disk.
 */
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

/** Refreshable model list for one slot (falls back to manual entry). */
async function listModels(id, search = '') {
    const slot = resolveSlot(id);
    if (!slot) return { ok: false, models: [], reason: 'Unknown provider slot.' };
    const result = await aiProviders.listModels({
        provider: slot.providerId,
        baseUrl: slot.baseUrl,
        apiKey: slot.apiKey
    });
    const term = String(search || '').trim().toLowerCase();
    const models = term ? result.models.filter((model) => model.toLowerCase().includes(term)) : result.models;
    return { ...result, models: models.slice(0, 400), slot: slot.id };
}

/** First usable slot (for .ai and backwards-compatible callers). */
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
    getSlot,
    getOrder,
    getSlotsPublic,
    statusSummary,
    resolveSlot,
    primarySlot,
    saveSlot,
    setOrder,
    setKey,
    chatWithFailover,
    testSlot,
    listModels,
    maskKey,
    validBaseUrl,
    validModelId
};
