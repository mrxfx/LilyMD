'use strict';
/**
 * Image Vision Module for Lily MD
 *
 * Models:
 *   - Primary: gemini-3.6-flash
 *   - Fallback: gemini-3.1-flash-lite
 *
 * Behavior:
 *   - Analyzes incoming WhatsApp images with Gemini.
 *   - Retries temporary errors (rate limit 429, quota exhaustion, 5xx, network timeout)
 *     using the fallback model.
 *   - Does NOT switch models for invalid requests (400) or permanent auth errors (401/403).
 *   - If both models fail, returns a short helpful error message.
 *   - Persists state in data/vision.json.
 *   - Never logs image contents, API keys, or private conversation data.
 */
const fs = require('fs');
const path = require('path');
const store = require('./webStore');
const aiProviders = require('./aiProviders');
let aiConfig = null;
try {
    aiConfig = require('./aiConfig');
} catch (_) {
    aiConfig = null;
}

const VISION_FILE = store.dataPath('vision.json');
const PRIMARY_MODEL = 'gemini-3.6-flash';
const FALLBACK_MODEL = 'gemini-3.1-flash-lite';
const MAX_IMAGE_BYTES = 6 * 1024 * 1024; // 6MB safe limit
const DEFAULT_TIMEOUT_MS = 45000;

const SUPPORTED_MIMES = [
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    'image/heic',
    'image/heif'
];

function defaultConfig() {
    return {
        enabled: false,
        primaryModel: PRIMARY_MODEL,
        fallbackModel: FALLBACK_MODEL
    };
}

function readConfig() {
    const raw = store.readJson(VISION_FILE, null);
    if (!raw || typeof raw !== 'object') {
        return defaultConfig();
    }
    return {
        enabled: typeof raw.enabled === 'boolean' ? raw.enabled : false,
        primaryModel: PRIMARY_MODEL,
        fallbackModel: FALLBACK_MODEL
    };
}

function writeConfig(patch = {}) {
    const current = readConfig();
    const updated = {
        ...current,
        enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
        primaryModel: PRIMARY_MODEL,
        fallbackModel: FALLBACK_MODEL,
        updatedAt: new Date().toISOString()
    };
    store.writeJson(VISION_FILE, updated);
    return updated;
}

function isEnabled() {
    return readConfig().enabled === true;
}

function setEnabled(enabled) {
    const res = writeConfig({ enabled: Boolean(enabled) });
    return res.enabled;
}

function getGeminiKey() {
    if (aiConfig && typeof aiConfig.getCandidateKeys === 'function') {
        try {
            const candidates = aiConfig.getCandidateKeys('gemini');
            if (Array.isArray(candidates) && candidates.length && candidates[0]?.key) {
                return candidates[0].key;
            }
        } catch (_) {}
    }
    const envVars = ['GEMINI_API_KEY', 'GEMINI_KEY', 'GEMINI_API_KEYS'];
    for (const v of envVars) {
        const val = process.env[v];
        if (val && typeof val === 'string' && val.trim().length >= 6) {
            return val.trim();
        }
    }
    return '';
}

function getStatus() {
    const cfg = readConfig();
    const key = getGeminiKey();
    return {
        enabled: cfg.enabled,
        primaryModel: PRIMARY_MODEL,
        fallbackModel: FALLBACK_MODEL,
        hasKey: Boolean(key)
    };
}

function isPermanentError(err, status = 0) {
    const s = Number(status || err?.status || 0);
    if (s === 400 || s === 401 || s === 403 || s === 404) return true;
    if (err?.isInvalidKey) return true;

    const msg = String(err?.message || err || '').toLowerCase();
    if (msg.includes('invalid api key') || msg.includes('api key not valid') || msg.includes('unauthorized') || msg.includes('permission_denied') || msg.includes('api_key_invalid')) {
        return true;
    }
    if (msg.includes('bad request') || msg.includes('invalid argument') || msg.includes('unsupported image') || msg.includes('model not found')) {
        return true;
    }
    if (msg.includes('safety') || msg.includes('blocked') || msg.includes('prompt feedback')) {
        return true;
    }
    return false;
}

function isTemporaryError(err, status = 0) {
    const s = Number(status || err?.status || 0);
    if (s === 429) return true;
    if (err?.isRateLimit) return true;
    if (s >= 500 && s <= 504) return true;

    const msg = String(err?.message || err || '').toLowerCase();
    if (msg.includes('429') || msg.includes('rate limit') || msg.includes('ratelimit') || msg.includes('rate_limit')) return true;
    if (msg.includes('resource_exhausted') || msg.includes('quota') || msg.includes('too many requests')) return true;
    if (msg.includes('timeout') || msg.includes('etimedout') || msg.includes('econnreset') || msg.includes('fetch failed') || msg.includes('network') || msg.includes('socket hang up') || msg.includes('aborterror')) {
        return true;
    }
    if (msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('504') || msg.includes('service unavailable') || msg.includes('bad gateway') || msg.includes('server error')) {
        return true;
    }
    return false;
}

/**
 * Execute Gemini Vision request with primary model and automatic fallback on temporary errors.
 *
 * @param {Object} params
 * @param {Buffer} params.imageBuffer - Raw image buffer
 * @param {string} params.mimeType - Image mimetype
 * @param {string} [params.prompt] - User caption/prompt
 * @param {Array} [params.history] - Chat conversation history
 * @param {string} [params.systemPrompt] - Bot persona/instructions
 * @param {Function} [params.chatFn] - Optional mock chat function for testing
 */
async function analyzeImage(params = {}) {
    const { imageBuffer, mimeType, prompt, history = [], systemPrompt = '', chatFn } = params;

    if (!Buffer.isBuffer(imageBuffer) || !imageBuffer.length) {
        return {
            ok: false,
            error: 'Invalid or empty image buffer.',
            helpfulMessage: '⚠️ Could not read the image file. Please try sending it again.'
        };
    }

    if (imageBuffer.length > MAX_IMAGE_BYTES) {
        return {
            ok: false,
            error: `Image exceeds max size (${imageBuffer.length} > ${MAX_IMAGE_BYTES})`,
            helpfulMessage: '⚠️ Image is too large to analyze. Maximum supported size is 6MB.'
        };
    }

    const cleanMime = String(mimeType || 'image/jpeg').toLowerCase();
    if (!cleanMime.startsWith('image/')) {
        return {
            ok: false,
            error: `Unsupported MIME type: ${cleanMime}`,
            helpfulMessage: '⚠️ Only standard image formats (JPEG, PNG, WebP) can be analyzed.'
        };
    }

    const apiKey = getGeminiKey();
    if (!apiKey && !chatFn) {
        return {
            ok: false,
            error: 'No Gemini API key configured.',
            helpfulMessage: '⚠️ Gemini API key is not configured for Image Vision. Please set one in the dashboard or via .aiprovider key gemini <key>.'
        };
    }

    const userPrompt = String(prompt || '').trim() || 'Describe this image in detail and answer any questions about it.';
    const base64Data = imageBuffer.toString('base64');

    const messages = [];
    if (systemPrompt && typeof systemPrompt === 'string') {
        messages.push({ role: 'system', content: systemPrompt });
    }

    if (Array.isArray(history) && history.length) {
        for (const msg of history) {
            if (msg && msg.role && msg.content) {
                messages.push({
                    role: msg.role === 'assistant' ? 'assistant' : 'user',
                    content: typeof msg.content === 'string' ? msg.content : String(msg.content?.text || '')
                });
            }
        }
    }

    messages.push({
        role: 'user',
        content: [
            { type: 'text', text: userPrompt },
            { type: 'image_url', image_url: { url: `data:${cleanMime};base64,${base64Data}` } }
        ]
    });

    const callChat = async (model) => {
        if (typeof chatFn === 'function') {
            return chatFn(messages, { provider: 'gemini', model, apiKey, timeout: DEFAULT_TIMEOUT_MS });
        }
        return aiProviders.chat(messages, {
            provider: 'gemini',
            model,
            apiKey,
            timeout: DEFAULT_TIMEOUT_MS,
            temperature: 0.4
        });
    };

    // 1. Try Primary Model: gemini-3.6-flash
    let primaryError = null;
    try {
        const text = await callChat(PRIMARY_MODEL);
        if (text && typeof text === 'string' && text.trim()) {
            return {
                ok: true,
                text: text.trim(),
                model: PRIMARY_MODEL,
                fallbackUsed: false
            };
        }
        throw new Error(`${PRIMARY_MODEL} returned empty text`);
    } catch (err) {
        primaryError = err;
        const status = Number(err?.status || 0);

        // If permanent error, do not switch models
        if (isPermanentError(err, status)) {
            console.error(`[vision] Primary model (${PRIMARY_MODEL}) failed with permanent error (${status || 'err'}). Not falling back.`);
            return {
                ok: false,
                error: `Primary model permanent failure: ${err?.message || 'unknown'}`,
                permanent: true,
                helpfulMessage: status === 401 || status === 403 || err?.isInvalidKey
                    ? '⚠️ Gemini API authentication failed. Please verify your Gemini API key.'
                    : '⚠️ Could not analyze image with this request. Please try a different image or caption.'
            };
        }

        // Check if temporary/retryable
        const temporary = isTemporaryError(err, status);
        if (!temporary) {
            console.error(`[vision] Primary model (${PRIMARY_MODEL}) failed with non-retryable error: ${err?.message}`);
            return {
                ok: false,
                error: `Primary model error: ${err?.message}`,
                helpfulMessage: '⚠️ An error occurred while processing the image. Please try again.'
            };
        }

        console.warn(`[vision] Primary model (${PRIMARY_MODEL}) failed with temporary error (${status || err?.message}). Retrying with fallback (${FALLBACK_MODEL})...`);
    }

    // 2. Try Fallback Model: gemini-3.1-flash-lite
    try {
        const text = await callChat(FALLBACK_MODEL);
        if (text && typeof text === 'string' && text.trim()) {
            return {
                ok: true,
                text: text.trim(),
                model: FALLBACK_MODEL,
                fallbackUsed: true,
                primaryError: primaryError?.message
            };
        }
        throw new Error(`${FALLBACK_MODEL} returned empty text`);
    } catch (fallbackErr) {
        console.error(`[vision] Fallback model (${FALLBACK_MODEL}) also failed: ${fallbackErr?.message}`);
        return {
            ok: false,
            error: `Both vision models failed. Primary: ${primaryError?.message || 'failed'}; Fallback: ${fallbackErr?.message || 'failed'}`,
            helpfulMessage: '⚠️ Both primary and fallback image vision models are currently unavailable. Please try again in a few moments! 🙏'
        };
    }
}

module.exports = {
    PRIMARY_MODEL,
    FALLBACK_MODEL,
    MAX_IMAGE_BYTES,
    SUPPORTED_MIMES,
    readConfig,
    writeConfig,
    isEnabled,
    setEnabled,
    getStatus,
    getGeminiKey,
    isPermanentError,
    isTemporaryError,
    analyzeImage
};
