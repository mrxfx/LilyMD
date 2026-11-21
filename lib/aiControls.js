'use strict';
/**
 * Smart auto-reply controls — quiet hours, manual pause, human handoff,
 * per-contact rules, clarity checks and the sensitive-message guard.
 *
 * State lives in data/aiControls.json (gitignored). Per-contact settings and
 * handoff timers live with that contact's memory in data/aiContacts.json, so
 * two contacts can never share a rule.
 *
 * Nothing here ever logs or returns a message body: the sensitive guard reports
 * a category only.
 */
const fs = require('fs');
const path = require('path');
const aiContacts = require('./aiContacts');

const DATA_DIR = path.join(__dirname, '../data');
const CONTROLS_FILE = path.join(DATA_DIR, 'aiControls.json');

const DEFAULT_TIMEZONE = 'Asia/Kolkata';
const MAX_PAUSE_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_PAUSE_MS = 60 * 1000;
const MAX_HANDOFF_MINUTES = 24 * 60;
const MAX_DELAY_SEC = 60;

const SENSITIVE_MODES = ['hold', 'off'];

function defaultControls() {
    return {
        pauseUntil: null,
        quietHours: { enabled: false, start: '23:00', end: '07:00', timezone: DEFAULT_TIMEZONE },
        handoffMinutes: 45,
        sensitiveMode: 'hold', // hold = never auto-send, off = no guard
        notifyOwner: true,
        neverReply: [],
        defaultDelaySec: 0,
        updatedAt: null
    };
}

function readControls() {
    let data = null;
    try {
        data = JSON.parse(fs.readFileSync(CONTROLS_FILE, 'utf8'));
    } catch (err) {
        data = null;
    }
    const base = defaultControls();
    if (!data || typeof data !== 'object') return base;
    const quiet = data.quietHours && typeof data.quietHours === 'object' ? data.quietHours : {};
    return {
        pauseUntil: typeof data.pauseUntil === 'string' ? data.pauseUntil : null,
        quietHours: {
            enabled: Boolean(quiet.enabled),
            start: validClock(quiet.start) ? String(quiet.start) : base.quietHours.start,
            end: validClock(quiet.end) ? String(quiet.end) : base.quietHours.end,
            timezone: typeof quiet.timezone === 'string' && quiet.timezone ? quiet.timezone : DEFAULT_TIMEZONE
        },
        handoffMinutes: Number.isFinite(Number(data.handoffMinutes))
            ? Math.min(MAX_HANDOFF_MINUTES, Math.max(0, Math.round(Number(data.handoffMinutes))))
            : base.handoffMinutes,
        sensitiveMode: SENSITIVE_MODES.includes(data.sensitiveMode) ? data.sensitiveMode : 'hold',
        notifyOwner: typeof data.notifyOwner === 'boolean' ? data.notifyOwner : true,
        neverReply: Array.isArray(data.neverReply)
            ? [...new Set(data.neverReply.map((n) => String(n).replace(/[^0-9]/g, '')).filter((n) => n.length >= 7))].slice(0, 500)
            : [],
        defaultDelaySec: Number.isFinite(Number(data.defaultDelaySec))
            ? Math.min(MAX_DELAY_SEC, Math.max(0, Math.round(Number(data.defaultDelaySec))))
            : 0,
        updatedAt: data.updatedAt || null
    };
}

function writeControls(controls) {
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(CONTROLS_FILE, JSON.stringify({ ...controls, updatedAt: new Date().toISOString() }, null, 2));
        return true;
    } catch (err) {
        console.error('[aiControls] could not save controls:', err.message);
        return false;
    }
}

function saveControls(patch) {
    const next = { ...readControls(), ...patch };
    next.updatedAt = new Date().toISOString();
    writeControls(next);
    return readControls();
}

/* ------------------------------------------------------------------- time */

function validClock(value) {
    return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || '').trim());
}

function clockToMinutes(value) {
    if (!validClock(value)) return null;
    const [hour, minute] = String(value).split(':').map(Number);
    return hour * 60 + minute;
}

/** Local minutes-of-day in the configured timezone (falls back to server time). */
function minutesNow(timezone = DEFAULT_TIMEZONE) {
    try {
        const parts = new Intl.DateTimeFormat('en-GB', {
            timeZone: timezone,
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        }).formatToParts(new Date());
        const hour = Number(parts.find((part) => part.type === 'hour')?.value);
        const minute = Number(parts.find((part) => part.type === 'minute')?.value);
        if (Number.isFinite(hour) && Number.isFinite(minute)) {
            return (hour % 24) * 60 + minute;
        }
    } catch (err) {
        // unknown timezone → server local time
    }
    const now = new Date();
    return now.getHours() * 60 + now.getMinutes();
}

/** True when `minutes` falls inside a (possibly overnight) quiet window. */
function inQuietWindow(quietHours, minutes) {
    if (!quietHours || !quietHours.enabled) return false;
    const start = clockToMinutes(quietHours.start);
    const end = clockToMinutes(quietHours.end);
    if (start === null || end === null) return false;
    if (start === end) return false; // no window
    if (start < end) return minutes >= start && minutes < end;
    return minutes >= start || minutes < end; // overnight, e.g. 23:00 → 07:00
}

function parseDuration(input) {
    let value = String(input || '').trim().toLowerCase();
    if (!value) return 60 * 60 * 1000; // default 1h
    if (/^\d+$/.test(value)) value = `${value}m`; // bare number = minutes
    let total = 0;
    let matched = false;
    const re = /(\d+)\s*(d|h|m|s)/g;
    let match;
    while ((match = re.exec(value))) {
        const amount = Number(match[1]);
        matched = true;
        if (match[2] === 'd') total += amount * 24 * 60 * 60 * 1000;
        else if (match[2] === 'h') total += amount * 60 * 60 * 1000;
        else if (match[2] === 'm') total += amount * 60 * 1000;
        else total += amount * 1000;
    }
    if (!matched || !total) return null;
    return Math.min(MAX_PAUSE_MS, Math.max(MIN_PAUSE_MS, total));
}

function humanDuration(ms) {
    const minutes = Math.max(1, Math.round(ms / 60000));
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (hours < 24) return rest ? `${hours}h ${rest}m` : `${hours}h`;
    const days = Math.floor(hours / 24);
    const left = hours % 24;
    return left ? `${days}d ${left}h` : `${days}d`;
}

/* ------------------------------------------------------------------ pause */

function isPaused(controls = readControls(), now = Date.now()) {
    if (!controls.pauseUntil) return false;
    const until = Date.parse(controls.pauseUntil);
    if (!Number.isFinite(until)) return false;
    return until > now;
}

function pause(duration) {
    const ms = duration === undefined ? 60 * 60 * 1000 : parseDuration(duration);
    if (ms === null) return { ok: false, error: 'Duration must look like 30m, 1h, 2h30m or 1d.' };
    const pauseUntil = new Date(Date.now() + ms).toISOString();
    saveControls({ pauseUntil });
    return { ok: true, pauseUntil, ms };
}

function resume() {
    saveControls({ pauseUntil: null });
    return { ok: true };
}

/** Manual pause + quiet hours, as one gate. */
function replyGate(controls = readControls(), now = Date.now()) {
    if (isPaused(controls, now)) {
        const left = Date.parse(controls.pauseUntil) - now;
        return { ok: false, reason: 'paused', detail: `paused for another ${humanDuration(left)}` };
    }
    if (inQuietWindow(controls.quietHours, minutesNow(controls.quietHours.timezone))) {
        return {
            ok: false,
            reason: 'quiet',
            detail: `quiet hours ${controls.quietHours.start}–${controls.quietHours.end} (${controls.quietHours.timezone})`
        };
    }
    return { ok: true };
}

function quietStatus(controls = readControls()) {
    const quiet = controls.quietHours;
    return {
        ...quiet,
        active: inQuietWindow(quiet, minutesNow(quiet.timezone))
    };
}

/* ------------------------------------------------------- per-contact rules */

function configureContact(chatId, patch = {}) {
    const contact = aiContacts.getContact(chatId);
    const settings = { ...(contact.settings || {}) };

    if (patch.autoReply !== undefined) {
        if (!['inherit', 'on', 'off'].includes(patch.autoReply)) {
            return { ok: false, error: 'Contact auto-reply must be on, off or inherit.' };
        }
        settings.autoReply = patch.autoReply;
    }
    if (patch.never !== undefined) settings.never = Boolean(patch.never);
    if (patch.tone !== undefined) settings.tone = String(patch.tone || '').trim().slice(0, 200);
    if (patch.language !== undefined) {
        const language = String(patch.language || '').trim().toLowerCase();
        const allowed = ['', 'auto', 'english', 'hindi', 'hinglish', 'bengali', 'benlish'];
        if (!allowed.includes(language)) {
            return { ok: false, error: 'Contact language must be auto, english, hindi, hinglish, bengali or benlish.' };
        }
        settings.language = language;
    }
    if (patch.delaySec !== undefined) {
        if (patch.delaySec === null || patch.delaySec === '') settings.delaySec = null;
        else {
            const delay = Number(patch.delaySec);
            if (!Number.isFinite(delay) || delay < 0 || delay > MAX_DELAY_SEC) {
                return { ok: false, error: `Reply delay must be between 0 and ${MAX_DELAY_SEC} seconds.` };
            }
            settings.delaySec = Math.round(delay);
        }
    }
    if (patch.reset) {
        settings.autoReply = 'inherit';
        settings.never = false;
        settings.tone = '';
        settings.language = '';
        settings.delaySec = null;
        contact.handoffUntil = null;
        contact.needsReview = null;
    }

    contact.settings = settings;
    const saved = aiContacts.saveContact(chatId, contact);
    return { ok: true, contact: saved };
}

function contactNumber(chatId) {
    return String(chatId || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
}

/**
 * Why AYHA must not answer this contact right now, or null.
 * Order: per-contact rejections → handoff → never list.
 */
function contactBlock(chatId, controls = readControls(), now = Date.now()) {
    const contact = aiContacts.getContact(chatId);
    const settings = contact.settings || {};

    if (settings.autoReply === 'off' || settings.never) {
        return { reason: 'contact-off', detail: 'auto-reply is off for this contact' };
    }

    const never = controls.neverReply || [];
    if (never.includes(contactNumber(chatId))) {
        return { reason: 'never', detail: 'this number is on the never-reply list' };
    }

    if (contact.handoffUntil) {
        const until = Date.parse(contact.handoffUntil);
        if (Number.isFinite(until) && until > now) {
            return {
                reason: 'handoff',
                detail: `Rahul replied manually, AYHA waits until ${new Date(until).toISOString().slice(11, 16)} UTC`,
                until: contact.handoffUntil
            };
        }
    }
    return null;
}

function setNever(chatId, never) {
    return configureContact(chatId, { never: Boolean(never) });
}

function addNever(number) {
    const digits = String(number || '').replace(/[^0-9]/g, '');
    if (digits.length < 7) return { ok: false, error: 'Give a number with country code.' };
    const controls = readControls();
    if (!controls.neverReply.includes(digits)) controls.neverReply.push(digits);
    writeControls(controls);
    return { ok: true, neverReply: controls.neverReply };
}

function removeNever(number) {
    const digits = String(number || '').replace(/[^0-9]/g, '');
    if (!digits) return { ok: false, error: 'Give a number.' };
    const controls = readControls();
    controls.neverReply = controls.neverReply.filter((entry) => entry !== digits);
    writeControls(controls);
    return { ok: true, neverReply: controls.neverReply };
}

/* ---------------------------------------------------------- human handoff */

/**
 * Rahul typed something himself → let him keep the conversation for a while and
 * never compete with that reply. Bot replies are ignored so AYHA does not pause
 * itself.
 */
function noteOwnerMessage(chatId, text, isBotReply = false) {
    if (isBotReply) return { ok: false, reason: 'bot-reply' };
    if (!String(text || '').trim()) return { ok: false, reason: 'no-text' };
    const controls = readControls();
    if (!controls.handoffMinutes) return { ok: false, reason: 'disabled' };
    const contact = aiContacts.getContact(chatId);
    contact.handoffUntil = new Date(Date.now() + controls.handoffMinutes * 60000).toISOString();
    contact.lastOwnerMessageAt = new Date().toISOString();
    aiContacts.saveContact(chatId, contact);
    return { ok: true, handoffUntil: contact.handoffUntil };
}

function clearHandoff(chatId) {
    const contact = aiContacts.getContact(chatId);
    contact.handoffUntil = null;
    aiContacts.saveContact(chatId, contact);
    return true;
}

/* -------------------------------------------------------- clarity + guard */

const ACK_RE = /^(ok|okay|k|kk|hmm+|hm+|haan|han|hna|yes|yep|ya|no|nope|nahi|nhi|thik|theek|lol|lmao|haha+|hehe+|done|seen|sure|fine|acha|accha|cool|good|nice|thanks|thank you|ty|np|bye|gn|gm|\?+|\.+)[\s.!?😂👍🙏❤️]*$/i;

const GREETING_RE = /^(hi+|hii+|hello+|hey+|hlo|hy|hii dear|good morning|good night|gm|gn|namaste|namaskar|assalamualaikum|salam|kemon acho|kem cho|kaise ho|kya haal)\b/i;

const VAGUE_RE = /^(it|this|that|he|she|they|wo|woh|ye|yeh|is it|what about (it|that|this)|and\??|phir\??|then\??|kyu|kyun|why|how|kaise|kemon|what)\s*[?.!]*$/i;

/**
 * Decide whether this message can be answered at all.
 * Returns { action: 'reply' | 'clarify' | 'skip', reason }.
 */
function assessClarity(text, history = []) {
    const body = String(text || '').trim();
    if (!body) return { action: 'reply', reason: 'image-only' }; // vision handles it
    if (GREETING_RE.test(body)) return { action: 'reply', reason: 'greeting' };
    if (ACK_RE.test(body)) return { action: 'skip', reason: 'acknowledgement' };

    const letters = body.replace(/[^A-Za-z\u0900-\u09FF\u0980-\u09FF]/g, '');
    if (letters.length >= 4 && !/[aeiouAEIOU\u0900-\u09FF\u0980-\u09FF]/.test(letters)) {
        return { action: 'skip', reason: 'unreadable' };
    }
    if (/^(.)\1{4,}$/.test(letters)) return { action: 'skip', reason: 'unreadable' };

    const hasHistory = Array.isArray(history) && history.length > 0;
    if (VAGUE_RE.test(body) && !hasHistory) {
        return { action: 'clarify', reason: 'no-context' };
    }
    if (!hasHistory && body.split(/\s+/).filter(Boolean).length <= 1 && body.length < 4 && !/\d/.test(body)) {
        return { action: 'clarify', reason: 'too-short' };
    }
    return { action: 'reply', reason: 'ok' };
}

const SENSITIVE_PATTERNS = [
    {
        category: 'otp',
        re: /\b(otp|one[- ]?time (?:password|code)|verification code|login code|code (?:bhejo|batao|dedo|do)|otp (?:bhejo|batao|kya hai))\b/i
    },
    {
        category: 'otp',
        // Six-digit code sitting next to a code/verification word.
        re: /\b(?:\d{4,8}\b[\s\S]{0,40}\b(?:code|otp|verify|verification)\b|\b(?:code|otp|verify|verification)\b[\s\S]{0,40}\b\d{4,8}\b)/i
    },
    {
        category: 'credentials',
        re: /\b(password|passwd|pwd|cvv|pin\s*(?:number|code)?|atm pin|login (?:id|details)|username|aadhaar|aadhar|pan card|ssn|net ?banking)\b/i
    },
    {
        category: 'payment',
        re: /\b(bank account|account number|ifsc|upi id|gpay|google pay|paytm|phonepe|debit card|credit card|card number|rupay|cvv|refund|transaction id|neft|imps)\b/i
    },
    {
        category: 'payment',
        re: /\b(?:send|transfer|pay|bhejo|bhej do|karo)\b[\s\S]{0,30}\b(?:₹|rs\.?|inr)\s?\d{2,}/i
    },
    {
        category: 'personal',
        re: /\b(?:home address|ghar ka pata|where do you live|kahan rehta|phone number|mobile number|apna number|screenshot of (?:id|aadhaar|pan))\b/i
    },
    {
        category: 'conflict',
        re: /\b(police|fir\b|complaint|legal notice|lawyer|court case|threat|blackmail|blackmailing|harass|abuse|fight|ladai|jhagda|maar peet|suicide)\b/i
    }
];

/** Category of a risky message, or null. Never returns the message. */
function detectSensitive(text) {
    const body = String(text || '');
    if (!body) return null;
    for (const entry of SENSITIVE_PATTERNS) {
        if (entry.re.test(body)) return entry.category;
    }
    return null;
}

/** A generated reply that would expose a secret must not be sent either. */
function replyLooksSensitive(reply) {
    const body = String(reply || '');
    if (!body) return false;
    if (/\b\d{12,19}\b/.test(body)) return true; // card-like number
    if (/\b\d{4,8}\b/.test(body) && /\b(otp|code|pin|cvv|password)\b/i.test(body)) return true;
    if (/\b(password|passwd|pwd|otp|cvv|aadhaar|aadhar)\b\s*[:=-]\s*\S+/i.test(body)) return true;
    return false;
}

/** Category only — safe for logs, owner notifications and status text. */
function describeCategory(category) {
    return (
        {
            otp: 'OTP / verification code',
            credentials: 'password or login details',
            payment: 'payment or bank details',
            personal: 'private personal information',
            conflict: 'a serious or conflict situation'
        }[category] || 'a sensitive message'
    );
}

function normaliseForCompare(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/[^a-z0-9\u0900-\u09FF\u0980-\u09FF ]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/** True when AYHA already sent this wording (or a near copy) to this contact. */
function isRepetitive(chatId, reply) {
    const target = normaliseForCompare(reply);
    if (!target) return true;
    const recent = aiContacts
        .getContact(chatId)
        .turns.filter((turn) => turn.role === 'assistant')
        .slice(-3)
        .map((turn) => normaliseForCompare(turn.text))
        .filter(Boolean);
    return recent.some((old) => old === target || (old.length >= 24 && (old.includes(target) || target.includes(old))));
}

function clarifyReply(language = 'auto') {
    const replies = {
        hinglish: 'Kya matlab? Thoda clear bolo na',
        hindi: 'क्या मतलब? थोड़ा साफ़ बताओ ना',
        bengali: 'Ki bolte chao? Ektu clear koro',
        benlish: 'Ki bolte chao? Ektu clear koro',
        english: 'Sorry, I did not get that — can you say it a bit clearer?'
    };
    return replies[language] || 'Kya matlab? Thoda clear bolo na';
}

/* ------------------------------------------------------------------ status */

function status() {
    const controls = readControls();
    const paused = isPaused(controls);
    const quiet = quietStatus(controls);
    let pauseLeft = null;
    if (paused) pauseLeft = humanDuration(Date.parse(controls.pauseUntil) - Date.now());
    return {
        pause: {
            paused,
            until: paused ? controls.pauseUntil : null,
            left: pauseLeft
        },
        quiet: { ...quiet, label: `${quiet.start}–${quiet.end} ${quiet.timezone}` },
        handoffMinutes: controls.handoffMinutes,
        sensitiveMode: controls.sensitiveMode,
        notifyOwner: controls.notifyOwner,
        neverReply: controls.neverReply,
        defaultDelaySec: controls.defaultDelaySec,
        updatedAt: controls.updatedAt
    };
}

module.exports = {
    CONTROLS_FILE,
    DEFAULT_TIMEZONE,
    MAX_DELAY_SEC,
    MAX_HANDOFF_MINUTES,
    SENSITIVE_MODES,
    readControls,
    saveControls,
    parseDuration,
    humanDuration,
    validClock,
    clockToMinutes,
    inQuietWindow,
    minutesNow,
    isPaused,
    pause,
    resume,
    replyGate,
    quietStatus,
    configureContact,
    contactBlock,
    setNever,
    addNever,
    removeNever,
    noteOwnerMessage,
    clearHandoff,
    assessClarity,
    isRepetitive,
    detectSensitive,
    replyLooksSensitive,
    describeCategory,
    clarifyReply,
    status
};
