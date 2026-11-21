'use strict';
/**
 * Offline tests for the MySQL layer, AYHA memory and the scheduling engine.
 *
 *   node scripts/test-db-scheduling.js
 *
 * No MySQL server and no node_modules are required: lib/db accepts an injected
 * query function, so every statement (and its parameters) is inspected here.
 * Media files created by the tests are removed afterwards.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
process.env.SCHEDULE_TIMEZONE = 'Asia/Kolkata';
// Placeholder connection settings: every query below is served by an injected
// driver, so no server is contacted.
process.env.DB_HOST = process.env.DB_HOST || 'db.example.test';
process.env.DB_PORT = process.env.DB_PORT || '3306';
process.env.DB_NAME = process.env.DB_NAME || 'lily_test';
process.env.DB_USER = process.env.DB_USER || 'lily_test';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'placeholder';

const db = require('../lib/db');
const time = require('../lib/scheduleTime');
const dbMemory = require('../lib/dbMemory');
const store = require('../lib/dbSchedules');
const scheduler = require('../lib/scheduler');
const { runMigrations } = require('../lib/migrate');
const { parseNewArgs, parseStatusArgs } = require('../commands/schedule');

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
    if (condition) {
        passed += 1;
        console.log(`  ✓ ${name}`);
    } else {
        failed += 1;
        console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
    }
}

function header(affectedRows = 1, insertId = 1) {
    return [{ affectedRows, insertId }, []];
}

function rows(list) {
    return [list, []];
}

const ORIGINAL_DB_ENV = {
    DB_HOST: process.env.DB_HOST,
    DB_NAME: process.env.DB_NAME,
    DB_USER: process.env.DB_USER,
    DB_PASSWORD: process.env.DB_PASSWORD
};

async function testMigrations() {
    console.log('\nMigrations');
    db.__setQueryForTests(async (sql, params) => {
        if (/CREATE TABLE IF NOT EXISTS schema_migrations/i.test(sql)) return header(0);
        if (/^SELECT id FROM schema_migrations/.test(sql)) {
            return rows(applied.map((id) => ({ id })));
        }
        if (/^INSERT INTO schema_migrations/.test(sql)) {
            applied.push(params[0]);
            return header(1);
        }
        ddl.push(sql);
        return header(0);
    });
    const applied = [];
    const ddl = [];
    const first = await runMigrations({ log: () => {} });
    check('migrations run', first.ok === true, first.error);
    check('both migrations applied once', applied.join(',') === '001_core_schema,002_scheduling', applied.join(','));
    check('tables created idempotently', ddl.every((sql) => /CREATE (TABLE IF NOT EXISTS|OR REPLACE VIEW)/i.test(sql)), ddl[0]);
    check('expected core tables exist in DDL', ['contacts', 'conversation_messages', 'contact_memories', 'owner_style_profile', 'contact_preferences', 'scheduled_jobs', 'scheduled_job_logs', 'scheduled_status', 'bot_settings'].every((table) => ddl.some((sql) => sql.includes(table))));
    check('foreign keys declared', ddl.filter((sql) => /FOREIGN KEY/.test(sql)).length >= 4);
    check('job indexes declared', /idx_jobs_due/.test(ddl.join('\n')) && /idx_jobs_target/.test(ddl.join('\n')));

    const ddlCount = ddl.length;
    const second = await runMigrations({ log: () => {} });
    check('second startup applies nothing', second.ok && second.applied.length === 0 && ddl.length === ddlCount);
    check('startup never drops or truncates', !ddl.some((sql) => /DROP\s+TABLE|TRUNCATE/i.test(sql)));
}

async function testSecurity() {
    console.log('\nSecurity');
    const sentinel = 'SuperSecretPassword!42';
    const previous = process.env.DB_PASSWORD;
    process.env.DB_PASSWORD = sentinel;
    const state = db.status();
    check('status hides the password', !JSON.stringify(state).includes(sentinel));
    check('status returns only safe fields', ['configured', 'connected', 'database', 'connectionLimit', 'lastError', 'driver'].every((key) => key in state));
    check('status has no password or user field', !('password' in state) && !('user' in state));
    process.env.DB_PASSWORD = previous;

    const captured = [];
    db.__setQueryForTests(async (sql, params) => {
        captured.push({ sql, params });
        return rows([]);
    });
    await db.execute('SELECT * FROM contacts WHERE jid = ? AND phone = ?', ['1@s.whatsapp.net', "'; DROP TABLE contacts; --"]);
    check('values are bound, not interpolated', !captured[0].sql.includes('DROP TABLE') && captured[0].params.length === 2);
    check('prepared placeholders used', (captured[0].sql.match(/\?/g) || []).length === 2);

    let threw = false;
    try {
        await db.execute('SELECT ?', [1]);
    } catch (error) {
        threw = true;
    }
    check('injected driver errors propagate to callers', threw === false);
}

async function testMemory() {
    console.log('\nAYHA memory');
    const inserts = [];
    db.__setQueryForTests(async (sql, params) => {
        inserts.push({ sql, params });
        if (/^SELECT id FROM contacts/.test(sql)) return rows([{ id: params[0].includes('arjun') ? 1 : 2 }]);
        return header(1);
    });
    const saved = await dbMemory.saveContactSnapshot({
        chatId: '919000000001@s.whatsapp.net',
        name: 'Arjun',
        facts: { name: 'Arjun', location: 'Delhi' },
        settings: { autoReply: 'on', never: false, tone: '', language: '', delaySec: null }
    });
    check('contact snapshot written', saved === true);
    check('contact upsert is parameterized', inserts.some((q) => /INSERT INTO contacts/.test(q.sql) && q.params[0] === '919000000001@s.whatsapp.net'));
    check('preferences written separately', inserts.some((q) => /INSERT INTO contact_preferences/.test(q.sql)));
    check('facts written one by one', inserts.filter((q) => /INSERT INTO contact_memories/.test(q.sql)).length === 2);

    const memoryRows = [
        { id: 1, jid: 'arjun@s.whatsapp.net', phone: '91', push_name: 'Arjun', language: 'hinglish' },
        { id: 2, jid: 'neha@s.whatsapp.net', phone: '92', push_name: 'Neha', language: 'english' }
    ];
    db.__setQueryForTests(async (sql) => {
        if (/FROM contacts ORDER BY id/.test(sql)) return rows(memoryRows);
        if (/FROM contact_preferences/.test(sql)) {
            return rows([
                { contact_id: 1, auto_reply: 'on', never_reply: 0, tone: '', language: '', delay_sec: null, handoff_until: null, last_owner_message_at: null, needs_review: null },
                { contact_id: 2, auto_reply: 'off', never_reply: 0, tone: 'friendly', language: 'english', delay_sec: 5, handoff_until: null, last_owner_message_at: null, needs_review: null }
            ]);
        }
        if (/FROM contact_memories/.test(sql)) {
            return rows([
                { contact_id: 1, fact_key: 'name', fact_value: 'Arjun', source: 'contact' },
                { contact_id: 1, fact_key: 'location', fact_value: 'Delhi', source: 'contact' },
                { contact_id: 2, fact_key: 'name', fact_value: 'Neha', source: 'contact' }
            ]);
        }
        if (/ROW_NUMBER\(\) OVER \(PARTITION BY contact_id/.test(sql)) {
            return rows([
                { contact_id: 1, role: 'user', body: 'Mera naam Arjun hai', had_media: 0, created_at: '2026-11-21 10:00:00' },
                { contact_id: 2, role: 'user', body: 'I live in Kolkata', had_media: 0, created_at: '2026-11-21 10:01:00' }
            ]);
        }
        return rows([]);
    });
    const records = await dbMemory.loadAllContacts();
    const arjun = records.find((record) => record.chatId === 'arjun@s.whatsapp.net');
    const neha = records.find((record) => record.chatId === 'neha@s.whatsapp.net');
    check('both contacts hydrated', records.length === 2);
    check('facts stay with their contact', arjun.facts.location === 'Delhi' && neha.facts.location === undefined);
    check('no cross-contact turns', arjun.turns.length === 1 && neha.turns.length === 1 && arjun.turns[0].text !== neha.turns[0].text);
    check('per-contact preferences restored', arjun.settings.autoReply === 'on' && neha.settings.autoReply === 'off' && neha.settings.delaySec === 5);

    const trims = [];
    db.__setQueryForTests(async (sql, params) => {
        trims.push({ sql, params });
        if (/^SELECT id FROM contacts/.test(sql)) return rows([{ id: 7 }]);
        return header(1);
    });
    await dbMemory.appendTurn('919000000003@s.whatsapp.net', 'user', 'hello', { hadMedia: true });
    check('turn insert binds the contact id', trims.some((q) => /INSERT INTO conversation_messages/.test(q.sql) && q.params[0] === 7));
    const trim = trims.find((q) => /^DELETE FROM conversation_messages/.test(q.sql));
    check('memory limit enforced with a bound LIMIT', Boolean(trim) && trim.params.includes(dbMemory.MAX_MESSAGES_PER_CONTACT));

    const styleCalls = [];
    db.__setQueryForTests(async (sql, params) => {
        styleCalls.push({ sql, params });
        return header(1);
    });
    await dbMemory.saveStyleSample('Hy Dear Good Morning', 'english');
    const styleInsert = styleCalls.find((q) => /INSERT IGNORE INTO owner_style_profile/.test(q.sql));
    check('style sample stored with a hash', Boolean(styleInsert) && styleInsert.params[2]?.length === 64);
    check('style samples are capped', styleCalls.some((q) => /^DELETE FROM owner_style_profile/.test(q.sql)));

    const exported = await dbMemory.exportAll();
    check('export never throws without a DB', exported === null || Array.isArray(exported.contacts));
}

async function testScheduleQueue() {
    console.log('\nSchedule queue');
    db.__setQueryForTests(async () => header(0));
    process.env.DB_HOST = process.env.DB_HOST || 'db.example.test';
    process.env.DB_NAME = process.env.DB_NAME || 'lily';
    process.env.DB_USER = process.env.DB_USER || 'lily';

    const inserts = [];
    db.__setQueryForTests(async (sql, params) => {
        inserts.push({ sql, params });
        return header(1);
    });
    const created = await store.createJob({
        kind: 'message',
        target: '916033271400',
        targetType: 'contact',
        body: 'Good morning',
        runAt: new Date('2026-11-22T04:00:00Z'),
        timezone: 'Asia/Kolkata',
        recurrence: 'daily',
        createdBy: '916033352400'
    });
    check('job created', created.ok && /^[A-F0-9]{10}$/.test(created.publicId), created.error);
    const insert = inserts[0];
    check('job insert is parameterized', /VALUES \(\?/.test(insert.sql) && !insert.sql.includes('Good morning'));
    check('job stores UTC run time', insert.params[9] === '2026-11-22 04:00:00', insert.params[9]);
    check('job defaults to pending', /'pending'/.test(insert.sql));

    let updates = 0;
    let claimLogs = 0;
    let claimSql = '';
    const due = [
        { id: 1, public_id: 'AAAA111111', kind: 'message', target_jid: '916033271400@s.whatsapp.net', target_type: 'contact', body: 'one', media_type: 'none', run_at: '2026-11-21 00:00:00', attempts: 0, max_attempts: 3, recurrence: 'none' },
        { id: 2, public_id: 'BBBB222222', kind: 'message', target_jid: '916033271400@s.whatsapp.net', target_type: 'contact', body: 'two', media_type: 'none', run_at: '2026-11-21 00:00:00', attempts: 0, max_attempts: 3, recurrence: 'none' }
    ];
    db.__setQueryForTests(async (sql, params) => {
        if (/^SELECT \* FROM scheduled_jobs/.test(sql)) return rows(due);
        if (/SET status = 'sending'/.test(sql)) {
            claimSql = sql;
            updates += 1;
            return header(updates === 1 ? 1 : 0); // second worker lost the race
        }
        if (/^INSERT INTO scheduled_job_logs/.test(sql)) {
            claimLogs += 1;
            return header(1);
        }
        if (/^SELECT id FROM scheduled_jobs/.test(sql)) return rows([{ id: Number(params[1]) || 1 }]);
        return header(1);
    });
    const claimed = await store.claimDue(5);
    check('only the winner of a race claims a job', claimed.length === 1, String(claimed.length));
    check('claim uses a conditional update', /WHERE id = \? AND status = 'pending'/.test(claimSql) && /SET status = 'sending'/.test(claimSql));
    check('claim increments attempts', claimed[0].attempts === 1);
    check('claim is logged', claimLogs >= 1);

    const failures = [];
    db.__setQueryForTests(async (sql, params) => {
        failures.push({ sql, params });
        if (/^SELECT id FROM scheduled_jobs/.test(sql)) return rows([{ id: 5 }]);
        return header(1);
    });
    const retry = await store.markFailed({ id: 5, publicId: 'AAAA111111', attempts: 1, maxAttempts: 3, kind: 'message' }, 'ECONNRESET: timeout', true);
    check('temporary failure is retried', retry === 'retry');
    const retryUpdate = failures.find((q) => /status = 'pending'/.test(q.sql) && /last_error/.test(q.sql));
    check('retry reschedules with backoff', Boolean(retryUpdate) && Boolean(retryUpdate.params[0]));

    failures.length = 0;
    const permanent = await store.markFailed({ id: 5, publicId: 'AAAA111111', attempts: 3, maxAttempts: 3, kind: 'message' }, 'Media file missing', false);
    check('permanent failure is not retried', permanent === 'failed');
    check('failed job records the reason', failures.some((q) => /status = 'failed'/.test(q.sql) && /Media file missing/.test(q.params[0])));

    let sentGuard = null;
    db.__setQueryForTests(async (sql, params) => {
        if (/SET status = 'sent'/.test(sql)) sentGuard = { sql, params };
        return header(0);
    });
    const duplicate = await store.markSent({ id: 9, publicId: 'CCCC333333', kind: 'message' });
    check('a sent transition only applies to claimed jobs', duplicate === false && /AND status = 'sending'/.test(sentGuard.sql));

    db.__setQueryForTests(async (sql) => (/release|UPDATE/.test(sql) ? header(2) : rows([])));
    const stale = await store.releaseStale(10);
    check('stale sending jobs are released', stale === 2, String(stale));
}

async function testScheduler() {
    console.log('\nScheduler worker');
    db.__setQueryForTests(async () => header(0));
    process.env.DB_HOST = process.env.DB_HOST || 'db.example.test';
    process.env.DB_NAME = process.env.DB_NAME || 'lily';
    process.env.DB_USER = process.env.DB_USER || 'lily';

    const offline = await scheduler.tick({ sock: null, isConnected: () => false });
    check('offline bot skips the queue', offline.skipped === 'offline');

    const job = {
        id: 11,
        publicId: 'DDDD444444',
        kind: 'message',
        target: '916033271400',
        targetType: 'contact',
        body: 'Scheduled hello',
        mediaType: 'none',
        runAt: new Date(),
        timezone: 'Asia/Kolkata',
        recurrence: 'none',
        attempts: 1,
        maxAttempts: 3
    };
    let claimed = false;
    let markedSent = false;
    db.__setQueryForTests(async (sql, params) => {
        if (/^SELECT \* FROM scheduled_jobs/.test(sql)) return rows(claimed ? [] : [{ ...job, target_jid: job.target, public_id: job.publicId, media_type: 'none', attempts: 0, max_attempts: 3, run_at: '2026-11-21 00:00:00', status: 'pending' }]);
        if (/SET status = 'sending'/.test(sql)) {
            claimed = true;
            return header(1);
        }
        if (/SET status = 'sent'/.test(sql)) {
            markedSent = true;
            return header(1);
        }
        return header(1);
    });
    const sent = [];
    const sock = { sendMessage: async (jid, content) => { sent.push({ jid, content }); return { key: { id: 'x' } }; } };
    const result = await scheduler.tick({ sock, isConnected: () => true });
    check('due message is sent', result.sent === 1, JSON.stringify(result));
    check('message goes to the contact jid', sent[0]?.jid === '916033271400@s.whatsapp.net', sent[0]?.jid);
    check('text content used', sent[0]?.content.text === 'Scheduled hello');
    check('result recorded as sent', markedSent === true);

    // Status job
    const statusSends = [];
    let failedStatus = null;
    claimed = false;
    db.__setQueryForTests(async (sql, params) => {
        if (/^SELECT \* FROM scheduled_jobs/.test(sql)) return rows([{ ...job, kind: 'status', public_id: 'EEEE555555', target_jid: '916033271400@s.whatsapp.net,916033352400@s.whatsapp.net', media_type: 'none', attempts: 0, max_attempts: 3, run_at: '2026-11-21 00:00:00', status: 'pending' }]);
        if (/SET status = 'sending'/.test(sql)) return header(1);
        if (/SET status = 'failed'/.test(sql)) {
            failedStatus = params[0];
            return header(1);
        }
        if (/SET status = 'sent'/.test(sql)) return header(1);
        return header(1);
    });
    const statusSock = {
        sendMessage: async (jid, content, options) => {
            statusSends.push({ jid, content, options });
            return { key: { id: 'st' } };
        }
    };
    const statusResult = await scheduler.tick({ sock: statusSock, isConnected: () => true });
    check('status published to the broadcast jid', statusResult.sent === 1 && statusSends[0]?.jid === 'status@broadcast');
    check('status recipients passed as statusJidList', Array.isArray(statusSends[0]?.options?.statusJidList) && statusSends[0].options.statusJidList.length === 2);
    check('status send marked broadcast', statusSends[0]?.options?.broadcast === true);

    // Unsupported library must fail, never pretend
    claimed = false;
    failedStatus = null;
    db.__setQueryForTests(async (sql, params) => {
        if (/^SELECT \* FROM scheduled_jobs/.test(sql)) return rows([{ ...job, kind: 'status', public_id: 'FFFF666666', target_jid: 'status@broadcast', media_type: 'none', attempts: 2, max_attempts: 3, run_at: '2026-11-21 00:00:00', status: 'pending' }]);
        if (/SET status = 'sending'/.test(sql)) return header(1);
        if (/SET status = 'failed'/.test(sql)) {
            failedStatus = params[0];
            return header(1);
        }
        return header(1);
    });
    const badResult = await scheduler.tick({ sock: {}, isConnected: () => true });
    check('missing sendMessage reports failure', badResult.failed === 1 && /not supported/i.test(failedStatus || ''), failedStatus);

    let permanentThrown = false;
    try {
        await scheduler.executeJob({ sendMessage: async () => ({}) }, { ...job, target: 'abc' });
    } catch (error) {
        permanentThrown = /Invalid recipient/.test(error.message);
    }
    check('invalid recipients are rejected', permanentThrown);
}

function testTimeAndParsing() {
    console.log('\nTime and parsing');
    const now = new Date('2026-11-21T00:00:00Z');
    const parsed = time.parseWhen('2026-11-22 09:30', { timezone: 'Asia/Kolkata', now });
    check('Asia/Kolkata date parsed to UTC', parsed.ok && parsed.date.toISOString() === '2026-11-22T04:00:00.000Z', parsed.ok ? parsed.date.toISOString() : parsed.error);
    const clock = time.parseWhen('20:30', { timezone: 'Asia/Kolkata', now });
    check('clock-only time is converted', clock.ok && clock.date.toISOString() === '2026-11-21T15:00:00.000Z', clock.ok ? clock.date.toISOString() : clock.error);
    const relative = time.parseWhen('+2h', { timezone: 'Asia/Kolkata', now });
    check('relative time supported', relative.ok && relative.date.getTime() === now.getTime() + 2 * 3600000);
    const euro = time.parseWhen('22/11/2026 09:30', { timezone: 'Asia/Kolkata', now });
    check('DD/MM/YYYY supported', euro.ok && euro.date.toISOString() === '2026-11-22T04:00:00.000Z');
    const past = time.parseWhen('2026-11-20 09:30', { timezone: 'Asia/Kolkata', now });
    check('past times rejected', past.ok === false);
    const tomorrow = time.parseWhen('tomorrow 09:00', { timezone: 'Asia/Kolkata', now });
    check('tomorrow supported', tomorrow.ok === true);
    check('invalid input rejected', time.parseWhen('sometime later', { timezone: 'Asia/Kolkata', now }).ok === false);

    const weekly = time.addRecurrence(new Date('2026-11-22T04:00:00Z'), 'weekly');
    check('weekly recurrence adds 7 days', weekly.toISOString() === '2026-11-29T04:00:00.000Z');
    const monthly = time.addRecurrence(new Date('2026-01-31T04:00:00Z'), 'monthly');
    check('monthly recurrence clamps to month end', monthly.toISOString().startsWith('2026-02-28'));

    const piped = parseNewArgs('2026-11-22 09:30 | 916033271400 | Good morning');
    check('pipe syntax parsed', piped.when === '2026-11-22 09:30' && piped.target === '916033271400' && piped.body === 'Good morning');
    const spaced = parseNewArgs('2026-11-22 09:30 916033271400 Good morning');
    check('space syntax parsed', spaced.when === '2026-11-22 09:30' && spaced.target === '916033271400' && spaced.body === 'Good morning');
    const short = parseNewArgs('+2h 916033271400 hi');
    check('relative syntax parsed', short.when === '+2h' && short.body === 'hi');

    const statusPiped = parseStatusArgs('2026-11-22 09:30 | My status | 916033271400,916033352400');
    check('status text/recipients parsed', statusPiped.when === '2026-11-22 09:30' && statusPiped.body === 'My status' && statusPiped.recipients.includes('916033352400'));
    const statusPlain = parseStatusArgs('20:30 | Just text');
    check('status without recipients parsed', statusPlain.when === '20:30' && statusPlain.body === 'Just text' && statusPlain.recipients === '');
    const statusSpaced = parseStatusArgs('2026-11-22 09:30 My status');
    check('status space syntax parsed', statusSpaced.when === '2026-11-22 09:30' && statusSpaced.body === 'My status');
}

function testMedia() {
    console.log('\nMedia validation');
    fs.mkdirSync(scheduler.MEDIA_ROOT, { recursive: true });
    const file = path.join(scheduler.MEDIA_ROOT, 'test-image.png');
    const videoFile = path.join(scheduler.MEDIA_ROOT, 'test-video.mp4');
    const docFile = path.join(scheduler.MEDIA_ROOT, 'test-doc.pdf');
    try {
        fs.writeFileSync(file, Buffer.from('89504e470d0a1a0a', 'hex'));
        fs.writeFileSync(videoFile, Buffer.from('00000018667479706d703432', 'hex'));
        fs.writeFileSync(docFile, Buffer.from('%PDF-1.4', 'utf8'));

        const ok = scheduler.validateMedia('test-image.png', 'image', 'image/png');
        check('valid image accepted', ok.ok === true && ok.size === 8);
        check('wrong mime rejected', scheduler.validateMedia('test-image.png', 'image', 'text/html').ok === false);

        const imageContent = scheduler.buildContent({ mediaType: 'image', mediaPath: 'test-image.png', mediaMime: 'image/png', body: 'Good morning 🌸' });
        check('image scheduled with caption', Buffer.isBuffer(imageContent.image) && imageContent.caption === 'Good morning 🌸');

        const videoContent = scheduler.buildContent({ mediaType: 'video', mediaPath: 'test-video.mp4', mediaMime: 'video/mp4', body: 'watch this' });
        check('video scheduled with caption', Buffer.isBuffer(videoContent.video) && videoContent.caption === 'watch this');

        const docContent = scheduler.buildContent({ mediaType: 'document', mediaPath: 'test-doc.pdf', mediaMime: 'application/pdf', body: 'notes' });
        check('document scheduled with file name', Buffer.isBuffer(docContent.document) && docContent.fileName === 'test-doc.pdf' && docContent.caption === 'notes');

        let textOnly = null;
        try {
            scheduler.buildContent({ mediaType: 'none', body: '' });
        } catch (error) {
            textOnly = error.message;
        }
        check('empty schedule rejected', /Nothing to send/.test(textOnly || ''));

        const traversal = (() => {
            try {
                scheduler.resolveMediaPath('../../index.js');
                return false;
            } catch (error) {
                return true;
            }
        })();
        check('path traversal blocked', traversal);
    } finally {
        for (const temp of [file, videoFile, docFile]) {
            try {
                fs.unlinkSync(temp);
            } catch (error) {
                // already gone
            }
        }
        try {
            fs.rmdirSync(scheduler.MEDIA_ROOT);
        } catch (error) {
            // not empty or already gone
        }
    }
}

async function testOwnerOnly() {
    console.log('\nOwner-only commands');
    // The real owner check loads settings/dotenv (not installed here); stub only
    // that module so the permission branch can be exercised offline.
    const Module = require('module');
    const originalLoad = Module._load;
    Module._load = function patchedLoad(request, parent, isMain) {
        if (request === '../lib/isOwner' || request.endsWith('/lib/isOwner') || request.endsWith('/lib/isOwner.js')) {
            return async () => false;
        }
        return originalLoad.call(this, request, parent, isMain);
    };
    const sent = [];
    let denied = false;
    const sock = {
        sendMessage: async (chatId, content) => {
            sent.push(content.text || '');
            return {};
        }
    };
    const message = {
        key: { remoteJid: '911111111111@s.whatsapp.net', participant: '911111111111@s.whatsapp.net', fromMe: false, id: 'm1' },
        message: { conversation: '.schedule list' }
    };
    const { handleSchedule } = require('../commands/schedule');

    try {
        await handleSchedule(sock, message.key.remoteJid, message);
        denied = sent.some((text) => /Only the bot owner/.test(text));
    } catch (error) {
        denied = false;
    }
    check('stranger cannot list schedules', denied, sent.join(' | '));

    const { dbStatusCommand, aiStatusCommand } = require('../commands/dbstatus');
    const ownerSent = [];
    const ownerSock = { sendMessage: async (chatId, content) => { ownerSent.push(content.text || ''); return {}; } };
    const ownerMessage = { key: { remoteJid: '911111111111@s.whatsapp.net', fromMe: false, id: 'm2' }, message: { conversation: '.dbstatus' } };
    await dbStatusCommand(ownerSock, ownerMessage.key.remoteJid, ownerMessage);
    check('stranger cannot read DB status', ownerSent.some((text) => /Owner only/.test(text)), ownerSent.join(' | '));
    ownerSent.length = 0;
    await aiStatusCommand(ownerSock, ownerMessage.key.remoteJid, ownerMessage);
    check('stranger cannot read AI status', ownerSent.some((text) => /Owner only/.test(text)));
    Module._load = originalLoad;
}

async function main() {
    console.log('Lily MD — MySQL, memory and scheduling tests');
    await testMigrations();
    await testSecurity();
    await testMemory();
    await testScheduleQueue();
    await testScheduler();
    testTimeAndParsing();
    testMedia();
    await testOwnerOnly();

    db.__resetForTests();
    for (const [key, value] of Object.entries(ORIGINAL_DB_ENV)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    console.log(`\nDatabase & scheduling: ${passed} passed, ${failed} failed`);
    if (failed) process.exitCode = 1;
}

main().catch((error) => {
    console.error('Test run crashed:', error);
    process.exitCode = 1;
});
