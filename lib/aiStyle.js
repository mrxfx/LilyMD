'use strict';
/**
 * Rahul's learned WhatsApp writing style.
 *
 * The bot only learns from messages the owner sends himself (message.key.fromMe)
 * and never from AYHA's own replies, commands, links, forwarded spam or bare
 * emoji. Samples are capped and the profile is recomputed from them, so the
 * style gradually gets more accurate without the file growing.
 *
 * Nothing here contacts a provider or prints a key.
 */
const fs = require('fs');
const path = require('path');

// MySQL mirror (write-through), loaded lazily.
let memoryDb = null;
function dbMemory() {
    if (memoryDb) return memoryDb;
    try {
        memoryDb = require('./dbMemory');
    } catch (error) {
        memoryDb = null;
    }
    return memoryDb;
}

const DATA_DIR = path.join(__dirname, '../data');
const STYLE_FILE = path.join(DATA_DIR, 'aiStyle.json');

const MAX_SAMPLES = 60;
const MAX_SAMPLE_CHARS = 240;
const MAX_BOT_REPLIES = 25;
const MIN_SAMPLE_CHARS = 2;

const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2700}-\u{27BF}\u{2600}-\u{26FF}\u{2B00}-\u{2BFF}\u{2764}]/gu;

// Roman-script Hindi / Bengali markers used only to describe the language mix.
const BENGALI_ROMAN_RE = /\b(kemon|kemON|achen|achhe|ache|bhalo|valo|ami|amra|tumi|tomra|apni|korbo|kore|koro|khub|onek|kotha|bolo|bolcho|hobe|hoy|nai|nei|bhai|da|dada|didi|ki|keno|kothay|hoiche|hoice|koile|kere|tarpor|tarpa|kita|kintu|aar|abar|abr|kor|chot|lagaichot|jani|dece|dekh|shun|bol|thik|ekhon|ekhe|bujh|bujhte|parchi|shuno|shuncho|bolun|korun|kichu|kiso)\b/gi;
const HINDI_ROMAN_RE = /\b(hai|hain|kya|kyu|kyon|mera|meri|mujhe|tum|tumhe|aap|bhai|behen|nahi|nhi|karo|kar|karna|hoga|acha|accha|thik|theek|batao|kaise|kaisa|abhi|kal|bahut|bohot|yaar|yr)\b/gi;
const ENGLISH_RE = /\b(the|you|your|ok|okay|good|morning|night|thanks|thank|please|time|work|call|come|what|why|how|this|that|and|but|not|now|later|done|fine|yes|no)\b/gi;

const DEFAULT_GUIDANCE = [
    'Start every message with a capital letter — prefer "Hy Dear Good Morning" over "hy dear good moring".',
    'Do not force Title Case on every word; only names, places and the first word of a sentence.',
    'Keep everyday replies to one or two short lines, like a quick WhatsApp message.',
    'Use punctuation lightly — a full stop, "!" or "?" only when it belongs there.',
    'Use at most one emoji, and only when it fits naturally — never spam emojis.',
    'Default to natural Benglish (Bengali written in English letters, mixed naturally with English); never sound formal or robotic.'
];

const lastBotReplies = [];

function readStore() {
    try {
        const data = JSON.parse(fs.readFileSync(STYLE_FILE, 'utf8'));
        return data && typeof data === 'object' ? data : { samples: [] };
    } catch (err) {
        return { samples: [] };
    }
}

function writeStore(data) {
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(STYLE_FILE, JSON.stringify(data, null, 2));
    } catch (err) {
        console.error('[aiStyle] could not save style:', err.message);
    }
}

function samples() {
    const data = readStore();
    return Array.isArray(data.samples) ? data.samples.filter((s) => typeof s === 'string' && s.trim()) : [];
}

function countMatches(text, re) {
    const found = String(text).match(re);
    return found ? found.length : 0;
}

/** Coarse language label for one message (never sent anywhere). */
function detectLanguage(text) {
    const value = String(text || '');
    if (/[\u0980-\u09FF]/.test(value)) return 'bengali';
    if (/[\u0900-\u097F]/.test(value)) return 'hindi';
    const bengali = countMatches(value, BENGALI_ROMAN_RE);
    const hindi = countMatches(value, HINDI_ROMAN_RE);
    const english = countMatches(value, ENGLISH_RE);
    if (bengali && bengali >= hindi) return english ? 'benlish' : 'bengali-roman';
    if (hindi) return english ? 'hinglish' : 'hindi-roman';
    if (/[a-zA-Z]/.test(value) && !english && !hindi) return 'benlish';
    return 'english';
}

function firstLetter(text) {
    const match = /[A-Za-z\u0900-\u097F\u0980-\u09FF]/.exec(String(text || ''));
    return match ? match[0] : '';
}

function isLearnable(text, { isBot = false, forwarded = false } = {}) {
    const sample = String(text || '').trim();
    if (isBot) return false;
    if (forwarded) return false; // forwarded spam is not his own writing
    if (sample.length < MIN_SAMPLE_CHARS) return false;
    if (sample.length > MAX_SAMPLE_CHARS) return false;
    if (/^[./!#]/.test(sample)) return false; // commands
    if (/^https?:\/\//i.test(sample) || /^www\./i.test(sample)) return false; // links
    if (!/\p{L}/u.test(sample)) return false; // no letters at all
    if (lastBotReplies.some((reply) => reply.toLowerCase() === sample.toLowerCase())) return false;
    return true;
}

/** Recompute the style profile from the stored samples. */
function computeProfile(list) {
    const profile = {
        samples: list.length,
        capitalStarts: 0,
        lowerStarts: 0,
        titleCase: 0,
        allLower: 0,
        allUpper: 0,
        words: 0,
        withEmoji: 0,
        emojiCount: 0,
        periods: 0,
        questions: 0,
        exclaims: 0,
        languages: {},
        emojis: {},
        openers: {}
    };

    for (const sample of list) {
        const emojis = sample.match(EMOJI_RE) || [];
        if (emojis.length) {
            profile.withEmoji += 1;
            profile.emojiCount += emojis.length;
            for (const emoji of emojis) profile.emojis[emoji] = (profile.emojis[emoji] || 0) + 1;
        }

        const sentences = sample.split(/[.!?]+\s*/).map((part) => part.trim()).filter(Boolean);
        for (const sentence of sentences) {
            const letter = firstLetter(sentence);
            if (!letter) continue;
            if (letter === letter.toUpperCase()) profile.capitalStarts += 1;
            else profile.lowerStarts += 1;
        }

        const words = sample.split(/\s+/).filter((word) => /\p{L}/u.test(word));
        profile.words += words.length;
        const titleWords = words.filter((word) => word.length > 2 && /^[\p{Lu}]/u.test(word));
        if (words.length >= 2 && titleWords.length >= Math.ceil(words.length * 0.7)) profile.titleCase += 1;

        const lettersOnly = sample.replace(/[^A-Za-z\u0900-\u09FF\u0980-\u09FF]/g, '');
        if (lettersOnly && lettersOnly === lettersOnly.toLowerCase()) profile.allLower += 1;
        if (lettersOnly.length > 3 && lettersOnly === lettersOnly.toUpperCase()) profile.allUpper += 1;

        profile.periods += countMatches(sample, /\./g);
        profile.questions += countMatches(sample, /\?/g);
        profile.exclaims += countMatches(sample, /!/g);

        const language = detectLanguage(sample);
        profile.languages[language] = (profile.languages[language] || 0) + 1;

        const opener = (sample.match(/^[\p{L}]+/u) || [''])[0].toLowerCase();
        if (opener) profile.openers[opener] = (profile.openers[opener] || 0) + 1;
    }

    if (profile.samples) {
        profile.capitalRate = profile.capitalStarts / Math.max(1, profile.capitalStarts + profile.lowerStarts);
        profile.titleRate = profile.titleCase / profile.samples;
        profile.lowerRate = profile.allLower / profile.samples;
        profile.upperRate = profile.allUpper / profile.samples;
        profile.emojiRate = profile.withEmoji / profile.samples;
        profile.avgWords = profile.words / profile.samples;
        profile.questionRate = profile.questions / profile.samples;
        profile.periodRate = profile.periods / profile.samples;
        profile.exclaimRate = profile.exclaims / profile.samples;
        const topLanguage = Object.entries(profile.languages).sort((a, b) => b[1] - a[1])[0];
        profile.primaryLanguage = topLanguage ? topLanguage[0] : 'english';
    }

    return profile;
}

function topEntries(map, limit = 4) {
    return Object.entries(map || {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([value]) => value);
}

const LANGUAGE_NAMES = {
    english: 'English',
    hinglish: 'Hinglish (Roman Hindi + English)',
    'hindi-roman': 'Roman Hindi',
    hindi: 'Hindi (Devanagari)',
    benlish: 'Benlish (Roman Bengali + English)',
    'bengali-roman': 'Roman Bengali',
    bengali: 'Bengali'
};

/** Human-readable guidance derived from real samples (also used by .aimemory). */
function describe(profile, examples = []) {
    const lines = [];
    if (!profile.samples) return DEFAULT_GUIDANCE.slice();

    const capital = Math.round((profile.capitalRate || 0) * 100);
    if (capital >= 70) {
        lines.push(`Starts sentences with a capital letter in about ${capital}% of his messages — keep doing that.`);
    } else if (capital >= 35) {
        lines.push(`Sometimes starts with a capital letter (${capital}% of messages) — prefer a capital first letter, but stay casual.`);
    } else {
        lines.push('Often types in lowercase, but a capital first letter still reads more like him — "Hy Dear Good Morning", not "hy dear good moring".');
    }

    if ((profile.titleRate || 0) >= 0.5) {
        lines.push('Frequently capitalises each word ("Hy Dear Good Morning") — matching that title-style capitalisation is fine.');
    } else {
        lines.push('Rarely capitalises every word — do not force Title Case on whole sentences.');
    }
    if ((profile.upperRate || 0) > 0.25) lines.push('Sometimes types a whole word in capitals for emphasis.');
    if ((profile.lowerRate || 0) > 0.4) lines.push('Often writes short all-lowercase replies too — shorthand is fine in quick messages.');

    const words = Math.round(profile.avgWords || 0);
    if (words <= 6) lines.push(`Usual message length is about ${words} words — keep everyday replies this short.`);
    else if (words <= 14) lines.push(`Usually writes about ${words} words per message — one or two lines.`);
    else lines.push(`Sometimes writes longer messages (about ${words} words) — but only when there is something to say.`);

    if ((profile.periodRate || 0) < 0.35 && (profile.questionRate || 0) < 0.35) {
        lines.push('Punctuation is light: messages often end without a full stop.');
    } else {
        lines.push('Uses full stops and question marks normally — punctuation is not heavy.');
    }
    if ((profile.exclaimRate || 0) > 0.3) lines.push('Occasionally uses "!" to sound friendly or excited.');

    if ((profile.emojiRate || 0) === 0) lines.push('Rarely or never uses emojis — keep them out unless the other person uses them first.');
    else if (profile.emojiRate < 0.5) lines.push(`Uses an emoji in roughly ${Math.round(profile.emojiRate * 100)}% of messages — occasional, never a wall of emojis.`);
    else lines.push('Uses emojis fairly often, usually one or two per message.');

    const emojis = topEntries(profile.emojis, 4);
    if (emojis.length) lines.push(`Emojis he actually uses: ${emojis.join(' ')}`);

    const language = LANGUAGE_NAMES[profile.primaryLanguage] || 'English';
    lines.push(`Usual language mix: ${language}.`);

    const openers = topEntries(profile.openers, 3);
    if (openers.length) lines.push(`Common opening words: ${openers.map((word) => `"${word}"`).join(', ')}.`);

    if (examples.length) {
        lines.push('Real messages he typed (copy the vibe and capitalisation, never repeat them word for word):');
        for (const example of examples) lines.push(`- ${example}`);
    }

    return lines;
}

/** Prompt block: learned style + the non-negotiable rules. */
function styleBlock(limit = 10) {
    const list = samples();
    const profile = computeProfile(list);
    const examples = list.slice(-limit);
    const lines = ["Rahul's real WhatsApp writing style (learned from his own outgoing messages):"];
    for (const line of describe(profile, examples)) lines.push(`- ${line}`);
    lines.push('');
    lines.push('Style rules that always apply:');
    for (const rule of DEFAULT_GUIDANCE) lines.push(`- ${rule}`);
    return lines.join('\n');
}

/** True when this text is one of AYHA's own recent replies. */
function isBotReply(text) {
    const value = String(text || '').trim().toLowerCase();
    if (!value) return false;
    return lastBotReplies.some((reply) => reply.toLowerCase() === value);
}

/** Record one of AYHA's own replies so it is never mistaken for the owner's style. */
function noteBotReply(text) {
    const reply = String(text || '').trim();
    if (!reply) return;
    lastBotReplies.push(reply);
    while (lastBotReplies.length > MAX_BOT_REPLIES) lastBotReplies.shift();
}

/**
 * Learn from one outgoing owner message. Returns true when it was stored.
 * meta.isBot marks messages the bot sent through the owner's account;
 * meta.forwarded drops forwarded spam.
 */
function observeOwnerMessage(text, meta = {}) {
    if (!isLearnable(text, { isBot: Boolean(meta.isBot), forwarded: Boolean(meta.forwarded) })) return false;
    const sample = String(text).trim();
    const data = readStore();
    const list = Array.isArray(data.samples) ? data.samples.filter((s) => typeof s === 'string') : [];
    if (list.some((old) => old.toLowerCase() === sample.toLowerCase())) return false;
    list.push(sample);
    writeStore({
        samples: list.slice(-MAX_SAMPLES),
        updatedAt: new Date().toISOString()
    });
    try {
        dbMemory()?.saveStyleSample(sample, detectLanguage(sample)).catch(() => {});
    } catch (error) {
        // local cache still works
    }
    return true;
}

function getStyleData() {
    const list = samples();
    const data = readStore();
    const profile = computeProfile(list);
    return {
        samples: list,
        profile,
        guidance: describe(profile, list.slice(-6)),
        updatedAt: data.updatedAt || null
    };
}

function clearStyle() {
    writeStore({ samples: [], updatedAt: new Date().toISOString() });
    lastBotReplies.length = 0;
    try {
        dbMemory()?.clearStyle().catch(() => {});
    } catch (error) {
        // local cache still works
    }
    return true;
}

module.exports = {
    MAX_SAMPLES,
    MAX_SAMPLE_CHARS,
    DEFAULT_GUIDANCE,
    observeOwnerMessage,
    noteBotReply,
    isBotReply,
    getStyleData,
    computeProfile,
    detectLanguage,
    describe,
    styleBlock,
    clearStyle,
    samples
};
