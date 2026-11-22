'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const backup = require('../lib/sessionBackup');
const { isSessionRef, generateSessionId } = backup;

const WORK = path.join(__dirname, '.test-reconnect-work');
const TEST_SESSION_DIR = path.join(WORK, 'session');
const TEST_CARD_FILE = path.join(WORK, 'session.card');

let pass = 0;
let fail = 0;

function check(desc, cond, extra) {
    if (cond) {
        pass++;
        console.log(`  ✓ ${desc}`);
    } else {
        fail++;
        console.error(`  ✗ ${desc}${extra ? ` (${extra})` : ''}`);
    }
}

function removeDir(dir) {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
}

function writeMockCreds(dir, registered = true) {
    fs.mkdirSync(dir, { recursive: true });
    const creds = {
        registered: registered === true,
        me: registered ? { id: '916033352400:1@s.whatsapp.net' } : undefined,
        myAppStateKeyId: 'test-app-state-key'
    };
    fs.writeFileSync(path.join(dir, 'creds.json'), JSON.stringify(creds, null, 2));
    fs.writeFileSync(path.join(dir, 'app-state-sync-key-1.json'), JSON.stringify({ key: 'test' }));
    return dir;
}

async function run() {
    console.log('Testing Lily MD Session-Card & Auto-Reconnect Architecture:\n');

    removeDir(WORK);
    fs.mkdirSync(WORK, { recursive: true });

    process.env.SESSION_DIR = TEST_SESSION_DIR;
    process.env.SESSION_BACKUP_FILE = TEST_CARD_FILE;
    delete process.env.SESSION_ID;
    delete process.env.SESSION_ID_FILE;

    // -------------------------------------------------------------
    // 1. Session Card Format Validation (LilyMD~ + exactly 15 chars)
    // -------------------------------------------------------------
    console.log('1. Session Card Format & Generation:');
    const genCode = generateSessionId();
    check('Generated session card starts with LilyMD~', genCode.startsWith('LilyMD~'));
    check('Session card random part has exactly 15 characters', genCode.slice(7).length === 15);
    check('isSessionRef validates 15-char code', isSessionRef(genCode));
    check('isSessionRef rejects too short code', !isSessionRef('LilyMD~SHORT'));
    check('isSessionRef rejects too long code', !isSessionRef('LilyMD~1234567890123456'));
    check('isSessionRef rejects without prefix', !isSessionRef('OTHER~123456789012345'));

    // -------------------------------------------------------------
    // 2. Removal of 6-hour Periodic Card Sender
    // -------------------------------------------------------------
    console.log('\n2. Removal of Periodic 6-hour Card Sender:');
    writeMockCreds(TEST_SESSION_DIR, true);
    const workerResult = backup.startBackups({ getSock: () => null });
    check('startBackups initializes without error', workerResult.ok === true);
    check('backup worker state reports intervalMs = 0 (periodic send disabled)', backup.state().intervalMs === 0);
    backup.stopBackups();

    // -------------------------------------------------------------
    // 3. Fresh Pair Sends Exactly ONE Card
    // -------------------------------------------------------------
    console.log('\n3. Fresh Pair Sends Card Only Once:');
    const sentMessages = [];
    const mockSock = {
        user: { id: '916033352400:1@s.whatsapp.net' },
        sendMessage: async (jid, content) => {
            sentMessages.push({ jid, content });
            return { key: { id: 'mock-id' } };
        }
    };

    const freshPairCode = backup.generatePairingCode();
    // Simulate server-based fresh pair delivery
    const delivery = await backup.deliverPairingSuccess(mockSock, '916033352400', {
        customCode: freshPairCode,
        platform: 'Linux'
    });

    check('deliverPairingSuccess returns delivered = true on fresh pairing', delivery.ok === true && delivery.delivered === true);
    const docMessages = sentMessages.filter(m => m.content && m.content.document);
    check('Fresh pair sent exactly ONE session card document', docMessages.length === 1);
    check('Session card content matches format LilyMD~XXXXXXXXXXXXXXX', isSessionRef(docMessages[0].content.document.toString('utf8')));

    // Re-call deliverPairingSuccess with same session ref (e.g. repeated connection or reconnect)
    const duplicateDelivery = await backup.deliverPairingSuccess(mockSock, '916033352400', {
        customCode: freshPairCode,
        platform: 'Linux'
    });
    check('Duplicate delivery call was skipped (already-delivered)', duplicateDelivery.skipped === 'already-delivered');
    check('Total session card documents sent remains exactly 1', sentMessages.filter(m => m.content && m.content.document).length === 1);

    // -------------------------------------------------------------
    // 4. Reconnect / Credential Update Sends NO Card
    // -------------------------------------------------------------
    console.log('\n4. Reconnect & Credentials Update Sends NO Card:');
    const preCount = sentMessages.length;

    // Simulate startBackups on reconnect
    backup.startBackups({ getSock: () => mockSock });
    check('startBackups on reconnect sends 0 additional WhatsApp messages', sentMessages.length === preCount);

    // Simulate onCredentialsUpdated
    backup.onCredentialsUpdated({ getSock: () => mockSock });
    // Wait for debounce
    await new Promise(r => setTimeout(r, 60));
    check('onCredentialsUpdated sends 0 additional WhatsApp messages', sentMessages.length === preCount);
    backup.stopBackups();

    // -------------------------------------------------------------
    // 5. Restart with Valid Saved Session Auto-Connects
    // -------------------------------------------------------------
    console.log('\n5. Restart & Persistence Behavior:');

    // Case A: Restart with existing ./session
    writeMockCreds(TEST_SESSION_DIR, true);
    const existingRestore = backup.restoreSessionFromEnv();
    check('Restart with valid ./session detects existing session', existingRestore.reason === 'existing' && existingRestore.restored === false);
    check('hasSession is true for existing valid session', backup.hasSession(TEST_SESSION_DIR) === true);

    // Case B: Restart on fresh host with session.card (wiped ./session)
    backup.writeSessionBackup({ dir: TEST_SESSION_DIR, force: true, customCode: freshPairCode });
    check('session.card was written to disk', fs.existsSync(TEST_CARD_FILE));
    const cardContent = fs.readFileSync(TEST_CARD_FILE, 'utf8').trim();
    check('session.card contains 15-char session ref', isSessionRef(cardContent));

    // Wipe ./session completely to simulate fresh deployment/container reboot
    removeDir(TEST_SESSION_DIR);
    check('./session is wiped', !fs.existsSync(TEST_SESSION_DIR));

    // Restore from session.card
    const restored = backup.restoreSessionFromEnv();
    check('restoreSessionFromEnv successfully restored from session.card', restored.restored === true);
    check('./session/creds.json is now present and registered', backup.hasSession(TEST_SESSION_DIR) === true);

    // Case C: Restart with missing or corrupt session
    removeDir(TEST_SESSION_DIR);
    fs.rmSync(TEST_CARD_FILE, { force: true });
    delete process.env.SESSION_ID;
    const missingRestore = backup.restoreSessionFromEnv();
    check('Missing session reports missing and requires normal pairing flow', missingRestore.restored === false && missingRestore.reason === 'missing');

    // Case D: Invalid session format
    fs.writeFileSync(TEST_CARD_FILE, 'LilyMD~INVALID_NOT_MAPPED_TO_ARCHIVE');
    const invalidRestore = backup.restoreSessionFromEnv();
    check('Unmapped/invalid session card is rejected and requires normal pairing flow', invalidRestore.restored === false && invalidRestore.reason === 'invalid');

    // -------------------------------------------------------------
    // 6. Uniformity Between Server and Website Pairing
    // -------------------------------------------------------------
    console.log('\n6. Server and Website Pairing Uniformity:');
    const serverCap = backup.buildPairingSuccessCaption({ number: '916033352400', platform: 'Linux', tempPassword: 'test-pass-1' });
    const webCap = backup.buildPairingSuccessCaption({ number: '916033352400', platform: 'Render', tempPassword: 'test-pass-1' });

    check('Both captions contain LILY MD header', serverCap.includes('〔 LILY MD 〕') && webCap.includes('〔 LILY MD 〕'));
    check('Both captions contain PAIRING SUCCESSFUL', serverCap.includes('PAIRING SUCCESSFUL') && webCap.includes('PAIRING SUCCESSFUL'));
    check('Both captions contain Dashboard Password', serverCap.includes('test-pass-1') && webCap.includes('test-pass-1'));
    check('Platform difference is respected (Linux vs Render)', serverCap.includes('Linux') && webCap.includes('Render'));

    // Cleanup
    removeDir(WORK);

    console.log(`\nResults: ${pass} passed, ${fail} failed`);
    if (fail > 0) process.exit(1);
}

run().catch((err) => {
    console.error('Test run error:', err);
    process.exit(1);
});
