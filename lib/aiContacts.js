'use strict';
/**
 * Per-contact conversation memory and per-contact reply rules for AYHA.
 *
 * Every WhatsApp chat gets its own record keyed by its JID: recent turns, the
 * language/tone that person writes in, facts they shared, their own auto-reply
 * settings and their handoff timer. It is written to data/aiContacts.json, so
 * everything survives a restart, and it is only ever read back for that same
 * chat — contacts never share context or rules.
 *
 * Images are never written here (only the fact that one was sent), and no API
 * key, prompt or hidden instruction is stored.
 */
const fs = require('fs');
const path = require('path');
const { detectLanguage } = require('./aiStyle');

// MySQL mirror (write-through). Loaded lazily so a missing driver never stops
// the bot; failures are swallowed inside dbMemory.
let memoryDb = null;
function db() {
    if (memoryDb) return memoryDb;
    try {
        memoryDb = require('./dbMemory');
    } catch (error) {
        memoryDb = null;
    }
    return memoryDb;
}

const DATA_DIR = path.join(__dirname, '../data');
const CONTACTS_FILE = path.join(DATA_DIR, 'aiContacts.json');

const MAX_CONTACTS = 200;
const MAX_TURNS = 24;
const MAX_TURN_CHARS = 600;
const MAX_FACTS = 12;
const MAX_NAME_CHARS = 60;
const MAX_DELAY_SEC = 60;

const AUTO_REPLY_MODES = ['inherit', 'on', 'off'];

function defaultSettings() {
    return {
        autoReply: 'inherit', // inherit | on | off
        never: false,
        tone: '',
        language: '',
        delaySec: null
    };
}

function readStore() {
    try {
        const data = JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf8'));
        if (data && typeof data === 'object' && data.contacts && typeof data.contacts === 'object') return data;
    } catch (err) {
        // first run
    }
    return { contacts: {} };
}

function prune(contacts) {
    const entries = Object.entries(contacts);
    if (entries.length <= MAX_CONTACTS) return contacts;
    entries.sort((a, b) => String(b[1]?.updatedAt || '').localeCompare(String(a[1]?.updatedAt || '')));
    return Object.fromEntries(entries.slice(0, MAX_CONTACTS));
}

function writeStore(data) {
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(CONTACTS_FILE, JSON.stringify({ contacts: prune(data.contacts || {}) }, null, 2));
    } catch (err) {
        console.error('[aiContacts] could not save contacts:', err.message);
    }
}

function keyOf(chatId) {
    return String(chatId || '').trim().toLowerCase();
}

function numberFromKey(key) {
    return String(key || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
}

function cleanText(value, limit = MAX_TURN_CHARS) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function normaliseSettings(raw) {
    const settings = raw && typeof raw === 'object' ? raw : {};
    // Number(null) is 0 — a null delay must stay "use the default".
    const rawDelay = settings.delaySec;
    const delay = rawDelay === null || rawDelay === undefined || rawDelay === '' ? NaN : Number(rawDelay);
    return {
        autoReply: AUTO_REPLY_MODES.includes(settings.autoReply) ? settings.autoReply : 'inherit',
        never: Boolean(settings.never),
        tone: cleanText(settings.tone, 200),
        language: cleanText(settings.language, 20),
        delaySec: Number.isFinite(delay) && delay >= 0 ? Math.min(MAX_DELAY_SEC, Math.round(delay)) : null
    };
}

function normaliseContact(key, raw) {
    const contact = raw && typeof raw === 'object' ? raw : {};
    const turns = Array.isArray(contact.turns)
        ? contact.turns
              .filter((turn) => turn && typeof turn.text === 'string' && turn.text.trim())
              .map((turn) => ({
                  role: turn.role === 'assistant' ? 'assistant' : 'user',
                  text: cleanText(turn.text),
                  at: turn.at || null,
                  image: Boolean(turn.image)
              }))
              .slice(-MAX_TURNS)
        : [];
    const facts = {};
    if (contact.facts && typeof contact.facts === 'object') {
        for (const [name, value] of Object.entries(contact.facts).slice(0, MAX_FACTS)) {
            const text = cleanText(value, 120);
            if (text) facts[name] = text;
        }
    }
    return {
        chatId: key,
        name: cleanText(contact.name, MAX_NAME_CHARS),
        turns,
        facts,
        language: typeof contact.language === 'string' ? contact.language : '',
        tone: typeof contact.tone === 'string' ? contact.tone : '',
        settings: normaliseSettings(contact.settings),
        handoffUntil: typeof contact.handoffUntil === 'string' ? contact.handoffUntil : null,
        lastOwnerMessageAt: typeof contact.lastOwnerMessageAt === 'string' ? contact.lastOwnerMessageAt : null,
        needsReview:
            contact.needsReview && typeof contact.needsReview === 'object' && contact.needsReview.category
                ? { category: String(contact.needsReview.category).slice(0, 30), at: contact.needsReview.at || null }
                : null,
        firstSeenAt: contact.firstSeenAt || null,
        updatedAt: contact.updatedAt || null
    };
}

function getContact(chatId) {
    const key = keyOf(chatId);
    if (!key) return normaliseContact('', {});
    return normaliseContact(key, readStore().contacts[key]);
}

function saveContact(chatId, contact) {
    const key = keyOf(chatId);
    if (!key) return null;
    const data = readStore();
    const next = normaliseContact(key, contact);
    next.chatId = key;
    next.updatedAt = new Date().toISOString();
    if (!next.firstSeenAt) next.firstSeenAt = next.updatedAt;
    data.contacts[key] = next;
    writeStore(data);
    try {
        db()?.saveContactSnapshot(next).catch(() => {});
    } catch (error) {
        // local cache still works
    }
    return next;
}

/* --------------------------------------------------------------- learning */

function learnFacts(facts, text) {
    const clean = (value) =>
        cleanText(value, 80)
            .split(/\s+(?:and|aur|ar|but|because)\s+/i)[0]
            .replace(/[.,!?;:]+$/, '')
            .replace(/\s+(?:hai|hain|hoon|hu|ahe|hoy|bolo|re)$/i, '')
            .trim();
    let match;

    if ((match = /\bmy name is ([^\n,.]{2,30})/i.exec(text))) facts.name = clean(match[1]);
    else if ((match = /\b(?:mera naam|mera nam|amar nam)\s+([^\n,.]{2,30})/i.exec(text))) facts.name = clean(match[1]);
    if (!facts.name && (match = /\b(?:this is|it'?s)\s+([A-Z][a-zA-Z]{2,20})\s+here\b/.exec(text))) facts.name = clean(match[1]);

    if ((match = /\bi(?:'m| am)\s+(\d{1,2})\s*(?:years?|yrs?)\s*old\b/i.exec(text))) facts.age = match[1];
    else if ((match = /\b(?:amar|meri|mera) boyosh\s+(\d{1,2})\b/i.exec(text))) facts.age = match[1];

    if ((match = /\bi live in ([^\n,.]{2,40})/i.exec(text))) facts.location = clean(match[1]);
    else if ((match = /\bi(?:'m| am) from ([^\n,.]{2,40})/i.exec(text))) facts.location = clean(match[1]);
    else if ((match = /\b(?:main|ami) ([^\n,.]{2,40}) (?:se|theke) (?:hu|hoon|belong|asi)\b/i.exec(text))) facts.location = clean(match[1]);

    if ((match = /\bi (?:work|study) (?:at|in) ([^\n,.]{2,40})/i.exec(text))) facts.work = clean(match[1]);
    if ((match = /\bi (?:like|love) ([^\n,.]{2,40})/i.exec(text))) facts.likes = clean(match[1]);
    else if ((match = /\b(?:amar|mujhe|mujhko) ([^\n,.]{2,40}) (?:bhalo lage|pasand hai|pochondo)\b/i.exec(text))) facts.likes = clean(match[1]);
    if ((match = /\bi (?:hate|dislike) ([^\n,.]{2,40})/i.exec(text))) facts.dislikes = clean(match[1]);

    const trimmed = Object.entries(facts).slice(0, MAX_FACTS);
    return Object.fromEntries(trimmed);
}

/**
 * Remember one incoming message from a contact and learn a little about them.
 * Returns the saved contact record.
 */
function observeIncoming(chatId, text, meta = {}) {
    const contact = getContact(chatId);
    if (meta.pushName) contact.name = cleanText(meta.pushName, MAX_NAME_CHARS) || contact.name;
    if (meta.redacted) {
        // Sensitive content is never stored: keep only that it existed.
        contact.turns.push({
            role: 'user',
            text: `[sensitive message held for review${meta.category ? `: ${meta.category}` : ''}]`,
            at: new Date().toISOString()
        });
        while (contact.turns.length > MAX_TURNS) contact.turns.shift();
        return saveContact(chatId, contact);
    }
    const body = cleanText(text);
    if (body) {
        contact.turns.push({ role: 'user', text: body, at: new Date().toISOString(), image: Boolean(meta.image) });
        while (contact.turns.length > MAX_TURNS) contact.turns.shift();
        const language = detectLanguage(body);
        contact.language = language;
        contact.facts = learnFacts(contact.facts || {}, body);
        try {
            db()?.appendTurn(chatId, 'user', body, { hadMedia: Boolean(meta.image) }).catch(() => {});
        } catch (error) {
            // local cache still works
        }
    } else if (meta.image) {
        contact.turns.push({ role: 'user', text: '[sent an image]', at: new Date().toISOString(), image: true });
        while (contact.turns.length > MAX_TURNS) contact.turns.shift();
    }
    return saveContact(chatId, contact);
}

/** Remember an AYHA reply for this contact, so follow-ups keep the thread. */
function rememberReply(chatId, text) {
    const contact = getContact(chatId);
    const body = cleanText(text);
    if (!body) return contact;
    contact.turns.push({ role: 'assistant', text: body, at: new Date().toISOString() });
    while (contact.turns.length > MAX_TURNS) contact.turns.shift();
    try {
        db()?.appendTurn(chatId, 'assistant', body).catch(() => {});
    } catch (error) {
        // local cache still works
    }
    return saveContact(chatId, contact);
}

/* ------------------------------------------------------------------ read */

function historyFor(chatId, maxTurns = 12) {
    const contact = getContact(chatId);
    return contact.turns
        .slice(-maxTurns)
        .map((turn) => ({ role: turn.role, content: turn.text }));
}

/** Context block for one contact only — never includes another chat's data. */
function memoryBlock(chatId) {
    const contact = getContact(chatId);
    const lines = [];
    if (contact.name) lines.push(`Their WhatsApp name: ${contact.name}.`);
    if (contact.language) lines.push(`They usually write in: ${contact.language}.`);
    if (contact.settings.tone) lines.push(`Tone Rahul wants with them: ${contact.settings.tone}.`);
    else if (contact.tone) lines.push(`Tone with them: ${contact.tone}.`);
    if (contact.settings.language && contact.settings.language !== 'auto') {
        lines.push(`Always answer this contact in: ${contact.settings.language}.`);
    }

    const facts = Object.entries(contact.facts || {}).filter(([, value]) => value);
    if (facts.length) {
        lines.push(`Things they told you about themselves (use only when relevant): ${facts.map(([k, v]) => `${k}=${v}`).join('; ')}.`);
    }

    const recent = contact.turns
        .filter((turn) => turn.role === 'user' && turn.text)
        .slice(-3)
        .map((turn) => turn.text);
    if (recent.length) lines.push(`Recently they said: ${recent.map((text) => `"${text}"`).join(' | ')}`);

    if (!lines.length) lines.push('No earlier context with this person yet — this is the start of the conversation.');
    lines.push('This memory belongs to this chat only. Never mention anything from another chat.');
    return lines.join('\n');
}

/** Short summary list for owner commands / dashboard. */
function listContacts() {
    const data = readStore();
    return Object.entries(data.contacts || {})
        .map(([chatId, raw]) => {
            const contact = normaliseContact(chatId, raw);
            return {
                chatId,
                number: numberFromKey(chatId),
                name: contact.name,
                isGroup: chatId.endsWith('@g.us'),
                language: contact.language,
                facts: contact.facts,
                settings: contact.settings,
                handoffUntil: contact.handoffUntil,
                lastOwnerMessageAt: contact.lastOwnerMessageAt,
                needsReview: contact.needsReview,
                turns: contact.turns.length,
                lastMessage: contact.turns.filter((t) => t.role === 'user').slice(-1)[0]?.text || '',
                updatedAt: contact.updatedAt
            };
        })
        .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

function deleteContact(chatId) {
    const key = keyOf(chatId);
    const data = readStore();
    if (!key || !data.contacts[key]) return false;
    delete data.contacts[key];
    writeStore(data);
    try {
        db()?.deleteContact(key).catch(() => {});
    } catch (error) {
        // local cache still works
    }
    return true;
}

/** Delete by full JID, by phone number or by inbox order index (1-based). */
function deleteContactBy(input) {
    const value = String(input || '').trim();
    if (!value) return { ok: false, reason: 'Give a number, a chat id or a list number.' };
    if (value.toLowerCase() === 'all') {
        clearContacts();
        return { ok: true, removed: 'all' };
    }
    if (deleteContact(value)) return { ok: true, removed: value };
    const digits = value.replace(/[^0-9]/g, '');
    if (digits) {
        for (const contact of listContacts()) {
            if (contact.number === digits) {
                deleteContact(contact.chatId);
                return { ok: true, removed: contact.chatId };
            }
        }
    }
    if (/^\d{1,3}$/.test(value)) {
        const contact = listContacts()[Number(value) - 1];
        if (contact) {
            deleteContact(contact.chatId);
            return { ok: true, removed: contact.chatId };
        }
    }
    return { ok: false, reason: 'No stored memory matches that contact.' };
}

/** Resolve a contact from a number, full chat id or list index. */
function findContact(input) {
    const value = String(input || '').trim();
    if (!value) return null;
    const contacts = listContacts();
    const digits = value.replace(/[^0-9]/g, '');
    if (digits) {
        const byNumber = contacts.find((contact) => contact.number === digits);
        if (byNumber) return byNumber;
    }
    const byId = contacts.find((contact) => contact.chatId === value.toLowerCase());
    if (byId) return byId;
    if (/^\d{1,3}$/.test(value)) return contacts[Number(value) - 1] || null;
    return null;
}

function clearContacts() {
    writeStore({ contacts: {} });
    try {
        db()?.clearContacts().catch(() => {});
    } catch (error) {
        // local cache still works
    }
    return true;
}

/**
 * Startup hydration: rows that only exist in MySQL (e.g. after the JSON cache
 * was removed) are merged back in. Existing local records win, so offline work
 * is never overwritten.
 */
function hydrateFromDb(records) {
    if (!Array.isArray(records) || !records.length) return 0;
    const data = readStore();
    let added = 0;
    for (const record of records) {
        const key = keyOf(record?.chatId);
        if (!key || data.contacts[key]) continue;
        const contact = normaliseContact(key, record);
        contact.chatId = key;
        contact.updatedAt = new Date().toISOString();
        if (!contact.firstSeenAt) contact.firstSeenAt = contact.updatedAt;
        data.contacts[key] = contact;
        added += 1;
    }
    if (added) writeStore(data);
    return added;
}

module.exports = {
    MAX_TURNS,
    MAX_CONTACTS,
    MAX_DELAY_SEC,
    AUTO_REPLY_MODES,
    getContact,
    saveContact,
    observeIncoming,
    rememberReply,
    historyFor,
    memoryBlock,
    listContacts,
    findContact,
    deleteContact,
    deleteContactBy,
    clearContacts,
    hydrateFromDb,
    learnFacts,
    defaultSettings
};
