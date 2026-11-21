'use strict';
/**
 * AYHA persistent memory in MySQL.
 *
 * The JSON files stay as a fast local cache (the reply path must not wait on a
 * network query), and every change is written through to MySQL. On startup the
 * cache is hydrated from MySQL, so deleting the JSON files does not lose memory.
 *
 * Privacy:
 * - Sensitive/OTP bodies are never passed here (lib/aiContacts stores a marker).
 * - Only the contact's own rows are read; every query is filtered by contact_id.
 * - All values are bound parameters; no string interpolation of user data.
 * - Database failures are swallowed (logged as a short code) so chat still works.
 */
const crypto = require('crypto');
const db = require('./db');

const MAX_MESSAGES_PER_CONTACT = 24;
const MAX_STYLE_SAMPLES = 60;
const MAX_FACTS = 12;
const MAX_LOG_DAYS = 30;

let warned = false;

function unavailable(error) {
    if (!warned) {
        console.error(`[dbMemory] MySQL unavailable, using local cache: ${db.safeError(error)}`);
        warned = true;
    }
    return null;
}

async function ready() {
    if (!db.configured()) return false;
    if (db.status().connected) return true;
    return db.connect();
}

function phoneOf(jid) {
    return String(jid || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '') || null;
}

async function ensureContact(contact, connection = db) {
    const jid = String(contact.chatId || '').trim().toLowerCase();
    if (!jid) return null;
    await connection.execute(
        `INSERT INTO contacts (jid, phone, push_name, language)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
            phone = COALESCE(VALUES(phone), phone),
            push_name = COALESCE(NULLIF(VALUES(push_name), ''), push_name),
            language = COALESCE(NULLIF(VALUES(language), ''), language)`,
        [jid, phoneOf(jid), String(contact.name || '').slice(0, 120), String(contact.language || '').slice(0, 32)]
    );
    const [rows] = await connection.execute('SELECT id FROM contacts WHERE jid = ? LIMIT 1', [jid]);
    return rows?.[0]?.id || null;
}

async function savePreferences(contactId, contact, connection = db) {
    if (!contactId) return;
    const settings = contact.settings || {};
    await connection.execute(
        `INSERT INTO contact_preferences
            (contact_id, auto_reply, never_reply, tone, language, delay_sec, handoff_until, last_owner_message_at, needs_review)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
            auto_reply = VALUES(auto_reply),
            never_reply = VALUES(never_reply),
            tone = VALUES(tone),
            language = VALUES(language),
            delay_sec = VALUES(delay_sec),
            handoff_until = VALUES(handoff_until),
            last_owner_message_at = VALUES(last_owner_message_at),
            needs_review = VALUES(needs_review)`,
        [
            contactId,
            ['inherit', 'on', 'off'].includes(settings.autoReply) ? settings.autoReply : 'inherit',
            settings.never ? 1 : 0,
            String(settings.tone || '').slice(0, 200),
            String(settings.language || '').slice(0, 32),
            Number.isFinite(Number(settings.delaySec)) ? Number(settings.delaySec) : null,
            contact.handoffUntil ? String(contact.handoffUntil).slice(0, 19).replace('T', ' ') : null,
            contact.lastOwnerMessageAt ? String(contact.lastOwnerMessageAt).slice(0, 19).replace('T', ' ') : null,
            contact.needsReview?.category ? String(contact.needsReview.category).slice(0, 32) : null
        ]
    );
}

async function saveFacts(contactId, facts, connection = db) {
    if (!contactId || !facts) return;
    for (const [key, value] of Object.entries(facts).slice(0, MAX_FACTS)) {
        const fact = String(value || '').trim().slice(0, 512);
        if (!fact) continue;
        await connection.execute(
            `INSERT INTO contact_memories (contact_id, fact_key, fact_value, source)
             VALUES (?, ?, ?, 'contact')
             ON DUPLICATE KEY UPDATE fact_value = VALUES(fact_value)`,
            [contactId, String(key).slice(0, 64), fact]
        );
    }
}

/** Write-through of one full contact record (called by lib/aiContacts). */
async function saveContactSnapshot(contact) {
    try {
        if (!(await ready())) return false;
        await db.transaction(async (connection) => {
            const contactId = await ensureContact(contact, connection);
            await savePreferences(contactId, contact, connection);
            await saveFacts(contactId, contact.facts, connection);
        });
        return true;
    } catch (error) {
        return unavailable(error);
    }
}

/** Append one conversation turn and trim old ones. */
async function appendTurn(jid, role, text, meta = {}) {
    try {
        if (!text && !meta.hadMedia) return false;
        if (!(await ready())) return false;
        const contactId = await ensureContact({ chatId: jid });
        if (!contactId) return false;
        await db.execute(
            'INSERT INTO conversation_messages (contact_id, role, body, had_media) VALUES (?, ?, ?, ?)',
            [contactId, role === 'assistant' ? 'assistant' : 'user', String(text || '').slice(0, 4000), meta.hadMedia ? 1 : 0]
        );
        await db.execute(
            `DELETE FROM conversation_messages
             WHERE contact_id = ?
               AND id NOT IN (
                   SELECT keep_id FROM (
                       SELECT id AS keep_id FROM conversation_messages
                       WHERE contact_id = ? ORDER BY id DESC LIMIT ?
                   ) kept
               )`,
            [contactId, contactId, MAX_MESSAGES_PER_CONTACT]
        );
        return true;
    } catch (error) {
        return unavailable(error);
    }
}

/** Style samples are deduplicated by hash, so repeats cannot grow the table. */
async function saveStyleSample(text, language) {
    try {
        if (!(await ready())) return false;
        const sample = String(text || '').trim().slice(0, 240);
        if (!sample) return false;
        const hash = crypto.createHash('sha256').update(sample.toLowerCase()).digest('hex');
        await db.execute(
            'INSERT IGNORE INTO owner_style_profile (sample, language, sample_hash) VALUES (?, ?, ?)',
            [sample, String(language || '').slice(0, 32), hash]
        );
        await db.execute(
            `DELETE FROM owner_style_profile
             WHERE id NOT IN (SELECT keep_id FROM (SELECT id AS keep_id FROM owner_style_profile ORDER BY id DESC LIMIT ?) kept)`,
            [MAX_STYLE_SAMPLES]
        );
        return true;
    } catch (error) {
        return unavailable(error);
    }
}

async function loadStyleSamples(limit = MAX_STYLE_SAMPLES) {
    try {
        if (!(await ready())) return null;
        const [rows] = await db.execute(
            'SELECT sample FROM owner_style_profile ORDER BY id DESC LIMIT ?',
            [Math.max(1, Math.min(MAX_STYLE_SAMPLES, Number(limit) || MAX_STYLE_SAMPLES))]
        );
        return (rows || []).map((row) => row.sample).reverse();
    } catch (error) {
        return unavailable(error);
    }
}

/** Read every contact back from MySQL for startup hydration. */
async function loadAllContacts() {
    try {
        if (!(await ready())) return null;
        const [contacts] = await db.execute('SELECT id, jid, phone, push_name, language FROM contacts ORDER BY id');
        if (!contacts?.length) return [];
        const [preferences] = await db.execute('SELECT * FROM contact_preferences');
        const [memories] = await db.execute('SELECT contact_id, fact_key, fact_value, source FROM contact_memories');
        const [messages] = await db.execute(
            `SELECT contact_id, role, body, had_media, created_at FROM (
                SELECT contact_id, role, body, had_media, created_at,
                       ROW_NUMBER() OVER (PARTITION BY contact_id ORDER BY id DESC) AS rn
                FROM conversation_messages
             ) ranked WHERE rn <= ? ORDER BY contact_id, created_at`,
            [MAX_MESSAGES_PER_CONTACT]
        );

        const prefsByContact = new Map((preferences || []).map((row) => [String(row.contact_id), row]));
        const factsByContact = new Map();
        for (const row of memories || []) {
            const key = String(row.contact_id);
            if (!factsByContact.has(key)) factsByContact.set(key, {});
            factsByContact.get(key)[row.fact_key] = row.fact_value;
        }
        const turnsByContact = new Map();
        for (const row of messages || []) {
            const key = String(row.contact_id);
            if (!turnsByContact.has(key)) turnsByContact.set(key, []);
            turnsByContact.get(key).push({ role: row.role, text: row.body, image: Boolean(row.had_media), at: row.created_at });
        }

        return contacts.map((row) => {
            const prefs = prefsByContact.get(String(row.id)) || {};
            return {
                chatId: row.jid,
                name: row.push_name || '',
                language: row.language || '',
                facts: factsByContact.get(String(row.id)) || {},
                turns: turnsByContact.get(String(row.id)) || [],
                settings: {
                    autoReply: prefs.auto_reply || 'inherit',
                    never: Boolean(prefs.never_reply),
                    tone: prefs.tone || '',
                    language: prefs.language || '',
                    delaySec: prefs.delay_sec === null || prefs.delay_sec === undefined ? null : Number(prefs.delay_sec)
                },
                handoffUntil: prefs.handoff_until ? new Date(prefs.handoff_until).toISOString() : null,
                lastOwnerMessageAt: prefs.last_owner_message_at ? new Date(prefs.last_owner_message_at).toISOString() : null,
                needsReview: prefs.needs_review ? { category: prefs.needs_review, at: null } : null
            };
        });
    } catch (error) {
        return unavailable(error);
    }
}

async function deleteContact(jid) {
    try {
        if (!(await ready())) return false;
        const [result] = await db.execute('DELETE FROM contacts WHERE jid = ?', [String(jid || '').trim().toLowerCase()]);
        return Number(result?.affectedRows || 0) > 0;
    } catch (error) {
        return unavailable(error);
    }
}

/** Owner edit of one remembered fact; empty value removes it. */
async function editFact(jid, key, value) {
    try {
        if (!(await ready())) return false;
        const contactId = await ensureContact({ chatId: jid });
        if (!contactId) return false;
        if (!String(value || '').trim()) {
            await db.execute('DELETE FROM contact_memories WHERE contact_id = ? AND fact_key = ?', [contactId, String(key).slice(0, 64)]);
            return true;
        }
        await db.execute(
            `INSERT INTO contact_memories (contact_id, fact_key, fact_value, source)
             VALUES (?, ?, ?, 'owner')
             ON DUPLICATE KEY UPDATE fact_value = VALUES(fact_value), source = 'owner'`,
            [contactId, String(key).slice(0, 64), String(value).slice(0, 512)]
        );
        return true;
    } catch (error) {
        return unavailable(error);
    }
}

async function exportContact(jid) {
    try {
        if (!(await ready())) return null;
        const normalized = String(jid || '').toLowerCase();
        const [rows] = await db.execute(
            `SELECT c.jid, c.push_name, c.language, c.created_at, c.updated_at
             FROM contacts c WHERE c.jid = ? LIMIT 1`,
            [normalized]
        );
        if (!rows?.length) return null;
        const contact = rows[0];
        const [facts] = await db.execute(
            `SELECT m.fact_key, m.fact_value FROM contact_memories m
             JOIN contacts c ON c.id = m.contact_id WHERE c.jid = ?`,
            [normalized]
        );
        const [messages] = await db.execute(
            `SELECT m.role, m.body, m.created_at FROM conversation_messages m
             JOIN contacts c ON c.id = m.contact_id WHERE c.jid = ? ORDER BY m.id`,
            [normalized]
        );
        return { contact, facts: facts || [], messages: messages || [] };
    } catch (error) {
        return unavailable(error);
    }
}

async function exportAll() {
    try {
        if (!(await ready())) return null;
        const contacts = await loadAllContacts();
        return { exportedAt: new Date().toISOString(), contacts: contacts || [] };
    } catch (error) {
        return unavailable(error);
    }
}

/** Keep the tables small: trim messages, old logs, and style samples. */
async function cleanup(limits = {}) {
    try {
        if (!(await ready())) return null;
        const keepMessages = Math.max(10, Number(limits.messages || MAX_MESSAGES_PER_CONTACT));
        const logDays = Math.max(1, Number(limits.logDays || MAX_LOG_DAYS));
        await db.execute(
            `DELETE FROM conversation_messages WHERE id NOT IN (
                SELECT keep_id FROM (
                    SELECT id AS keep_id FROM (
                        SELECT id, ROW_NUMBER() OVER (PARTITION BY contact_id ORDER BY id DESC) AS rn
                        FROM conversation_messages
                    ) ranked WHERE rn <= ?
                ) kept
            )`,
            [keepMessages]
        );
        await db.execute('DELETE FROM scheduled_job_logs WHERE created_at < (NOW() - INTERVAL ? DAY)', [logDays]);
        await db.execute(
            `DELETE FROM owner_style_profile WHERE id NOT IN (
                SELECT keep_id FROM (SELECT id AS keep_id FROM owner_style_profile ORDER BY id DESC LIMIT ?) kept
            )`,
            [MAX_STYLE_SAMPLES]
        );
        return true;
    } catch (error) {
        return unavailable(error);
    }
}

async function clearContacts() {
    try {
        if (!(await ready())) return false;
        await db.execute('DELETE FROM contacts');
        return true;
    } catch (error) {
        return unavailable(error);
    }
}

async function clearStyle() {
    try {
        if (!(await ready())) return false;
        await db.execute('DELETE FROM owner_style_profile');
        return true;
    } catch (error) {
        return unavailable(error);
    }
}

async function stats() {
    if (!(await ready())) return null;
    try {
        const [rows] = await db.execute(
            `SELECT
                (SELECT COUNT(*) FROM contacts) AS contacts,
                (SELECT COUNT(*) FROM conversation_messages) AS messages,
                (SELECT COUNT(*) FROM contact_memories) AS memories,
                (SELECT COUNT(*) FROM owner_style_profile) AS style_samples`
        );
        const row = rows?.[0] || {};
        return {
            contacts: Number(row.contacts || 0),
            messages: Number(row.messages || 0),
            memories: Number(row.memories || 0),
            styleSamples: Number(row.style_samples || 0)
        };
    } catch (error) {
        return unavailable(error);
    }
}

module.exports = {
    MAX_MESSAGES_PER_CONTACT,
    MAX_STYLE_SAMPLES,
    ready,
    ensureContact,
    saveContactSnapshot,
    appendTurn,
    saveStyleSample,
    loadStyleSamples,
    loadAllContacts,
    deleteContact,
    editFact,
    exportContact,
    exportAll,
    clearContacts,
    clearStyle,
    cleanup,
    stats
};
