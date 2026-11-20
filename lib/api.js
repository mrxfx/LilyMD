'use strict';
/**
 * API layer — Lily MD
 * Copyright (c) 2026 Rahul Haldar
 *
 * Every third-party provider now comes from lib/atlasApi.js, i.e. the endpoints
 * and key pools used by Atlas-MD (github.com/FantoX/Atlas-MD, MIT). The exports
 * below keep their historical names so existing commands keep working.
 */
const axios = require('axios');
const settings = require('../settings');
const atlas = require('./atlasApi');

const UA = atlas.UA;

const AXIOS_DEFAULTS = {
    timeout: 60000,
    headers: {
        'User-Agent': UA,
        Accept: 'application/json, text/plain, */*'
    }
};

const api = axios.create({
    timeout: 30000,
    headers: { 'User-Agent': UA }
});

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tryRequest(getter, attempts = 3) {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            return await getter();
        } catch (err) {
            lastError = err;
            if (attempt < attempts) await sleep(1000 * attempt);
        }
    }
    throw lastError;
}

function pickUrl(result) {
    const url = result?.download || result?.dl_url || result?.dl || result?.downloadUrl || result?.downloadURL;
    return url && /^https?:\/\//i.test(url) ? url : null;
}

function isIpLockedCdn(url) {
    return /googlevideo\.com|youtube\.com\/videoplayback/i.test(String(url || ''));
}

function isMediaUrl(url) {
    return typeof url === 'string' && /^https?:\/\//i.test(url) && !/error|cannot be null/i.test(url);
}

function toYouTubeWatchUrl(input) {
    const text = String(input || '').trim();
    const match =
        text.match(/(?:youtube\.com\/(?:watch\?.*?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/i) ||
        text.match(/^([a-zA-Z0-9_-]{11})$/);
    return match?.[1] ? `https://youtu.be/${match[1]}` : text;
}

function videoQuality(value, fallback = '720') {
    return String(value || '').match(/(\d{3,4})/)?.[1] || fallback;
}

/* ------------------------------------------------------- Atlas media sources */

/** YouTube audio via Atlas ytmp3. */
async function atlasSongDownload(url) {
    return atlas.youtubeAudio(toYouTubeWatchUrl(url));
}

/** TikTok via Atlas (tikwm). Legacy shape kept for commands/tiktok.js. */
async function knightTikTokDownload(url) {
    return atlas.tiktok(url);
}

/** Facebook via Atlas (api-faa). */
async function knightFacebookDownload(url) {
    return atlas.facebook(url);
}

/** Twitter / X via Atlas (nexray). Legacy shape kept for commands/twitter.js. */
async function getTwitterElite(url) {
    return atlas.twitter(url);
}

/* ----------------------------------------------------------------- YouTube */

// Atlas-MD ships no ytmp4 endpoint (its YouTube support is audio-only), so the
// `.video` command keeps these three public converters as its sources.
async function getEliteProTechVideoByUrl(youtubeUrl) {
    const res = await tryRequest(() =>
        axios.get(
            `https://eliteprotech-apis.zone.id/ytdown?url=${encodeURIComponent(youtubeUrl)}&format=mp4`,
            AXIOS_DEFAULTS
        )
    );
    if (res?.data?.success && res?.data?.downloadURL) {
        return { download: res.data.downloadURL, title: res.data.title };
    }
    throw new Error('EliteProTech ytdown video returned no download');
}

async function getYupraVideoByUrl(youtubeUrl) {
    const res = await tryRequest(() =>
        axios.get(`https://api.yupra.my.id/api/downloader/ytmp4?url=${encodeURIComponent(youtubeUrl)}`, AXIOS_DEFAULTS)
    );
    if (res?.data?.success && res?.data?.data?.download_url) {
        return {
            download: res.data.data.download_url,
            title: res.data.data.title,
            thumbnail: res.data.data.thumbnail
        };
    }
    throw new Error('Yupra ytmp4 returned no download');
}

async function getOkatsuVideoByUrl(youtubeUrl) {
    const res = await tryRequest(() =>
        axios.get(`https://okatsu-rolezapiiz.vercel.app/downloader/ytmp4?url=${encodeURIComponent(youtubeUrl)}`, AXIOS_DEFAULTS)
    );
    if (res?.data?.result?.mp4) {
        return { download: res.data.result.mp4, title: res.data.result.title };
    }
    throw new Error('Okatsu ytmp4 returned no mp4');
}

async function youtubeVideoDownload(url) {
    const watchUrl = toYouTubeWatchUrl(url);
    let lastError;
    for (const run of [getEliteProTechVideoByUrl, getYupraVideoByUrl, getOkatsuVideoByUrl]) {
        try {
            const result = await run(watchUrl);
            const download = pickUrl(result);
            if (!download) throw new Error('No download URL');
            return { title: result.title || 'Video', download, sourceUrl: watchUrl };
        } catch (err) {
            lastError = err;
            console.log('[video] source failed:', err?.message || err);
        }
    }
    throw lastError || new Error('All video sources failed');
}

/* ----------------------------------------------------------------------- AI */

function pickAiText(data) {
    if (!data) return null;
    if (typeof data === 'string' && data.trim()) return data.trim();
    const candidates = [
        data.result,
        data.msg,
        data.message,
        data.answer,
        data.response,
        data.data?.response,
        data.data?.result,
        data.data?.message,
        data.data
    ];
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
        if (candidate && typeof candidate === 'object' && typeof candidate.text === 'string' && candidate.text.trim()) {
            return candidate.text.trim();
        }
    }
    return null;
}

const AYHA_PERSONA = `You are AYHA, the AI assistant built into Lily MD, a WhatsApp multi-device bot.\nAnswer helpfully, accurately and concisely. Keep replies chat-friendly (short paragraphs, no markdown tables).\nIf you are asked about commands, mention that Lily MD has group management, AI, media download, sticker and utility commands (".help" for the list).\nNever claim to be a human.`;

function openRouterKey() {
    return String(settings.openrouterApiKey || process.env.OPENROUTER_API_KEY || '').trim();
}

function openRouterBase() {
    return String(settings.openrouterBaseUrl || 'https://openrouter.ai/api/v1').replace(/\/$/, '');
}

function openRouterModelName() {
    return String(settings.openrouterModel || process.env.OPENROUTER_MODEL || 'openrouter/free').trim();
}

async function openRouterChatAI(messages, options = {}) {
    const apiKey = String(options.apiKey || openRouterKey()).trim();
    if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set');

    const payload = {
        model: options.model || openRouterModelName(),
        messages: Array.isArray(messages) ? messages : [{ role: 'user', content: String(messages || '') }]
    };
    if (options.temperature !== undefined) payload.temperature = options.temperature;
    if (options.maxTokens) payload.max_tokens = options.maxTokens;

    const { data, status } = await axios.post(`${openRouterBase()}/chat/completions`, payload, {
        timeout: options.timeout || 60000,
        validateStatus: () => true,
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': settings.websiteUrl || 'https://lilymd.vercel.app',
            'X-Title': 'Lily MD',
            'User-Agent': UA
        }
    });

    if (status >= 400) {
        throw new Error(data?.error?.message || data?.error || `OpenRouter HTTP ${status}`);
    }

    const answer = data?.choices?.[0]?.message?.content;
    const text = Array.isArray(answer)
        ? answer.map((part) => part?.text || '').join('').trim()
        : typeof answer === 'string'
          ? answer.trim()
          : '';
    if (!text) throw new Error('OpenRouter returned an empty response');
    return text;
}

/** Atlas-style provider-key chat (OPENAI_API / GEMINI_API / CLAUDE_API pools). */
async function atlasChatAI(text) {
    return atlas.aiChat(text, { system: AYHA_PERSONA });
}

module.exports = {
    api,
    UA,
    AXIOS_DEFAULTS,
    sleep,
    tryRequest,
    pickUrl,
    isIpLockedCdn,
    isMediaUrl,
    toYouTubeWatchUrl,
    videoQuality,
    atlas,
    atlasSongDownload,
    knightSongDownload: atlasSongDownload,
    hectorSongDownload: atlasSongDownload,
    princeSongDownload: atlasSongDownload,
    prexzySongDownload: atlasSongDownload,
    knightTikTokDownload,
    knightFacebookDownload,
    getTwitterElite,
    getTwitterPrince: getTwitterElite,
    getEliteProTechVideoByUrl,
    getYupraVideoByUrl,
    getOkatsuVideoByUrl,
    youtubeVideoDownload,
    AYHA_PERSONA,
    openRouterChatAI,
    openRouterModelName,
    atlasChatAI,
    knightChatAI: atlasChatAI,
    knightGptAI: atlasChatAI,
    fallbackChatAI: atlasChatAI,
    pickAiText
};
