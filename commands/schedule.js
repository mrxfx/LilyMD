'use strict';
/**
 * .schedule — owner-only scheduling for WhatsApp messages and Status updates.
 *
 * Nothing is saved without a preview + confirm step. Pending jobs live in MySQL
 * (lib/dbSchedules) and are sent by lib/scheduler, so they survive restarts.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('../lib/db');
const store = require('../lib/dbSchedules');
const scheduler = require('../lib/scheduler');
const time = require('../lib/scheduleTime');

const DRAFT_TTL_MS = 10 * 60 * 1000;
const drafts = new Map();

const USAGE = [
    '🗓️ *SCHEDULED MESSAGES*',
    '',
    '*Create*',
    '• .schedule new 2026-11-22 09:30 | 916033271400 | Good morning 🌸',
    '• .schedule new +2h 916033271400 Hello there',
    '• Reply to an image / video / document with:',
    '  .schedule new 20:30 916033271400 | caption',
    '',
    '*Manage*',
    '• .schedule list — upcoming',
    '• .schedule edit <id> time <when> | text <text> | repeat <none|daily|weekly|monthly>',
    '• .schedule cancel <id> — cancel a pending job',
    '• .schedule delete <id> — remove a cancelled/failed job',
    '• .schedule history — recent results',
    '• .schedule status — Status overview',
    '',
    '*Status*',
    '• .schedule statusnew 2026-11-22 09:30 | My status text',
    '• .schedule statusnew 09:30 | caption | 916033271400  (recipients optional)',
    '• Reply to an image/video with: .schedule statusnew 09:30 | caption',
    '• .schedule status list / .schedule status cancel <id>',
    '',
    'Optional: append `--daily`, `--weekly` or `--monthly` for a recurring job.',
    `Time zone: ${time.timezone()}`
].join('\n');

function textOf(msg) {
    const message = msg?.message || {};
    return (
        message.conversation ||
        message.extendedTextMessage?.text ||
        message.imageMessage?.caption ||
        message.videoMessage?.caption ||
        message.documentMessage?.caption ||
        ''
    ).trim();
}

function unwrap(message) {
    if (!message) return message;
    if (message.ephemeralMessage?.message) return unwrap(message.ephemeralMessage.message);
    if (message.viewOnceMessage?.message) return unwrap(message.viewOnceMessage.message);
    if (message.viewOnceMessageV2?.message) return unwrap(message.viewOnceMessageV2.message);
    return message;
}

function resolveMedia(msg) {
    const own = unwrap(msg.message);
    if (!own) return null;
    const direct = [
        ['image', own.imageMessage],
        ['video', own.videoMessage],
        ['document', own.documentMessage]
    ].find(([, value]) => value);
    if (direct) return { type: direct[0], node: direct[1], target: msg };
    const context = own.extendedTextMessage?.contextInfo;
    const quoted = unwrap(context?.quotedMessage);
    if (!quoted || !context?.stanzaId) return null;
    const target = {
        key: { remoteJid: msg.key.remoteJid, id: context.stanzaId, participant: context.participant },
        message: quoted
    };
    const viaQuote = [
        ['image', quoted.imageMessage],
        ['video', quoted.videoMessage],
        ['document', quoted.documentMessage]
    ].find(([, value]) => value);
    return viaQuote ? { type: viaQuote[0], node: viaQuote[1], target } : null;
}

async function ownerOnly(sock, chatId, msg) {
    const senderId = msg.key.participant || msg.key.remoteJid;
    if (msg.key.fromMe) return true;
    // Lazy: keeps this module loadable by offline tooling (no node_modules).
    const isOwnerOrSudo = require('../lib/isOwner');
    return isOwnerOrSudo(senderId, sock, chatId);
}

// Lazy: messageConfig loads settings/dotenv, which offline tooling lacks.
function channelContext() {
    try {
        return require('../lib/messageConfig').channelInfo || {};
    } catch (error) {
        return {};
    }
}

async function reply(sock, chatId, msg, text) {
    return sock.sendMessage(chatId, { text, ...channelContext() }, { quoted: msg });
}

function cleanupDrafts() {
    const now = Date.now();
    for (const [token, draft] of drafts) {
        if (draft.expiresAt <= now) {
            if (draft.media?.absolute) safeUnlink(draft.media.absolute);
            drafts.delete(token);
        }
    }
}

function removeJobMedia(mediaPath) {
    try {
        safeUnlink(scheduler.resolveMediaPath(mediaPath));
    } catch (error) {
        // invalid/traversal path: nothing to remove
    }
}

function safeUnlink(file) {
    try {
        fs.unlinkSync(file);
    } catch (error) {
        // already gone
    }
}

function mediaExtension(mime, type) {
    const map = {
        'image/jpeg': '.jpg',
        'image/png': '.png',
        'image/webp': '.webp',
        'image/gif': '.gif',
        'video/mp4': '.mp4',
        'video/3gpp': '.3gp',
        'video/quicktime': '.mov',
        'video/webm': '.webm',
        'application/pdf': '.pdf',
        'text/plain': '.txt',
        'application/zip': '.zip'
    };
    return map[String(mime || '').toLowerCase()] || (type === 'image' ? '.jpg' : type === 'video' ? '.mp4' : '.bin');
}

function ensureMediaDir() {
    fs.mkdirSync(scheduler.MEDIA_ROOT, { recursive: true });
}

/** Download replied media into data/schedules with size + mime validation. */
async function storeMedia(sock, media) {
    if (!media) return null;
    const mime = String(media.node?.mimetype || '').toLowerCase();
    const allowed = scheduler.MIME_ALLOWLIST[media.type];
    if (!allowed || !allowed.test(mime)) {
        return { error: `Unsupported ${media.type} format${mime ? ` (${mime})` : ''}` };
    }
    let buffer;
    try {
        // Loaded lazily so offline tooling can inspect this module without deps.
        const { downloadMediaMessage } = require('@whiskeysockets/baileys');
        buffer = await downloadMediaMessage(media.target, 'buffer', {}, { logger: undefined, reuploadRequest: sock.updateMediaMessage });
    } catch (error) {
        return { error: 'Could not download that media' };
    }
    if (!buffer?.length) return { error: 'Downloaded media is empty' };
    if (buffer.length > scheduler.MEDIA_MAX_BYTES) {
        return { error: `Media is too large (max ${Math.round(scheduler.MEDIA_MAX_BYTES / 1048576)} MB)` };
    }
    ensureMediaDir();
    const name = `${crypto.randomBytes(6).toString('hex')}${mediaExtension(mime, media.type)}`;
    const absolute = path.join(scheduler.MEDIA_ROOT, name);
    fs.writeFileSync(absolute, buffer);
    const relative = path.relative(path.join(__dirname, '..', 'data'), absolute).split(path.sep).join('/');
    return { type: media.type, relative, absolute, mime, size: buffer.length };
}

function parseRecurrence(text) {
    if (/--daily\b/i.test(text)) return { recurrence: 'daily', text: text.replace(/--daily\b/i, '').trim() };
    if (/--weekly\b/i.test(text)) return { recurrence: 'weekly', text: text.replace(/--weekly\b/i, '').trim() };
    if (/--monthly\b/i.test(text)) return { recurrence: 'monthly', text: text.replace(/--monthly\b/i, '').trim() };
    return { recurrence: 'none', text };
}

/** "when | target | body" or "when target body" (date + clock counts as when). */
function parseNewArgs(raw) {
    const value = String(raw || '').trim();
    let when;
    let target;
    let body;
    if (value.includes('|')) {
        const parts = value.split('|').map((part) => part.trim());
        when = parts[0];
        target = parts[1];
        body = parts.slice(2).join(' | ').trim();
    } else {
        const tokens = value.split(/\s+/).filter(Boolean);
        if (/^\d{4}-\d{2}-\d{2}$/.test(tokens[0]) && /^\d{1,2}:\d{2}$/.test(tokens[1] || '')) {
            when = `${tokens[0]} ${tokens[1]}`;
            target = tokens[2];
            body = tokens.slice(3).join(' ');
        } else {
            when = tokens[0];
            target = tokens[1];
            body = tokens.slice(2).join(' ');
        }
    }
    return { when, target, body };
}

/** Status syntax is "when | text | recipients", not "when | target | text". */
function parseStatusArgs(raw) {
    const value = String(raw || '').trim();
    if (value.includes('|')) {
        const parts = value.split('|').map((part) => part.trim());
        return { when: parts[0], body: parts[1] || '', recipients: parts[2] || '' };
    }
    const tokens = value.split(/\s+/).filter(Boolean);
    if (/^\d{4}-\d{2}-\d{2}$/.test(tokens[0] || '') && /^\d{1,2}:\d{2}$/.test(tokens[1] || '')) {
        return { when: `${tokens[0]} ${tokens[1]}`, body: tokens.slice(2).join(' '), recipients: '' };
    }
    return { when: tokens[0] || '', body: tokens.slice(1).join(' '), recipients: '' };
}

function formatJob(job) {
    const zone = job.timezone || time.timezone();
    const icon = job.kind === 'status' ? '📷 Status' : job.mediaType !== 'none' ? `📎 ${job.mediaType}` : '💬 Message';
    const target = job.kind === 'status' ? `${job.target || 'status@broadcast'}` : job.target;
    return (
        `• *${job.publicId}* — ${icon}\n` +
        `   ${time.formatInZone(job.runAt, zone)} (${time.relativeLabel(job.runAt)})` +
        `${job.recurrence !== 'none' ? ` · ${job.recurrence}` : ''}\n` +
        `   → ${target}${job.body ? `\n   “${String(job.body).slice(0, 70)}${job.body.length > 70 ? '…' : ''}”` : ''}`
    );
}

async function resolveTarget(sock, targetInput, kind) {
    const raw = String(targetInput || '').trim();
    if (!raw) return { ok: false, error: 'Add a recipient (number or group id).' };
    if (kind === 'status') {
        const list = raw
            .split(',')
            .map((entry) => entry.trim())
            .filter(Boolean)
            .map((entry) => (entry.includes('@') ? entry : `${entry.replace(/[^0-9]/g, '')}@s.whatsapp.net`));
        const invalid = list.find((entry) => !/@(s\.whatsapp\.net|g\.us|lid)$/.test(entry));
        if (invalid) return { ok: false, error: `Invalid status recipient: ${invalid}` };
        return { ok: true, target: list.join(',') || 'status@broadcast', targetType: 'status' };
    }
    if (raw.endsWith('@g.us')) {
        try {
            const meta = await sock.groupMetadata(raw);
            if (!meta?.id) return { ok: false, error: 'Could not read that group.' };
        } catch (error) {
            return { ok: false, error: 'That group id is not valid or the bot is not in it.' };
        }
        return { ok: true, target: raw, targetType: 'group' };
    }
    if (raw.endsWith('@s.whatsapp.net') || raw.endsWith('@lid')) {
        return { ok: true, target: raw, targetType: 'contact' };
    }
    const digits = raw.replace(/[^0-9]/g, '');
    if (digits.length < 7 || digits.length > 16) {
        return { ok: false, error: 'Use a full phone number with country code (e.g. 916033271400) or a group id.' };
    }
    return { ok: true, target: `${digits}@s.whatsapp.net`, targetType: 'contact' };
}

function previewText(draft) {
    const lines = [
        '👀 *SCHEDULE PREVIEW*',
        '',
        `• Type: ${draft.kind === 'status' ? 'WhatsApp Status' : 'Message'}`,
        `• When: ${time.formatInZone(draft.runAt, draft.timezone)} (${draft.timezone})`,
        `• In: ${time.relativeLabel(draft.runAt)}`,
        `• To: ${draft.kind === 'status' ? draft.target || 'status@broadcast' : draft.target}`,
        `• Repeats: ${draft.recurrence === 'none' ? 'no' : draft.recurrence}`
    ];
    if (draft.media) lines.push(`• Media: ${draft.media.type} (${Math.round(draft.media.size / 1024)} KB)`);
    if (draft.body) lines.push(`• Text: “${draft.body.slice(0, 200)}${draft.body.length > 200 ? '…' : ''}”`);
    lines.push('', 'Nothing has been saved yet.');
    lines.push(`Reply *.schedule confirm ${draft.token}* within 10 minutes to save it, or *.schedule cancel* to discard.`);
    return lines.join('\n');
}

function newDraft(data) {
    cleanupDrafts();
    const token = crypto.randomBytes(3).toString('hex').toUpperCase();
    const draft = { ...data, token, expiresAt: Date.now() + DRAFT_TTL_MS };
    drafts.set(token, draft);
    return draft;
}

async function handleNew(sock, chatId, msg, args, kind) {
    const parsed = parseRecurrence(args);
    let when;
    let target;
    let body;
    if (kind === 'status') {
        const statusArgs = parseStatusArgs(parsed.text);
        when = statusArgs.when;
        target = statusArgs.recipients || 'status@broadcast';
        body = statusArgs.body;
    } else {
        ({ when, target, body } = parseNewArgs(parsed.text));
    }
    if (!when) return reply(sock, chatId, msg, 'Give a time first, e.g. `.schedule new 2026-11-22 09:30 | 916033271400 | Hello`');

    const parsedWhen = time.parseWhen(when, { timezone: time.timezone() });
    if (!parsedWhen.ok) return reply(sock, chatId, msg, `⚠️ ${parsedWhen.error}`);

    const resolved = await resolveTarget(sock, kind === 'status' ? target || 'status@broadcast' : target, kind);
    if (!resolved.ok) return reply(sock, chatId, msg, `⚠️ ${resolved.error}`);

    const media = resolveMedia(msg);
    let stored = null;
    if (media) {
        if (kind === 'status' && media.type === 'document') {
            return reply(sock, chatId, msg, '⚠️ A WhatsApp Status can be text, an image or a video — documents are not supported.');
        }
        stored = await storeMedia(sock, media);
        if (stored?.error) return reply(sock, chatId, msg, `⚠️ ${stored.error}`);
    }
    const caption = body || '';
    if (!stored && !caption) {
        return reply(sock, chatId, msg, '⚠️ Add a message, or reply to an image/video/document with this command.');
    }

    const draft = newDraft({
        kind: kind === 'status' ? 'status' : 'message',
        runAt: parsedWhen.date,
        timezone: parsedWhen.timezone,
        target: resolved.target,
        targetType: kind === 'status' ? 'status' : resolved.targetType,
        body: caption,
        media: stored,
        recurrence: parsed.recurrence,
        createdBy: (msg.key.participant || msg.key.remoteJid || '').split('@')[0]
    });
    return reply(sock, chatId, msg, previewText(draft));
}

async function listUpcoming(sock, chatId, msg, kind) {
    const jobs = await store.listJobs({ upcoming: true, limit: 15, kind });
    if (jobs === null) return reply(sock, chatId, msg, '⚠️ Database unavailable — scheduled messages need MySQL.');
    if (!jobs.length) return reply(sock, chatId, msg, kind === 'status' ? '📷 No upcoming Status updates.' : '🗓️ No upcoming schedules.');
    const title = kind === 'status' ? '📷 *UPCOMING STATUS*' : '🗓️ *UPCOMING SCHEDULES*';
    return reply(sock, chatId, msg, `${title}\n\n${jobs.map(formatJob).join('\n\n')}\n\nCancel with .schedule ${kind === 'status' ? 'status cancel' : 'cancel'} <id>`);
}

async function listHistory(sock, chatId, msg) {
    const rows = await store.history(10);
    if (rows === null) return reply(sock, chatId, msg, '⚠️ Database unavailable.');
    if (!rows.length) return reply(sock, chatId, msg, '🕘 No executions recorded yet.');
    const label = { sent: '✅ sent', failed: '❌ failed', retry: '🔁 retry', cancelled: '🚫 cancelled' };
    const lines = rows.map(
        (row) =>
            `${label[row.status] || row.status} *${row.publicId}* · ${row.kind}\n   ${time.formatInZone(row.at)} → ${row.target}${row.detail ? `\n   ${row.detail}` : ''}`
    );
    return reply(sock, chatId, msg, `🕘 *RECENT SCHEDULE HISTORY*\n\n${lines.join('\n\n')}`);
}

async function statusOverview(sock, chatId, msg) {
    const summary = await store.statusSummary();
    if (!summary) return reply(sock, chatId, msg, '⚠️ Database unavailable.');
    const lines = [
        '📷 *SCHEDULED STATUS*',
        '',
        `• Pending: ${summary.pending}`,
        `• Sending: ${summary.sending}`,
        `• Published: ${summary.sent}`,
        `• Failed: ${summary.failed}`,
        `• Cancelled: ${summary.cancelled}`,
        '',
        summary.next ? `Next: ${time.formatInZone(summary.next.runAt)} (${time.relativeLabel(summary.next.runAt)})` : 'Next: nothing scheduled',
        '',
        'Use .schedule status new <time> | <text> to publish a Status later.',
        'Publishing uses the WhatsApp status broadcast; it is reported as published only after the library confirms the send.'
    ];
    return reply(sock, chatId, msg, lines.join('\n'));
}

async function handleSchedule(sock, chatId, message) {
    try {
        if (!(await ownerOnly(sock, chatId, message))) {
            return sock.sendMessage(chatId, { text: '🔒 Only the bot owner can use .schedule.' }, { quoted: message });
        }
        const text = textOf(message);
        const args = text.replace(/^\.schedule\s*/i, '').trim();
        const lower = args.toLowerCase();

        if (!args) return reply(sock, chatId, message, USAGE);
        if (lower === 'help' || lower === 'menu') return reply(sock, chatId, message, USAGE);
        if (lower === 'list') return listUpcoming(sock, chatId, message, null);
        if (lower === 'history') return listHistory(sock, chatId, message);
        if (lower === 'status') return statusOverview(sock, chatId, message);
        if (lower === 'status list') return listUpcoming(sock, chatId, message, 'status');

        const cancelMatch = /^(status\s+)?cancel\s+([A-Za-z0-9]{4,12})$/i.exec(args);
        if (cancelMatch) {
            const job = await store.find(cancelMatch[2]);
            const result = await store.cancelJob(cancelMatch[2]);
            if (result.ok && job?.mediaPath) removeJobMedia(job.mediaPath);
            return reply(sock, chatId, message, result.ok ? `🚫 Cancelled schedule *${cancelMatch[2].toUpperCase()}*.` : `⚠️ ${result.error}`);
        }
        const deleteMatch = /^delete\s+([A-Za-z0-9]{4,12})$/i.exec(args);
        if (deleteMatch) {
            const job = await store.find(deleteMatch[1]);
            const result = await store.deleteJob(deleteMatch[1]);
            if (result.ok && job?.mediaPath) removeJobMedia(job.mediaPath);
            return reply(sock, chatId, message, result.ok ? `🗑️ Deleted schedule *${deleteMatch[1].toUpperCase()}*.` : `⚠️ ${result.error}`);
        }

        const editMatch = /^edit\s+([A-Za-z0-9]{4,12})(?:\s+(time|text|repeat)\s+([\s\S]+))?$/i.exec(args);
        if (editMatch) {
            const job = await store.find(editMatch[1]);
            if (!job) return reply(sock, chatId, message, '⚠️ No schedule with that id.');
            if (job.status !== 'pending') return reply(sock, chatId, message, `⚠️ Only pending schedules can be edited (this one is ${job.status}).`);
            const field = (editMatch[2] || '').toLowerCase();
            const value = (editMatch[3] || '').trim();
            if (!field) {
                return reply(
                    sock,
                    chatId,
                    message,
                    `✏️ *${job.publicId}*\n${formatJob(job)}\n\nEdit with:\n.schedule edit ${job.publicId} time <when>\n.schedule edit ${job.publicId} text <new text>\n.schedule edit ${job.publicId} repeat none|daily|weekly|monthly`
                );
            }
            let patch = null;
            if (field === 'time') {
                const parsedWhen = time.parseWhen(value, { timezone: job.timezone || time.timezone() });
                if (!parsedWhen.ok) return reply(sock, chatId, message, `⚠️ ${parsedWhen.error}`);
                patch = { runAt: parsedWhen.date };
            } else if (field === 'text') {
                if (!value) return reply(sock, chatId, message, '⚠️ Give the new text.');
                patch = { body: value };
            } else {
                const repeat = value.toLowerCase();
                if (!['none', 'daily', 'weekly', 'monthly'].includes(repeat)) {
                    return reply(sock, chatId, message, '⚠️ Repeat must be none, daily, weekly or monthly.');
                }
                patch = { recurrence: repeat };
            }
            const updated = await store.updateJob(job.publicId, patch);
            if (!updated.ok) return reply(sock, chatId, message, `⚠️ ${updated.error}`);
            const fresh = await store.find(job.publicId);
            return reply(sock, chatId, message, `✅ Updated *${job.publicId}*\n${fresh ? formatJob(fresh) : ''}`);
        }

        if (lower === 'cancel' || lower === 'discard') {
            let removed = 0;
            for (const [token, draft] of drafts) {
                if (draft.createdBy && draft.createdBy !== String(message.key.participant || message.key.remoteJid || '').split('@')[0]) continue;
                if (draft.media?.absolute) {
                    safeUnlink(draft.media.absolute);
                    removed += 1;
                }
                drafts.delete(token);
            }
            return reply(sock, chatId, message, removed ? '🗑️ Pending preview discarded (media removed).' : '🗑️ Discarded the pending preview.');
        }

        const confirmMatch = /^confirm\s+([A-Za-z0-9]{6})$/i.exec(args);
        if (confirmMatch) {
            cleanupDrafts();
            const token = confirmMatch[1].toUpperCase();
            const draft = drafts.get(token);
            if (!draft) return reply(sock, chatId, message, '⌛ That preview expired. Create it again with .schedule new …');
            if (draft.runAt.getTime() <= Date.now()) {
                drafts.delete(token);
                if (draft.media?.absolute) safeUnlink(draft.media.absolute);
                return reply(sock, chatId, message, '⚠️ That time has already passed. Create the schedule again.');
            }
            // Duplicate-job guard: an identical pending schedule within a minute
            // would otherwise be sent twice.
            const upcoming = await store.listJobs({ upcoming: true, limit: 100, kind: draft.kind });
            const duplicate = Array.isArray(upcoming)
                ? upcoming.find(
                      (job) =>
                          job.publicId &&
                          job.target === draft.target &&
                          String(job.body || '') === String(draft.body || '') &&
                          Math.abs(new Date(job.runAt).getTime() - draft.runAt.getTime()) < 60000
                  )
                : null;
            if (duplicate) {
                if (draft.media?.absolute) safeUnlink(draft.media.absolute);
                drafts.delete(token);
                return reply(sock, chatId, message, `⚠️ An identical schedule already exists (*${duplicate.publicId}*). Cancel it first or change the time/text.`);
            }
            const created = await store.createJob({
                kind: draft.kind,
                target: draft.target,
                targetType: draft.targetType,
                body: draft.body,
                mediaType: draft.media?.type || 'none',
                mediaPath: draft.media?.relative || null,
                mediaMime: draft.media?.mime || null,
                mediaSize: draft.media?.size || null,
                runAt: draft.runAt,
                timezone: draft.timezone,
                recurrence: draft.recurrence,
                createdBy: draft.createdBy
            });
            drafts.delete(token);
            if (!created.ok) {
                if (draft.media?.absolute) safeUnlink(draft.media.absolute);
                return reply(sock, chatId, message, `⚠️ Could not save: ${created.error}`);
            }
            return reply(
                sock,
                chatId,
                message,
                `✅ Scheduled *${created.publicId}*\n${draft.kind === 'status' ? '📷 Status' : '💬 Message'} → ${draft.target}\n🗓️ ${time.formatInZone(draft.runAt, draft.timezone)} (${time.relativeLabel(draft.runAt)})` +
                    `${draft.recurrence !== 'none' ? `\n🔁 Repeats ${draft.recurrence}` : ''}\n\nCancel with .schedule cancel ${created.publicId}`
            );
        }

        const statusNew = /^status\s+new\s+(.+)$/i.exec(args);
        if (statusNew) return handleNew(sock, chatId, message, statusNew[1], 'status');

        const newMatch = /^new\s+(.+)$/i.exec(args);
        if (newMatch) return handleNew(sock, chatId, message, newMatch[1], 'message');

        return reply(sock, chatId, message, USAGE);
    } catch (error) {
        console.error('[schedule] command failed:', db.safeError(error));
        return reply(sock, chatId, message, '⚠️ Could not handle that schedule command.');
    }
}

module.exports = { handleSchedule, parseNewArgs, parseStatusArgs, formatJob, previewText, USAGE, drafts };
