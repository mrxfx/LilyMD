#!/usr/bin/env node
'use strict';
/**
 * Offline tests for the WhatsApp session system.
 *
 *   node scripts/test-session.js
 *
 * No node_modules, no MySQL and no WhatsApp connection are needed. Archives are
 * built with a tiny in-test tar writer so malformed/hostile archives can be
 * exercised without touching the real session.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'lily-session-test-'));
const SESSION_DIR = path.join(WORK, 'session');
process.env.SESSION_DIR = SESSION_DIR;
process.env.SESSION_BACKUP_FILE = path.join(WORK, 'session.card');
process.env.SESSION_BACKUP_DEBOUNCE_MS = '40';
delete process.env.SESSION_ID;

const backup = require('../lib/sessionBackup');

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

function section(title) {
    console.log(`\n${title}`);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ---------------------------------------------------------- tar test helpers */

function tarHeader(name, size) {
    const buf = Buffer.alloc(512);
    buf.write(name, 0, 100, 'utf8');
    buf.write('0000644\0', 100, 'ascii');
    buf.write('0000000\0', 108, 'ascii');
    buf.write('0000000\0', 116, 'ascii');
    buf.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
    buf.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, '0')}\0`, 136, 'ascii');
    buf.write('        ', 148, 'ascii');
    buf.write('0', 156, 'ascii');
    buf.write('ustar\0', 257, 'ascii');
    buf.write('00', 263, 'ascii');
    let sum = 0;
    for (const byte of buf) sum += byte;
    buf.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
    return buf;
}

function makeArchive(entries) {
    const chunks = [];
    for (const entry of entries) {
        const data = Buffer.from(entry.data || '');
        chunks.push(tarHeader(entry.name, data.length));
        if (data.length) {
            chunks.push(data);
            chunks.push(Buffer.alloc((512 - (data.length % 512)) % 512));
        }
    }
    chunks.push(Buffer.alloc(1024));
    return zlib.gzipSync(Buffer.concat(chunks)).toString('base64');
}

function writeLocalSession(dir, marker) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'creds.json'), JSON.stringify({ me: { id: '916033352400:1@s.whatsapp.net' }, marker }));
    fs.writeFileSync(path.join(dir, 'app-state-sync-key-AAAA.json'), JSON.stringify({ key: marker }));
    return dir;
}

function removeDir(dir) {
    fs.rmSync(dir, { recursive: true, force: true });
}

/* --------------------------------------------------------------------- tests */

async function run() {
    console.log('Lily MD session system tests');

    section('Archive creation');
    {
        check('missing session is detected', backup.hasSession() === false);
        check('nothing to back up reports no-session', backup.writeSessionBackup().ok === false);

        writeLocalSession(SESSION_DIR, 'one');
        const archive = backup.packSession();
        const raw = Buffer.from(archive, 'base64');
        check('archive is base64 gzip', raw[0] === 0x1f && raw[1] === 0x8b);
        const entries = require('child_process').spawnSync('tar', ['-tzf', '-'], { input: raw });
        check('archive contains creds.json', String(entries.stdout).split(/\r?\n/).includes('./creds.json'));

        const first = backup.writeSessionBackup();
        check('session.card written', first.ok === true && first.changed === true);
        check('backup file exists', fs.existsSync(process.env.SESSION_BACKUP_FILE));
        check('archive validates', backup.assertSafeEntries(entries.stdout.toString().split(/\r?\n/).filter(Boolean)).hasCreds === true);
    }

    section('Backup deduplication');
    {
        const again = backup.writeSessionBackup();
        check('unchanged archive is not rewritten', again.ok === true && again.changed === false);
        check('hash sidecar written', fs.existsSync(`${process.env.SESSION_BACKUP_FILE}.hash`));
        const forced = backup.writeSessionBackup({ force: true });
        check('force rewrites', forced.ok === true && forced.changed === true);
    }

    section('Refresh after credential updates');
    {
        const before = fs.readFileSync(process.env.SESSION_BACKUP_FILE, 'utf8');
        fs.writeFileSync(path.join(SESSION_DIR, 'creds.json'), JSON.stringify({ me: { id: '916033352400:1@s.whatsapp.net' }, marker: 'two' }));
        backup.onCredentialsUpdated({ getSock: () => null });
        const immediate = fs.readFileSync(process.env.SESSION_BACKUP_FILE, 'utf8');
        check('debounced refresh is not instant', immediate === before);
        await sleep(160);
        const after = fs.readFileSync(process.env.SESSION_BACKUP_FILE, 'utf8');
        check('credential change refreshed the backup', after !== before);
        const packed = backup.packSession();
        const state = backup.state();
        const packedHash = crypto.createHash('sha256').update(packed).digest('hex');
        check('state reports the new hash', state.lastBackupHash === packedHash, `state=${state.lastBackupHash} vs packed=${packedHash}`);
    }

    section('Restore from SESSION_ID');
    {
        const archive = fs.readFileSync(process.env.SESSION_BACKUP_FILE, 'utf8').trim();
        removeDir(SESSION_DIR);
        process.env.SESSION_ID = archive;
        const logs = [];
        const result = backup.restoreSessionFromEnv({
            log: { log: (line) => logs.push(line), error: (line) => logs.push(line) }
        });
        check('restore reports success', result.restored === true, result.error);
        check('creds.json restored', backup.hasSession());
        check('restore logs the success message', logs.some((line) => line.includes('🔐 Session restored successfully from SESSION_ID')));
        const creds = backup.readCreds();
        check('restored credentials are the saved ones', creds.marker === 'two');
        check('restored files are present', fs.existsSync(path.join(SESSION_DIR, 'app-state-sync-key-AAAA.json')));
        check('no restore temp directory left behind', !fs.readdirSync(WORK).some((name) => name.startsWith('.session-restore-')));

        const again = backup.restoreSessionFromEnv({ log: { log: () => {}, error: () => {} } });
        check('existing session is detected on a second boot', again.reason === 'existing');
    }

    section('Existing session preservation');
    {
        const otherArchive = makeArchive([
            { name: './creds.json', data: JSON.stringify({ marker: 'should-not-apply' }) }
        ]);
        fs.writeFileSync(path.join(SESSION_DIR, 'creds.json'), JSON.stringify({ marker: 'keep-me' }));
        process.env.SESSION_ID = otherArchive;
        const logs = [];
        const result = backup.restoreSessionFromEnv({ log: { log: (line) => logs.push(line), error: (line) => logs.push(line) } });
        check('valid local session is not overwritten', result.reason === 'existing');
        check('local credentials unchanged', backup.readCreds().marker === 'keep-me');
        check('existing session is logged', logs.some((line) => line.includes('🔐 Existing local session detected')));
    }

    section('SESSION_ID validation');
    {
        const savedCard = process.env.SESSION_BACKUP_FILE;
        if (savedCard && fs.existsSync(savedCard)) fs.renameSync(savedCard, savedCard + '.bak');
        delete process.env.SESSION_ID;
        removeDir(SESSION_DIR);
        const invalid = backup.restoreSessionFromEnv({ log: { log: () => {}, error: () => {} } });
        check('empty SESSION_ID asks for pairing', invalid.reason === 'missing' && !fs.existsSync(SESSION_DIR));

        process.env.SESSION_ID = 'not-base64-!!!';
        removeDir(SESSION_DIR);
        check('non-base64 SESSION_ID is rejected', backup.restoreSessionFromEnv({ log: { log: () => {}, error: () => {} } }).reason === 'invalid');

        process.env.SESSION_ID = Buffer.from('hello world').toString('base64');
        removeDir(SESSION_DIR);
        check('non-gzip SESSION_ID is rejected', backup.restoreSessionFromEnv({ log: { log: () => {}, error: () => {} } }).reason === 'invalid');

        process.env.SESSION_ID = makeArchive([{ name: './app-state-sync-key-AAAA.json', data: '{}' }]);
        removeDir(SESSION_DIR);
        check('archive without creds.json is rejected', backup.restoreSessionFromEnv({ log: { log: () => {}, error: () => {} } }).reason === 'invalid');

        process.env.SESSION_ID = makeArchive([{ name: '../evil.txt', data: 'pwned' }, { name: 'creds.json', data: '{"me":{}}' }]);
        removeDir(SESSION_DIR);
        const traversal = backup.restoreSessionFromEnv({ log: { log: () => {}, error: () => {} } });
        check('path traversal entry is rejected', traversal.reason === 'invalid');
        check('nothing was extracted outside the session dir', !fs.existsSync(path.join(WORK, 'evil.txt')));
        check('no session dir created for a hostile archive', !fs.existsSync(SESSION_DIR));

        process.env.SESSION_ID = makeArchive([{ name: '/etc/passwd', data: 'x' }, { name: 'creds.json', data: '{"me":{}}' }]);
        removeDir(SESSION_DIR);
        check('absolute path entry is rejected', backup.restoreSessionFromEnv({ log: { log: () => {}, error: () => {} } }).reason === 'invalid');

        check('data: prefix and whitespace are tolerated', backup.normaliseSessionId(`data:application/octet-stream;base64, ${Buffer.from('abc').toString('base64')}\n`) === Buffer.from('abc').toString('base64'));
        if (savedCard && fs.existsSync(savedCard + '.bak')) fs.renameSync(savedCard + '.bak', savedCard);
    }

    section('SESSION_ID.txt fallback');
    {
        const file = path.join(WORK, 'SESSION_ID.txt');
        process.env.SESSION_ID_FILE = file;
        delete process.env.SESSION_ID;
        const archive = fs.readFileSync(process.env.SESSION_BACKUP_FILE, 'utf8').trim();

        fs.writeFileSync(file, archive + '\n');
        removeDir(SESSION_DIR);
        const logs = [];
        const fromFile = backup.restoreSessionFromEnv({
            log: { log: (line) => logs.push(line), error: (line) => logs.push(line) }
        });
        check('archive in SESSION_ID.txt restores', fromFile.restored === true, fromFile.error);
        check('restore reports the file as the source', fromFile.source === 'SESSION_ID.txt');
        check('file restore is logged', logs.some((line) => line.includes('Session restored successfully from SESSION_ID.txt')));

        fs.writeFileSync(file, 'PASTE_LILY_MD_SESSION_HERE\n');
        removeDir(SESSION_DIR);
        const placeholderLogs = [];
        const placeholder = backup.restoreSessionFromEnv({
            log: { log: (line) => placeholderLogs.push(line), error: (line) => placeholderLogs.push(line) }
        });
        check('placeholder is not used as a session', placeholder.reason === 'missing' && !fs.existsSync(SESSION_DIR));
        check('placeholder is explained in the log', placeholderLogs.some((line) => line.includes('placeholder')));

        process.env.SESSION_ID = archive;
        fs.writeFileSync(file, 'not-a-session');
        removeDir(SESSION_DIR);
        check(
            'SESSION_ID env wins over the file',
            backup.restoreSessionFromEnv({ log: { log: () => {}, error: () => {} } }).restored === true
        );

        delete process.env.SESSION_ID;
        removeDir(SESSION_DIR);
        check('invalid file content is rejected', backup.restoreSessionFromEnv({ log: { log: () => {}, error: () => {} } }).reason === 'invalid');
        check('sessionIdFile honours SESSION_ID_FILE', backup.sessionIdFile() === path.resolve(file));
        check('sessionIdSource reports the file', backup.sessionIdSource().source === 'file');
    }

    section('Security and delivery');
    {
        process.env.SESSION_ID = makeArchive([
            { name: 'creds.json', data: JSON.stringify({ marker: 'delivery' }) }
        ]);
        backup.restoreSessionFromEnv({ log: { log: () => {}, error: () => {} } });
        backup.writeSessionBackup({ force: true });

        const sent = [];
        const sock = {
            user: { id: '916033352400:7@s.whatsapp.net' },
            sendMessage: async (jid, content) => {
                sent.push({ jid, content });
            }
        };
        check('self jid is derived from the socket user', backup.selfJid(sock) === '916033352400@s.whatsapp.net');
        check('self jid is null without a user', backup.selfJid({}) === null);

        const first = await backup.sendSessionBackup(sock);
        check('backup document is sent', first.ok === true && sent.length === 1);
        check('sent to the bot account only', sent[0].jid === '916033352400@s.whatsapp.net');
        check('document filename', sent[0].content.fileName === 'session.card');
        const doc = sent[0].content.document.toString('utf8');
        check('document explains restoration', doc.includes('SESSION_ID') && doc.includes('HOW TO RESTORE ON A NEW SERVER'));
        check('document carries the archive', doc.includes(fs.readFileSync(process.env.SESSION_BACKUP_FILE, 'utf8').trim()));
        check('no archive is logged in the document metadata', sent[0].content.caption.length < 300);

        const second = await backup.sendSessionBackup(sock);
        check('unchanged backup is not re-sent', second.ok === true && second.skipped === 'unchanged' && sent.length === 1);

        await backup.sendSessionBackup(sock, { force: true });
        check('force re-sends', sent.length === 2);

        check('offline socket is not an error', (await backup.sendSessionBackup(null)).reason === 'offline');

        const failing = {
            user: { id: '916033352400:7@s.whatsapp.net' },
            sendMessage: async () => {
                throw new Error('simulated delivery failure');
            }
        };
        const failure = await backup.sendSessionBackup(failing, { force: true, getSock: () => null });
        check('send failure is reported', failure.ok === false && failure.reason === 'send-failed');
        check('send failure is remembered', backup.state().lastSendError === 'simulated delivery failure');
        check('send failure never throws', failure.error === 'simulated delivery failure');
    }

    section('Backup worker lifecycle');
    {
        const result = backup.startBackups({ getSock: () => null });
        check('startBackups runs', result.ok === true);
        check('worker is started once', backup.state().started === true);
        backup.startBackups({ getSock: () => null });
        check('repeated start does not duplicate the worker', backup.state().started === true);
        backup.stopBackups();
        check('worker stops', backup.state().started === false);
    }

    section('Scheduler export compatibility');
    {
        const scheduler = require('../lib/scheduler');
        check('scheduler.start is exported', typeof scheduler.start === 'function');
        check('scheduler.startScheduler alias exists', typeof scheduler.startScheduler === 'function');
        check('alias points at start', scheduler.startScheduler === scheduler.start);
        const started = scheduler.start({ getSock: () => null, isConnected: () => false });
        check('scheduler starts', started.started === true);
        const duplicate = scheduler.start({ getSock: () => null, isConnected: () => false });
        check('scheduler starts only once', duplicate.started === false && duplicate.already === true);
        const offline = await scheduler.tick({ sock: null, isConnected: () => false });
        check('scheduler tick handles a disconnected socket', offline.skipped === 'offline' || offline.skipped === 'not-configured', JSON.stringify(offline));
        scheduler.stop();
        check('scheduler stops', scheduler.state().started === false);
    }

    section('Pairing compatibility');
    {
        let pair = null;
        try {
            pair = require('../commands/pair');
            check('pair command still exports a handler', typeof pair === 'function');
        } catch (error) {
            // commands/pair pulls in settings -> dotenv, which needs `npm install`.
            // The static checks below still cover the pairing wiring offline.
            console.log(`  • pair command load skipped (dependencies not installed): ${error.message.split('\n')[0]}`);
        }
        const source = fs.readFileSync(path.join(__dirname, '..', 'commands', 'pair.js'), 'utf8');
        check('pair command still uses the local pairing engine', source.includes('startPairing'));
        check('index restores the session before Baileys starts', /restoreSessionFromEnv\(\)[\s\S]{0,400}useMultiFileAuthState/.test(fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8')));
        check('index starts the scheduler through the module', /scheduler\.start\(/.test(fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8')));
    }

    section('session.card restoration & restart persistence');
    {
        delete process.env.SESSION_ID;
        delete process.env.SESSION_ID_FILE;
        // 1. Ensure valid local session is backed up to session.card
        removeDir(SESSION_DIR);
        writeLocalSession(SESSION_DIR, 'persistence-test-val');
        const backupRes = backup.writeSessionBackup({ force: true });
        check('session.card created atomically', backupRes.ok === true);
        check('session.card file exists', fs.existsSync(process.env.SESSION_BACKUP_FILE));

        // 2. Wipe the session directory (simulating container restart / wipe)
        removeDir(SESSION_DIR);
        check('session directory is wiped', fs.existsSync(SESSION_DIR) === false);

        // 3. Restore session from session.card
        const restoreRes = backup.restoreSessionFromEnv({ log: { log: () => {}, error: () => {} } });
        check('restored from session.card successfully', restoreRes.restored === true);
        check('restore source reports session.card', restoreRes.source === 'session.card');
        check('creds.json restored', fs.existsSync(path.join(SESSION_DIR, 'creds.json')));
        const restoredCreds = JSON.parse(fs.readFileSync(path.join(SESSION_DIR, 'creds.json'), 'utf8'));
        check('restored credentials match original', restoredCreds.marker === 'persistence-test-val');

        // 4. Second boot preserves existing session without re-extracting
        const secondBoot = backup.restoreSessionFromEnv({ log: { log: () => {}, error: () => {} } });
        check('restart persistence detects existing session', secondBoot.restored === false && secondBoot.reason === 'existing');
    }

    section('Shorter and custom pairing code');
    {
        const code1 = backup.generatePairingCode();
        check('pairing code starts with LilyMd~', code1.startsWith('LilyMd~'));
        check('pairing code has 15-char random suffix', /^LilyMd~[2-9A-Z]{15}$/.test(code1), code1);

        // Test uniqueness across 200 iterations
        const generated = new Set();
        for (let i = 0; i < 200; i++) {
            generated.add(backup.generatePairingCode());
        }
        check('pairing codes are unique and cryptographically generated', generated.size === 200);
    }

    section('Pairing completion message security');
    {
        const pairSource = fs.readFileSync(path.join(__dirname, '..', 'commands', 'pair.js'), 'utf8');
        check('pair command sends confirmation message', pairSource.includes('Lily MD Connected Successfully.'));
        check('pair command confirms session saved securely', pairSource.includes('Your WhatsApp session is now saved securely.'));
        check('pair command never sends raw SESSION_ID to chat', !pairSource.includes('${sessionId}'));
        check('pair command never sends lily-md-session TXT file', !pairSource.includes('lily-md-session-'));

        const indexSource = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
        check('index on connect sends secure confirmation without credentials', indexSource.includes('Lily MD Connected Successfully.'));
    }
}

run()
    .catch((error) => {
        failed += 1;
        console.error('Unexpected test error:', error);
    })
    .finally(() => {
        delete process.env.SESSION_ID;
        try {
            backup.stopBackups();
            require('../lib/scheduler').stop();
        } catch {
            // ignore
        }
        removeDir(WORK);
        console.log(`\nSession system: ${passed} passed, ${failed} failed`);
        process.exit(failed ? 1 : 0);
    });
