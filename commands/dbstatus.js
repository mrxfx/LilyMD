'use strict';
/**
 * .dbstatus / .aistatus — owner-only health summary.
 * Neither command prints credentials, hosts or private message bodies.
 */

const db = require('../lib/db');
const scheduler = require('../lib/scheduler');
const dbMemory = require('../lib/dbMemory');
const dbSchedules = require('../lib/dbSchedules');

// Lazy: messageConfig loads settings/dotenv, which offline tooling lacks.
function channelContext() {
    try {
        return require('../lib/messageConfig').channelInfo || {};
    } catch (error) {
        return {};
    }
}

async function allowed(sock, chatId, msg) {
    if (msg.key.fromMe) return true;
    // Lazy: keeps this module loadable by offline tooling (no node_modules).
    const isOwnerOrSudo = require('../lib/isOwner');
    return isOwnerOrSudo(msg.key.participant || msg.key.remoteJid, sock, chatId);
}

function textOf(msg) {
    return (msg.message?.conversation || msg.message?.extendedTextMessage?.text || '').trim();
}

async function dbStatusCommand(sock, chatId, msg) {
    try {
        if (!(await allowed(sock, chatId, msg))) {
            return sock.sendMessage(chatId, { text: '🔒 Owner only.' }, { quoted: msg });
        }
        const ping = db.configured() ? await db.ping() : { ok: false, error: 'not configured' };
        const state = db.status();
        const stats = ping.ok ? await db.tableStats() : null;
        const lines = [
            '🗄️ *DATABASE STATUS*',
            '',
            `• Configured: ${state.configured ? 'yes' : 'no'}`,
            `• Connected: ${ping.ok ? 'yes' : 'no'}`,
            `• Database: ${state.database || '—'}`,
            `• Driver: ${state.driver}`,
            `• Pool limit: ${state.connectionLimit}`,
            ping.ok ? `• Latency: ${ping.latencyMs} ms` : `• Error: ${ping.error || 'unknown'}`,
            state.lastOkAt ? `• Last OK: ${state.lastOkAt.replace('T', ' ').slice(0, 19)} UTC` : '',
            '',
            stats
                ? `• Contacts: ${stats.contacts}\n• Messages: ${stats.conversation_messages}\n• Memories: ${stats.contact_memories}\n• Jobs: ${stats.scheduled_jobs}\n• Logs: ${stats.scheduled_job_logs}`
                : '• Table counts unavailable'
        ].filter(Boolean);
        return sock.sendMessage(chatId, { text: lines.join('\n'), ...channelContext() }, { quoted: msg });
    } catch (error) {
        console.error('[dbstatus] failed:', db.safeError(error));
        return sock.sendMessage(chatId, { text: '⚠️ Could not read database status.' }, { quoted: msg });
    }
}

async function aiStatusCommand(sock, chatId, msg) {
    try {
        if (!(await allowed(sock, chatId, msg))) {
            return sock.sendMessage(chatId, { text: '🔒 Owner only.' }, { quoted: msg });
        }
        // Required lazily so a missing provider file never breaks this command.
        const aiContacts = require('../lib/aiContacts');
        const aiStyle = require('../lib/aiStyle');
        const memory = await dbMemory.stats();
        const scheduleState = scheduler.state();
        const contacts = aiContacts.listContacts().length;
        const samples = (aiStyle.getStyleData().samples || []).length;
        const pending = await dbSchedules.listJobs({ upcoming: true, limit: 100 });
        const lines = [
            '🤖 *AYHA STATUS*',
            '',
            `• Memory cache: ${contacts} contact(s), ${samples} style sample(s)`,
            memory
                ? `• MySQL memory: ${memory.contacts} contacts · ${memory.messages} messages · ${memory.memories} facts · ${memory.styleSamples} style samples`
                : '• MySQL memory: unavailable',
            `• Scheduler: ${scheduleState.started ? 'running' : 'stopped'} · every ${Math.round(scheduleState.intervalMs / 1000)}s · ${scheduleState.timezone}`,
            `• Last tick: ${scheduleState.lastTickAt ? scheduleState.lastTickAt.replace('T', ' ').slice(0, 19) : '—'} UTC`,
            `• Upcoming jobs: ${Array.isArray(pending) ? pending.length : 'unavailable'}`,
            '',
            'Commands: .aimemory · .dbstatus · .schedule'
        ].filter(Boolean);
        return sock.sendMessage(chatId, { text: lines.join('\n'), ...channelContext() }, { quoted: msg });
    } catch (error) {
        console.error('[aistatus] failed:', db.safeError(error));
        return sock.sendMessage(chatId, { text: '⚠️ Could not read AYHA status.' }, { quoted: msg });
    }
}

module.exports = { dbStatusCommand, aiStatusCommand, textOf };
