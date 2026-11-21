'use strict';
/**
 * Custom WhatsApp Status reaction.
 *
 * Baileys sends a status reaction as a normal reaction message with
 * `statusJidList` set to the status author:
 *
 *   sock.sendMessage('status@broadcast',
 *     { react: { key: statusKey, text: reaction } },
 *     { statusJidList: [statusAuthor, ownId] })
 *
 * The reaction text is a plain string, so any emoji the owner configures is
 * sent — the library does not limit it to a fixed heart. WhatsApp itself shows
 * one emoji per reaction, so a multi-emoji value like "💖⭐" is relayed as
 * typed but the WhatsApp client may only render the first emoji. Nothing here
 * claims success: errors are returned to the caller.
 *
 * Config lives in data/autoStatus.json (gitignored) next to the existing
 * auto-view / react-on flags, so the in-chat commands and dashboard agree.
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../data');
const CONFIG_PATH = path.join(DATA_DIR, 'autoStatus.json');

const DEFAULT_REACTION = '💖⭐';
const MAX_REACTION_CODE_UNITS = 64;

// Extended pictographic covers emoji; modifiers, variation selectors, ZWJ and
// keycaps keep composed emoji (👨‍👩‍👧, 🏳️‍🌈, 👍🏽) valid.
const EMOJI_ONLY_RE = /^(?:[\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0F\u200D\u20E3])+$/u;

function readConfig() {
    let data = {};
    try {
        data = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (err) {
        data = {};
    }
    if (!data || typeof data !== 'object') data = {};
    const stored = typeof data.statusReaction === 'string' ? data.statusReaction.trim() : '';
    return {
        ...data,
        enabled: Boolean(data.enabled),
        reactOn: Boolean(data.reactOn),
        statusReaction: isValidReaction(stored) ? stored : DEFAULT_REACTION
    };
}

function writeConfig(config) {
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
        return true;
    } catch (err) {
        console.error('[statusReaction] could not save autoStatus.json:', err.message);
        return false;
    }
}

function updateConfig(patch) {
    const next = { ...readConfig(), ...patch };
    writeConfig(next);
    return next;
}

function isValidReaction(value) {
    const reaction = String(value || '').trim();
    if (!reaction || reaction.length > MAX_REACTION_CODE_UNITS) return false;
    if (/\s/.test(reaction)) return false;
    return EMOJI_ONLY_RE.test(reaction);
}

/** Validate an owner-supplied reaction. */
function normaliseReaction(input) {
    const value = String(input || '')
        .trim()
        .replace(/^["'`]|["'`]$/g, '')
        .trim();
    if (!value) return { ok: false, error: 'Give an emoji, e.g. 💖⭐' };
    if (value.length > MAX_REACTION_CODE_UNITS) return { ok: false, error: 'That reaction is too long.' };
    if (/\s/.test(value)) return { ok: false, error: 'Use emoji only — no spaces.' };
    if (!EMOJI_ONLY_RE.test(value)) {
        return { ok: false, error: 'Use emoji only — letters, words and numbers are not a reaction.' };
    }
    return { ok: true, value };
}

function setReaction(input) {
    const result = normaliseReaction(input);
    if (!result.ok) return result;
    updateConfig({ statusReaction: result.value });
    return { ok: true, value: result.value };
}

function resetReaction() {
    updateConfig({ statusReaction: DEFAULT_REACTION });
    return { ok: true, value: DEFAULT_REACTION };
}

function getReaction() {
    return readConfig().statusReaction;
}

function isReactOn() {
    return readConfig().reactOn;
}

function setReactOn(enabled) {
    updateConfig({ reactOn: Boolean(enabled) });
    return Boolean(enabled);
}

/** How many separate emoji are in the configured value (best effort). */
function emojiCount(value) {
    const reaction = String(value || '');
    try {
        if (typeof Intl !== 'undefined' && Intl.Segmenter) {
            return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(reaction)].length;
        }
    } catch (err) {
        // fall through
    }
    return Array.from(reaction).filter((char) => /\p{Extended_Pictographic}/u.test(char)).length;
}

/**
 * Does this WhatsApp library build support status reactions at all?
 * Used to answer honestly before claiming anything was sent.
 */
function supportsCustomStatusReaction(sock) {
    if (!sock) return { supported: false, reason: 'the socket is not ready yet' };
    const canSend = typeof sock.sendMessage === 'function';
    const canRelay = typeof sock.relayMessage === 'function';
    if (!canSend && !canRelay) {
        return { supported: false, reason: 'this Baileys build exposes neither sendMessage nor relayMessage' };
    }
    return { supported: true, reason: '', via: canSend ? 'sendMessage' : 'relayMessage' };
}

/**
 * React to one status with the configured emoji.
 * options: { reaction, force } — force skips the reactOn flag (manual use).
 * Returns { ok, reaction, via } or { ok:false, reason, error }.
 */
async function reactToStatus(sock, statusKey, options = {}) {
    if (!options.force && !isReactOn()) return { ok: false, reason: 'disabled' };

    const support = supportsCustomStatusReaction(sock);
    if (!support.supported) return { ok: false, reason: 'unsupported', error: support.reason };

    const id = statusKey && statusKey.id;
    if (!id) return { ok: false, reason: 'bad-key', error: 'The status has no message id.' };

    const author = String(statusKey.participant || '').trim();
    if (!author || author === 'status@broadcast') {
        return { ok: false, reason: 'bad-key', error: 'The status author is unknown.' };
    }

    const reaction = options.reaction !== undefined ? options.reaction : getReaction();
    const key = { remoteJid: 'status@broadcast', id, participant: author, fromMe: false };
    const ownId = typeof sock.user?.id === 'string' ? sock.user.id : null;
    const statusJidList = [author, ownId].filter(Boolean);

    const attempts = [];
    if (typeof sock.sendMessage === 'function') {
        try {
            await sock.sendMessage('status@broadcast', { react: { text: reaction, key } }, { statusJidList });
            return { ok: true, reaction, via: 'sendMessage' };
        } catch (err) {
            attempts.push(`sendMessage: ${String(err?.message || err).slice(0, 160)}`);
        }
    }
    if (typeof sock.relayMessage === 'function') {
        try {
            await sock.relayMessage(
                'status@broadcast',
                { reactionMessage: { key, text: reaction } },
                { messageId: id, statusJidList }
            );
            return { ok: true, reaction, via: 'relayMessage' };
        } catch (err) {
            attempts.push(`relayMessage: ${String(err?.message || err).slice(0, 160)}`);
        }
    }

    return { ok: false, reason: 'failed', error: attempts.join(' | ') || 'both reaction methods failed' };
}

module.exports = {
    CONFIG_PATH,
    DEFAULT_REACTION,
    MAX_REACTION_CODE_UNITS,
    readConfig,
    updateConfig,
    isValidReaction,
    normaliseReaction,
    setReaction,
    resetReaction,
    getReaction,
    isReactOn,
    setReactOn,
    emojiCount,
    supportsCustomStatusReaction,
    reactToStatus
};
