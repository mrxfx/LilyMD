'use strict';
/**
 * Selectable AI providers: Google Gemini, Groq, and Custom (OpenAI-compatible).
 *
 * Each provider supports multiple models and multiple API keys with intelligent
 * automatic rotation on HTTP 429 / rate limits.
 *
 * No key is ever logged or returned in plain text.
 */
const UA = 'LilyMD/1.0 (+https://lilymd.onrender.com)';
const DEFAULT_TIMEOUT_MS = 45000;

const PROVIDERS = {
    gemini: {
        id: 'gemini',
        label: 'Google Gemini',
        kind: 'gemini',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        defaultModel: 'gemini-2.0-flash',
        defaultModels: ['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-pro'],
        keyHint: 'AIza...',
        envKeys: ['GEMINI_API_KEY', 'GEMINI_API', 'GEMINI_API_KEYS'],
        consoleUrl: 'https://aistudio.google.com/app/apikey',
        vision: true
    },
    groq: {
        id: 'groq',
        label: 'Groq',
        kind: 'openai',
        baseUrl: 'https://api.groq.com/openai/v1',
        defaultModel: 'llama-3.3-70b-versatile',
        defaultModels: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'],
        keyHint: 'gsk_...',
        envKeys: ['GROQ_API_KEY', 'GROQ_API_KEYS'],
        consoleUrl: 'https://console.groq.com/keys',
        vision: false
    },
    custom: {
        id: 'custom',
        label: 'Custom (OpenAI-compatible)',
        kind: 'openai',
        baseUrl: '',
        defaultModel: '',
        defaultModels: [],
        keyHint: 'your API key',
        envKeys: ['AI_CUSTOM_API_KEY', 'CUSTOM_API_KEY', 'CUSTOM_API_KEYS'],
        consoleUrl: '',
        vision: false
    }
};

const PROVIDER_IDS = ['gemini', 'groq', 'custom'];

function isRateLimitError(err, status) {
    if (status === 429) return true;
    const msg = String(err?.message || err || '').toLowerCase();
    if (msg.includes('429')) return true;
    if (msg.includes('rate limit') || msg.includes('rate_limit') || msg.includes('ratelimit')) return true;
    if (msg.includes('resource_exhausted') || msg.includes('resource has been exhausted')) return true;
    if (msg.includes('quota exceeded') || msg.includes('exceeded your current quota') || msg.includes('insufficient_quota')) return true;
    if (msg.includes('too many requests')) return true;
    if (msg.includes('tpm') && msg.includes('limit')) return true;
    if (msg.includes('rpm') && msg.includes('limit')) return true;
    return false;
}

function isInvalidKeyError(err, status) {
    if (status === 401 || status === 403) {
        const msg = String(err?.message || err || '').toLowerCase();
        if (msg.includes('invalid api key') || msg.includes('api key not valid') || msg.includes('unauthorized') || msg.includes('authentication')) {
            return true;
        }
    }
    return false;
}

function getProvider(id) {
    const key = String(id || '').toLowerCase();
    if (PROVIDERS[key]) return PROVIDERS[key];
    if (key === 'openrouter' || key === 'openai' || key === 'huggingface') {
        return PROVIDERS.groq;
    }
    return PROVIDERS.gemini;
}

/** Every provider as plain data for the dashboard (never includes keys). */
function listProviders() {
    return PROVIDER_IDS.map((id) => {
        const provider = PROVIDERS[id];
        return {
            id,
            label: provider.label,
            defaultModel: provider.defaultModel,
            keyHint: provider.keyHint,
            consoleUrl: provider.consoleUrl
        };
    });
}

function normaliseMessages(messages) {
    if (!Array.isArray(messages)) {
        return [{ role: 'user', content: String(messages || '') }];
    }
    return messages
        .filter((message) => message && message.content !== undefined && message.content !== null)
        .map((message) => ({
            role: ['system', 'assistant', 'user'].includes(message.role) ? message.role : 'user',
            // Arrays are vision content parts ({type:'text'} / {type:'image_url'})
            // and must reach the provider untouched.
            content: Array.isArray(message.content) ? message.content : String(message.content)
        }));
}

/** Plain text of a content value (string or OpenAI content-part array). */
function contentText(content) {
    if (Array.isArray(content)) {
        return content
            .map((part) => (typeof part === 'string' ? part : part?.type === 'text' ? part.text || '' : ''))
            .join('\n')
            .trim();
    }
    return String(content || '').trim();
}

/** Gemini parts, including inline images from data: URLs. */
function geminiParts(content) {
    if (!Array.isArray(content)) return [{ text: String(content || '') }];
    const parts = [];
    for (const part of content) {
        if (typeof part === 'string') {
            parts.push({ text: part });
            continue;
        }
        if (part?.type === 'text') {
            parts.push({ text: String(part.text || '') });
            continue;
        }
        const url = part?.image_url?.url || part?.imageUrl || part?.url;
        const match = typeof url === 'string' ? /^data:([^;]+);base64,(.+)$/.exec(url) : null;
        if (match) parts.push({ inline_data: { mime_type: match[1], data: match[2] } });
    }
    return parts.length ? parts : [{ text: '' }];
}

/** Visible answer of an OpenAI-style choice ('' when only reasoning came back). */
function choiceText(choice) {
    const answer = choice?.message?.content;
    if (Array.isArray(answer)) {
        const joined = answer.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('').trim();
        if (joined) return joined;
    } else if (typeof answer === 'string' && answer.trim()) {
        return answer.trim();
    }
    if (typeof choice?.text === 'string' && choice.text.trim()) return choice.text.trim();
    return '';
}

// Global fetch keeps this module dependency-free (the web layer never installs
// axios) and still gives us status + body for every provider.
async function post(url, body, headers, timeout) {
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': UA, ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeout || DEFAULT_TIMEOUT_MS)
    });
    const raw = await response.text();
    let data = null;
    try {
        data = raw ? JSON.parse(raw) : null;
    } catch {
        data = { error: raw.slice(0, 300) || `HTTP ${response.status}` };
    }
    return { data, status: response.status };
}

function apiError(data, status, label) {
    const rawMessage = data?.error?.message || data?.error || data?.message || `${label} HTTP ${status}`;
    const message = typeof rawMessage === 'string' ? rawMessage : JSON.stringify(rawMessage);
    const err = new Error(message);
    err.status = status;
    err.isRateLimit = isRateLimitError(err, status);
    err.isInvalidKey = isInvalidKeyError(err, status);
    return err;
}

async function openAiLikeChat(provider, messages, options) {
    const payload = {
        model: options.model,
        messages
    };
    if (options.temperature !== undefined) payload.temperature = options.temperature;
    if (options.maxTokens) payload.max_tokens = options.maxTokens;

    const headers = { Authorization: `Bearer ${options.apiKey}` };
    if (provider.id === 'openrouter') {
        headers['HTTP-Referer'] = process.env.WEBSITE_URL || 'https://lilymd.onrender.com';
        headers['X-Title'] = 'Lily MD';
    }

    const baseUrl = String(options.baseUrl || provider.baseUrl || '').replace(/\/$/, '');
    if (!baseUrl) throw new Error(`${provider.label} base URL is not set`);
    const url = `${baseUrl}/chat/completions`;
    let result = await post(url, payload, headers, options.timeout);
    if (result.status >= 400) throw apiError(result.data, result.status, provider.label);

    let choice = result.data?.choices?.[0];
    let text = choiceText(choice);

    if (!text) {
        // Reasoning models can spend a small budget before writing anything.
        const retry = { ...payload, max_tokens: Math.max(800, (payload.max_tokens || 0) * 3) };
        delete retry.temperature;
        result = await post(url, retry, headers, options.timeout);
        if (result.status >= 400) throw apiError(result.data, result.status, provider.label);
        choice = result.data?.choices?.[0];
        text = choiceText(choice);
    }

    if (!text) {
        const reason = choice?.finish_reason ? ` (finish_reason: ${choice.finish_reason})` : '';
        throw new Error(`${provider.label} returned an empty response from ${payload.model}${reason}`);
    }
    return text;
}

async function geminiChat(provider, messages, options) {
    const system = messages
        .filter((message) => message.role === 'system')
        .map((message) => contentText(message.content))
        .join('\n\n');
    const contents = messages
        .filter((message) => message.role !== 'system')
        .map((message) => ({
            role: message.role === 'assistant' ? 'model' : 'user',
            parts: geminiParts(message.content)
        }));

    const build = (maxTokens) => {
        const body = { contents };
        const generationConfig = {};
        if (options.temperature !== undefined) generationConfig.temperature = options.temperature;
        if (maxTokens) generationConfig.maxOutputTokens = maxTokens;
        if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;
        if (system) body.systemInstruction = { parts: [{ text: system }] };
        return body;
    };

    const baseUrl = String(options.baseUrl || provider.baseUrl || '').replace(/\/$/, '');
    if (!baseUrl) throw new Error(`${provider.label} base URL is not set`);
    const url = `${baseUrl}/models/${encodeURIComponent(options.model)}:generateContent`;
    let result = await post(url, build(options.maxTokens), { 'x-goog-api-key': options.apiKey }, options.timeout);
    const read = (data) =>
        Array.isArray(data?.candidates?.[0]?.content?.parts)
            ? data.candidates[0].content.parts.map((part) => part.text || '').join('').trim()
            : '';

    if (result.status >= 400) throw apiError(result.data, result.status, provider.label);
    let text = read(result.data);
    if (!text) {
        result = await post(url, build(Math.max(800, (options.maxTokens || 0) * 3)), { 'x-goog-api-key': options.apiKey }, options.timeout);
        if (result.status >= 400) throw apiError(result.data, result.status, provider.label);
        text = read(result.data);
    }
    if (!text) {
        const block = result.data?.promptFeedback?.blockReason;
        throw new Error(`${provider.label} returned an empty response${block ? ` (blocked: ${block})` : ''}`);
    }
    return text;
}

/**
 * One chat call against the selected provider.
 * options: { provider, apiKey, model, temperature, maxTokens, timeout }
 */
async function chat(messages, options = {}) {
    const provider = getProvider(options.provider);
    const apiKey = String(options.apiKey || '').trim();
    if (!apiKey) throw new Error(`${provider.label} API key is not set`);

    const model = String(options.model || provider.defaultModel).trim();
    const settings = {
        apiKey,
        model,
        temperature: options.temperature,
        maxTokens: options.maxTokens,
        timeout: options.timeout,
        baseUrl: options.baseUrl
    };
    const list = normaliseMessages(messages);
    if (!list.length) throw new Error('Nothing to send: the conversation is empty.');

    return provider.kind === 'gemini'
        ? geminiChat(provider, list, settings)
        : openAiLikeChat(provider, list, settings);
}

/**
 * Refreshable model list for a slot. Never throws: an unsupported or failed
 * listing simply tells the caller to fall back to manual model entry.
 */
async function listModels(options = {}) {
    const provider = getProvider(options.provider);
    const apiKey = String(options.apiKey || '').trim();
    const baseUrl = String(options.baseUrl || provider.baseUrl || '').replace(/\/$/, '');
    if (!apiKey) return { ok: false, models: [], reason: `${provider.label} API key is not set` };
    if (!baseUrl) return { ok: false, models: [], reason: `${provider.label} base URL is not set` };
    const url =
        provider.kind === 'gemini'
            ? `${baseUrl}/models?key=${encodeURIComponent(apiKey)}&pageSize=200`
            : `${baseUrl}/models`;
    try {
        const response = await fetch(url, {
            headers: provider.kind === 'gemini' ? { 'User-Agent': UA } : { Authorization: `Bearer ${apiKey}`, 'User-Agent': UA },
            signal: AbortSignal.timeout(options.timeout || 15000)
        });
        const raw = await response.text();
        let data = null;
        try {
            data = raw ? JSON.parse(raw) : null;
        } catch {
            data = null;
        }
        if (response.status >= 400) {
            return { ok: false, models: [], reason: apiError(data, response.status, provider.label).message };
        }
        const list = Array.isArray(data?.data)
            ? data.data
            : Array.isArray(data?.models)
              ? data.models
              : Array.isArray(data)
                ? data
                : [];
        const models = list
            .map((entry) => String(entry?.id || entry?.name || '').replace(/^models\//, ''))
            .filter(Boolean);
        return { ok: true, models: [...new Set(models)].sort((a, b) => a.localeCompare(b)) };
    } catch (err) {
        return { ok: false, models: [], reason: String(err?.message || err).slice(0, 200) };
    }
}

module.exports = {
    PROVIDERS,
    PROVIDER_IDS,
    getProvider,
    listProviders,
    defaultModel: (id) => getProvider(id).defaultModel,
    choiceText,
    chat,
    listModels,
    isRateLimitError,
    isInvalidKeyError
};
