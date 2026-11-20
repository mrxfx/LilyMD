'use strict';
/**
 * Selectable AI providers.
 *
 * The owner picks a provider, model and key in the dashboard (or from WhatsApp
 * with .aisetkey / .aisetmodel); every provider goes through chat() so the bot
 * and the website never build requests themselves.
 *
 *   openrouter · Gemini · Hugging Face · OpenAI · Groq
 *
 * No key is ever logged or returned to the browser.
 */
const UA = 'LilyMD/1.0 (+https://lilymd.vercel.app)';
const DEFAULT_TIMEOUT_MS = 45000;

const PROVIDERS = {
    openrouter: {
        id: 'openrouter',
        label: 'OpenRouter',
        kind: 'openai',
        baseUrl: 'https://openrouter.ai/api/v1',
        defaultModel: 'openrouter/free',
        keyHint: 'sk-or-...',
        envKeys: ['OPENROUTER_API_KEY'],
        consoleUrl: 'https://openrouter.ai/keys'
    },
    gemini: {
        id: 'gemini',
        label: 'Google Gemini',
        kind: 'gemini',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        defaultModel: 'gemini-2.0-flash',
        keyHint: 'AIza...',
        envKeys: ['GEMINI_API_KEY', 'GEMINI_API'],
        consoleUrl: 'https://aistudio.google.com/app/apikey'
    },
    huggingface: {
        id: 'huggingface',
        label: 'Hugging Face',
        kind: 'openai',
        baseUrl: 'https://router.huggingface.co/v1',
        defaultModel: 'meta-llama/Llama-3.2-3B-Instruct',
        keyHint: 'hf_...',
        envKeys: ['HUGGINGFACE_API_KEY', 'HF_TOKEN', 'HUGGINGFACE_API'],
        consoleUrl: 'https://huggingface.co/settings/tokens'
    },
    openai: {
        id: 'openai',
        label: 'OpenAI',
        kind: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        defaultModel: 'gpt-4o-mini',
        keyHint: 'sk-...',
        envKeys: ['OPENAI_API_KEY', 'OPENAI_API'],
        consoleUrl: 'https://platform.openai.com/api-keys'
    },
    groq: {
        id: 'groq',
        label: 'Groq',
        kind: 'openai',
        baseUrl: 'https://api.groq.com/openai/v1',
        defaultModel: 'llama-3.3-70b-versatile',
        keyHint: 'gsk_...',
        envKeys: ['GROQ_API_KEY'],
        consoleUrl: 'https://console.groq.com/keys'
    }
};

const PROVIDER_IDS = Object.keys(PROVIDERS);

function getProvider(id) {
    return PROVIDERS[String(id || '').toLowerCase()] || PROVIDERS.openrouter;
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
            content: String(message.content)
        }));
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
    const message = data?.error?.message || data?.error || data?.message || `${label} HTTP ${status}`;
    return new Error(typeof message === 'string' ? message : JSON.stringify(message));
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
        headers['HTTP-Referer'] = process.env.WEBSITE_URL || 'https://lilymd.vercel.app';
        headers['X-Title'] = 'Lily MD';
    }

    const url = `${provider.baseUrl.replace(/\/$/, '')}/chat/completions`;
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
        .map((message) => message.content)
        .join('\n\n');
    const contents = messages
        .filter((message) => message.role !== 'system')
        .map((message) => ({
            role: message.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: message.content }]
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

    const url = `${provider.baseUrl.replace(/\/$/, '')}/models/${encodeURIComponent(options.model)}:generateContent`;
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
        timeout: options.timeout
    };
    const list = normaliseMessages(messages);
    if (!list.length) throw new Error('Nothing to send: the conversation is empty.');

    return provider.kind === 'gemini'
        ? geminiChat(provider, list, settings)
        : openAiLikeChat(provider, list, settings);
}

module.exports = {
    PROVIDERS,
    PROVIDER_IDS,
    getProvider,
    listProviders,
    defaultModel: (id) => getProvider(id).defaultModel,
    choiceText,
    chat
};
