'use strict';
/**
 * Atlas API layer — Lily MD
 * Copyright (c) 2026 Rahul Haldar
 *
 * Endpoints, response-shape handling and multi-key pools ported from
 * Atlas-MD (github.com/FantoX/Atlas-MD, MIT, by FantoX & Team Atlas).
 *
 * Atlas has no hosted "bot API": each platform is a small public endpoint, and
 * AI features use the official provider keys (OpenAI / Gemini / Claude / Tenor)
 * with comma-separated key pools. This module is the single place Lily MD talks
 * to any of them, so nothing else in the repo needs its own URL.
 */
const axios = require('axios');
const settings = require('../settings');

const UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const FARHAAN = 'https://api-faa.my.id/faa';
const NEXRAY = 'https://api.nexray.web.id/downloader';
const TIKWM = 'https://tikwm.com/api/';
const TENOR = 'https://tenor.googleapis.com/v2';
const OPENWEATHER = 'https://api.openweathermap.org/data/2.5/weather';
const WIKI = 'https://en.wikipedia.org/api/rest_v1/page/summary/';

// Atlas ships public fallback keys for Tenor and OpenWeather; env keys win.
const DEFAULT_TENOR_KEY = 'AIzaSyCyouca1_KKy4W_MG1xsPzuku5oa8W358c';
const DEFAULT_WEATHER_KEY = 'e409825a497a0c894d2dd975542234b0';

const client = axios.create({
    timeout: 60000,
    headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*' },
    validateStatus: () => true
});

const isUrl = (value) => typeof value === 'string' && /^https?:\/\//i.test(value);

/** Split a comma-separated env value into a key pool (Atlas style). */
function pool(value, fallback = []) {
    const keys = String(value || '')
        .split(',')
        .map((key) => key.trim())
        .filter(Boolean);
    return keys.length ? keys : fallback;
}

function pickKey(keys) {
    return keys.length ? keys[Math.floor(Math.random() * keys.length)] : null;
}

const tenorKeys = () => pool(process.env.TENOR_API_KEY, [DEFAULT_TENOR_KEY]);
const weatherKey = () => process.env.OPENWEATHER_API_KEY || settings.openWeatherApiKey || DEFAULT_WEATHER_KEY;

async function getJson(url, params) {
    const { data, status } = await client.get(url, { params });
    if (status >= 400) throw new Error(`Atlas endpoint HTTP ${status}`);
    return data;
}

/* ---------------------------------------------------------------- platforms */

/** TikTok — tikwm.com, same endpoint Atlas uses. */
async function tiktok(url) {
    const data = await getJson(TIKWM, { url });
    if (data?.code !== 0 || !data?.data) throw new Error(data?.msg || 'TikTok API error');
    const post = data.data;
    const images = Array.isArray(post.images) ? post.images.filter(isUrl) : [];
    const video = [post.play, post.hdplay, post.wmplay].find(isUrl) || null;
    return {
        title: post.title || 'TikTok Video',
        thumbnail: isUrl(post.origin_cover) ? post.origin_cover : isUrl(post.cover) ? post.cover : null,
        download: images.length ? null : video,
        audio: isUrl(post.music) ? post.music : null,
        images
    };
}

/** Instagram — api-faa igdl. */
async function instagram(url) {
    const data = await getJson(`${FARHAAN}/igdl`, { url });
    if (!data?.status || !Array.isArray(data?.result?.url) || !data.result.url.length) {
        throw new Error(data?.message || 'Instagram API error');
    }
    const isVideo = Boolean(data.result.metadata?.isVideo);
    return {
        isVideo,
        media: data.result.url.filter(isUrl).map((link) => ({ url: link, type: isVideo ? 'video' : 'image' }))
    };
}

/** Pinterest — api-faa pin-down. */
async function pinterest(url) {
    const data = await getJson(`${FARHAAN}/pin-down`, { url });
    if (!data?.status || !Array.isArray(data?.result?.medias)) {
        throw new Error(data?.message || 'Pinterest API error');
    }
    return data.result.medias
        .filter((item) => isUrl(item?.url))
        .map((item) => ({ url: item.url, type: item.type || 'image' }));
}

/** Facebook — api-faa fbdownload. */
async function facebook(url) {
    const data = await getJson(`${FARHAAN}/fbdownload`, { url });
    const media = data?.result?.media;
    if (!data?.status || !media) throw new Error(data?.message || 'Facebook API error');
    const download = [media.video_hd, media.video_sd, media.photo_image].find(isUrl) || null;
    return {
        title: data.result.title || 'Facebook Video',
        download,
        hd: isUrl(media.video_hd) ? media.video_hd : null,
        sd: isUrl(media.video_sd) ? media.video_sd : null,
        photo: isUrl(media.photo_image) ? media.photo_image : null
    };
}

/** Twitter / X — api.nexray twitter. */
async function twitter(url) {
    const data = await getJson(`${NEXRAY}/twitter`, { url });
    if (!data?.status || !data?.result) throw new Error(data?.message || 'Twitter/X API error');
    const result = data.result;
    const items = Array.isArray(result.download_url) ? result.download_url : [];
    const videos = items
        .filter((item) => item?.type === 'mp4' && isUrl(item.url))
        .sort((a, b) => parseInt(b.resolusi, 10) - parseInt(a.resolusi, 10))
        .map((item) => ({ url: item.url, quality: item.resolusi || 'best' }));
    const images = items.filter((item) => item?.type === 'image' && isUrl(item.url)).map((item) => ({ url: item.url }));
    return {
        type: result.type || (videos.length ? 'video' : 'image'),
        videos,
        images,
        thumbnail: isUrl(result.thumbnail) ? result.thumbnail : null,
        mp3Url: isUrl(result.mp3) ? result.mp3 : null
    };
}

/** YouTube audio — api.nexray ytmp3. */
async function youtubeAudio(url) {
    const data = await getJson(`${NEXRAY}/ytmp3`, { url });
    if (!data?.status || !isUrl(data?.result?.url)) throw new Error(data?.message || 'YouTube API error');
    return {
        download: data.result.url,
        title: data.result.title || 'YouTube Audio',
        thumbnail: isUrl(data.result.thumbnail) ? data.result.thumbnail : null
    };
}

/** Spotify track download. */
async function spotify(url) {
    const data = await getJson(`${NEXRAY}/spotify`, { url });
    if (!data?.status || !isUrl(data?.result?.url)) throw new Error(data?.message || 'Spotify API error');
    return {
        download: data.result.url,
        title: data.result.title || 'Spotify Track',
        artist: data.result.artist || '',
        duration: data.result.duration || '',
        thumbnail: isUrl(data.result.thumbnail) ? data.result.thumbnail : null,
        url: data.result.url
    };
}

/** SoundCloud voice note / track. */
async function soundcloud(url) {
    const data = await getJson(`${NEXRAY}/soundcloud`, { url });
    if (!data?.status || !isUrl(data?.result?.url)) throw new Error(data?.message || 'SoundCloud API error');
    return {
        download: data.result.url,
        title: data.result.fileName || data.result.title || 'SoundCloud Audio',
        thumbnail: isUrl(data.result.thumbnail) ? data.result.thumbnail : null
    };
}

async function threads(url) {
    const data = await getJson(`${NEXRAY}/threads`, { url });
    if (!data?.status || !Array.isArray(data?.result?.media)) throw new Error(data?.message || 'Threads API error');
    return data.result.media.filter((item) => isUrl(item?.url));
}

async function videy(url) {
    const data = await getJson(`${NEXRAY}/videy`, { url });
    if (!data?.status || !isUrl(data?.result)) throw new Error(data?.message || 'Videy API error');
    return data.result;
}

async function mega(url) {
    const data = await getJson(`${NEXRAY}/mega`, { url });
    if (!data?.status || !data?.result) throw new Error(data?.message || 'Mega API error');
    const result = data.result;
    return {
        download: Array.isArray(result.download_url) ? result.download_url[0] : result.download_url,
        filename: result.filename,
        size: result.filesize,
        mimetype: result.mimetype
    };
}

async function mediafire(url) {
    const data = await getJson(`${FARHAAN}/mediafire`, { url });
    if (!data?.status || !isUrl(data?.result?.download_url)) throw new Error(data?.message || 'MediaFire API error');
    return {
        download: data.result.download_url,
        filename: data.result.filename,
        size: data.result.size,
        mimetype: data.result.mime
    };
}

async function sfile(url) {
    const data = await getJson(`${NEXRAY}/sfile`, { url });
    if (!data?.status || !isUrl(data?.result?.url)) throw new Error(data?.message || 'Sfile API error');
    return {
        download: data.result.url,
        filename: data.result.file_name,
        size: data.result.size,
        mimetype: data.result.mimetype
    };
}

/* ----------------------------------------------------------------- utilities */

/** Tenor GIF / sticker search, key-pooled like Atlas. */
async function tenorGif(query) {
    const data = await getJson(`${TENOR}/search`, {
        q: query,
        key: pickKey(tenorKeys()),
        client_key: 'lily_md',
        limit: 8,
        media_filter: 'gif,tinygif'
    });
    const results = Array.isArray(data?.results) ? data.results : [];
    if (!results.length) return null;
    const result = results[Math.floor(Math.random() * results.length)];
    return (
        result.media_formats?.gif?.url ||
        result.media_formats?.tinygif?.url ||
        result.media_formats?.nanogif?.url ||
        null
    );
}

// Atlas's anime reaction pack (26 reactions, served as Tenor GIFs).
const REACTIONS = {
    bite: 'anime bite',
    blush: 'anime blush',
    bonk: 'anime bonk',
    cringe: 'anime cringe',
    cry: 'anime cry',
    cuddle: 'anime cuddle',
    dance: 'anime dance',
    handhold: 'anime hand hold',
    happy: 'anime happy',
    highfive: 'anime high five',
    hug: 'anime hug',
    kiss: 'anime kiss',
    lick: 'anime lick',
    nom: 'anime nom',
    pat: 'anime pat',
    poke: 'anime poke',
    pout: 'anime pout',
    punch: 'anime punch',
    shoot: 'anime shoot',
    slap: 'anime slap',
    sleep: 'anime sleep',
    smug: 'anime smug',
    thumbsup: 'anime thumbs up',
    wave: 'anime wave',
    wink: 'anime wink',
    yeet: 'anime yeet'
};

/** One random animated reaction GIF for `type` (Tenor, Atlas reaction pack). */
async function reaction(type) {
    const key = String(type || '').toLowerCase();
    const data = await getJson(`${TENOR}/search`, {
        q: REACTIONS[key] || `anime ${key}`,
        key: pickKey(tenorKeys()),
        client_key: 'lily_md',
        limit: 8,
        media_filter: 'mp4,gif'
    });
    const results = Array.isArray(data?.results) ? data.results : [];
    if (!results.length) return null;
    const formats = results[Math.floor(Math.random() * results.length)].media_formats || {};
    const video = formats.mp4?.url || formats.tinymp4?.url;
    if (video) return { url: video, isVideo: true };
    const gif = formats.gif?.url || formats.tinygif?.url;
    return gif ? { url: gif, isVideo: false } : null;
}

/** Emoji Kitchen sticker source (Tenor component, as Atlas uses it). */
async function emojiKitchen(first, second) {
    const data = await getJson(`${TENOR}/featured`, {
        key: pickKey(tenorKeys()),
        contentfilter: 'high',
        media_filter: 'png_transparent',
        component: 'proactive',
        collection: 'emoji_kitchen_v5',
        q: `${first}_${second}`
    });
    const results = Array.isArray(data?.results) ? data.results : [];
    return results.length ? results[0].url : null;
}

async function weather(city) {
    const data = await getJson(OPENWEATHER, { q: city, units: 'metric', appid: weatherKey() });
    if (!data?.main || !Array.isArray(data.weather)) throw new Error(data?.message || 'Weather API error');
    return {
        city: data.name,
        country: data.sys?.country || '',
        description: data.weather[0]?.description || '',
        temp: data.main.temp,
        min: data.main.temp_min,
        max: data.main.temp_max,
        humidity: data.main.humidity,
        wind: data.wind?.speed
    };
}

async function wikipedia(query) {
    const data = await getJson(WIKI + encodeURIComponent(query));
    if (!data?.extract) throw new Error('No Wikipedia article found');
    return {
        title: data.title,
        extract: data.extract,
        thumbnail: isUrl(data.thumbnail?.source) ? data.thumbnail.source : null,
        url: data.content_urls?.desktop?.page || ''
    };
}

async function githubUser(username) {
    const data = await getJson(`https://api.github.com/users/${encodeURIComponent(username)}`);
    if (!data?.login) throw new Error(data?.message || 'GitHub user not found');
    return data;
}

/* ------------------------------------------------------------------------ AI */

const openaiKeys = () => pool(process.env.OPENAI_API);
const geminiKeys = () => pool(process.env.GEMINI_API);
const claudeKeys = () => pool(process.env.CLAUDE_API);

async function openaiChat(key, text, system) {
    const { data, status } = await client.post(
        'https://api.openai.com/v1/chat/completions',
        {
            model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
            messages: [
                ...(system ? [{ role: 'system', content: system }] : []),
                { role: 'user', content: text }
            ]
        },
        { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } }
    );
    if (status >= 400) throw new Error(data?.error?.message || `OpenAI HTTP ${status}`);
    const answer = data?.choices?.[0]?.message?.content;
    if (!answer) throw new Error('OpenAI returned an empty response');
    return answer.trim();
}

async function geminiChat(key, text, system) {
    const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
    const { data, status } = await client.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
            contents: [{ parts: [{ text: system ? `${system}\n\n${text}` : text }] }]
        },
        { params: { key }, headers: { 'Content-Type': 'application/json' } }
    );
    if (status >= 400) throw new Error(data?.error?.message || `Gemini HTTP ${status}`);
    const answer = data?.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('');
    if (!answer) throw new Error('Gemini returned an empty response');
    return answer.trim();
}

async function claudeChat(key, text, system) {
    const { data, status } = await client.post(
        'https://api.anthropic.com/v1/messages',
        {
            model: process.env.CLAUDE_MODEL || 'claude-3-5-haiku-latest',
            max_tokens: 1024,
            system: system || undefined,
            messages: [{ role: 'user', content: text }]
        },
        {
            headers: {
                'x-api-key': key,
                'anthropic-version': '2023-06-01',
                'Content-Type': 'application/json'
            }
        }
    );
    if (status >= 400) throw new Error(data?.error?.message || `Claude HTTP ${status}`);
    const answer = Array.isArray(data?.content) ? data.content.map((part) => part.text || '').join('') : '';
    if (!answer) throw new Error('Claude returned an empty response');
    return answer.trim();
}

/**
 * Atlas-style AI chat: try every configured provider key pool (OpenAI → Gemini
 * → Claude) and return the first answer. Throws when no pool is configured.
 */
async function aiChat(text, options = {}) {
    const attempts = [
        ...openaiKeys().map((key) => () => openaiChat(key, text, options.system)),
        ...geminiKeys().map((key) => () => geminiChat(key, text, options.system)),
        ...claudeKeys().map((key) => () => claudeChat(key, text, options.system))
    ];
    if (!attempts.length) throw new Error('No Atlas AI keys configured (OPENAI_API / GEMINI_API / CLAUDE_API)');
    let lastError;
    for (const run of attempts) {
        try {
            return await run();
        } catch (err) {
            lastError = err;
        }
    }
    throw lastError || new Error('All Atlas AI providers failed');
}

function hasAiKeys() {
    return openaiKeys().length + geminiKeys().length + claudeKeys().length > 0;
}

module.exports = {
    UA,
    pool,
    pickKey,
    tiktok,
    instagram,
    pinterest,
    facebook,
    twitter,
    youtubeAudio,
    spotify,
    soundcloud,
    threads,
    videy,
    mega,
    mediafire,
    sfile,
    tenorGif,
    reaction,
    REACTIONS,
    emojiKitchen,
    weather,
    wikipedia,
    githubUser,
    aiChat,
    hasAiKeys
};
