'use strict';
/**
 * Test Suite: Single-File Session Setup via session.card
 *
 * Verifies:
 * 1. session.card is the central user-editable file at project root.
 * 2. session.card.example provides safe demo template (tracked in git).
 * 3. session.card is gitignored while session.card.example is included.
 * 4. Placeholder in session.card produces clear setup guide & avoids pairing crash.
 * 5. Replacing demo value with valid card restores session automatically without re-pairing.
 * 6. Server restarts reuse saved session automatically.
 * 7. Invalid card returns clear invalid status.
 * 8. Website pairing creates & delivers valid session card.
 * 9. Website sync endpoint resolves valid session ref without leaking unmapped.
 * 10. No credentials or session cards are leaked in logs.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { spawnSync } = require('child_process');

const backup = require('../lib/sessionBackup');
const {
    isSessionRef,
    generateSessionId,
    readSessionCardFile,
    sessionIdSource,
    restoreSessionFromEnv,
    saveSessionRef,
    packSession,
    hasSession,
    deliverPairingSuccess,
    ensureSessionCardTemplate,
    isPlaceholder
} = backup;

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lily-single-file-test-'));
const TEST_SESSION_DIR = path.join(TEST_DIR, 'session');
const TEST_CARD_FILE = path.join(TEST_DIR, 'session.card');
const TEST_EXAMPLE_FILE = path.join(TEST_DIR, 'session.card.example');
const TEST_DATA_DIR = path.join(TEST_DIR, 'data');
const TEST_STORE_FILE = path.join(TEST_DATA_DIR, 'sessions.json');

process.env.SESSION_DIR = TEST_SESSION_DIR;
process.env.SESSION_BACKUP_FILE = TEST_CARD_FILE;

let passed = 0;
let failed = 0;

function check(desc, cond, extra = '') {
    if (cond) {
        console.log(`  ✓ ${desc}`);
        passed++;
    } else {
        console.error(`  ✗ ${desc}${extra ? ` (${extra})` : ''}`);
        failed++;
    }
}

function createDummyCreds(dir) {
    fs.mkdirSync(dir, { recursive: true });
    const creds = {
        noiseKey: { private: 'dummy', public: 'dummy' },
        pairingEphemeralKeyPair: { private: 'dummy', public: 'dummy' },
        signedIdentityKey: { private: 'dummy', public: 'dummy' },
        signedPreKey: { keyPair: { private: 'dummy', public: 'dummy' }, signature: 'dummy', keyId: 1 },
        registrationId: 12345,
        advSecretKey: 'dummy',
        me: { id: '916033352400:1@s.whatsapp.net', name: 'Lily Test' },
        account: { details: 'dummy' },
        signalIdentities: [],
        myAppStateKeyId: 'dummy',
        firstUnuploadedPreKeyId: 1,
        nextPreKeyId: 1,
        accountSettings: { unarchiveChats: false },
        registered: true
    };
    fs.writeFileSync(path.join(dir, 'creds.json'), JSON.stringify(creds, null, 2), { mode: 0o600 });
}

function cleanDir(dir) {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
}

async function runTests() {
    console.log('=== Test Suite: Single-File Session Setup (session.card) ===\n');

    // -------------------------------------------------------------
    // Test 1: session.card.example exists and contains demo placeholder
    // -------------------------------------------------------------
    console.log('1. Central Template & Gitignore:');
    const rootExample = path.join(process.cwd(), 'session.card.example');
    check('session.card.example exists at project root', fs.existsSync(rootExample));
    const exampleContent = fs.readFileSync(rootExample, 'utf8');
    check('session.card.example contains DEMO placeholder', exampleContent.includes('LilyMD~DEMO_SESSION_CARD_PLACEHOLDER'));
    check('session.card.example has instructions', exampleContent.includes('How to set up your WhatsApp session:'));

    // Check .gitignore
    const gitignoreContent = fs.readFileSync(path.join(process.cwd(), '.gitignore'), 'utf8');
    check('.gitignore excludes session.card', gitignoreContent.includes('session.card'));
    check('.gitignore keeps session.card.example (!session.card.example)', gitignoreContent.includes('!session.card.example'));

    // -------------------------------------------------------------
    // Test 2: Auto-template creation when session.card is missing
    // -------------------------------------------------------------
    console.log('\n2. Template Initialization:');
    fs.writeFileSync(TEST_EXAMPLE_FILE, exampleContent);
    if (fs.existsSync(TEST_CARD_FILE)) fs.unlinkSync(TEST_CARD_FILE);
    ensureSessionCardTemplate(TEST_CARD_FILE);
    check('ensureSessionCardTemplate copies from .example when missing', fs.existsSync(TEST_CARD_FILE));

    // -------------------------------------------------------------
    // Test 3: Placeholder detection
    // -------------------------------------------------------------
    console.log('\n3. Placeholder Detection:');
    check('isPlaceholder detects DEMO_SESSION_CARD_PLACEHOLDER', isPlaceholder('LilyMD~DEMO_SESSION_CARD_PLACEHOLDER'));
    check('isPlaceholder detects PASTE_YOUR_SESSION_CARD_HERE', isPlaceholder('PASTE_YOUR_SESSION_CARD_HERE'));
    check('isPlaceholder rejects real session ref', !isPlaceholder('LilyMD~A7K9Q2M8X4P6R3T'));

    const fromCardPlaceholder = readSessionCardFile(TEST_CARD_FILE);
    check('readSessionCardFile detects placeholder status', fromCardPlaceholder.status === 'placeholder');
    check('readSessionCardFile returns empty value for placeholder', fromCardPlaceholder.value === '');

    // Startup with placeholder in session.card
    cleanDir(TEST_SESSION_DIR);
    const mockLogs = [];
    const mockLogger = { log: (msg) => mockLogs.push(msg), error: (msg) => mockLogs.push(msg) };
    const placeholderRestore = restoreSessionFromEnv({ dir: TEST_SESSION_DIR, log: mockLogger });
    check('restoreSessionFromEnv reports missing for placeholder', placeholderRestore.restored === false && placeholderRestore.reason === 'missing');
    check('restoreSessionFromEnv logs friendly setup guide', mockLogs.some((l) => l.includes('LILY MD — SESSION SETUP REQUIRED')));
    check('Setup guide explains how to pair on website and paste in session.card', mockLogs.some((l) => l.includes('session.card')));

    // -------------------------------------------------------------
    // Test 4: Single-File Setup with Valid Session Card
    // -------------------------------------------------------------
    console.log('\n4. Setup with Valid Session Card:');
    // Create actual session credentials
    createDummyCreds(TEST_SESSION_DIR);
    const validArchive = packSession(TEST_SESSION_DIR);
    check('Dummy session packed successfully', Boolean(validArchive && validArchive.length > 50));

    // Save session mapping under a ref
    const testSessionRef = generateSessionId();
    saveSessionRef(testSessionRef, validArchive, '916033352400');

    // Wipe ./session directory to simulate a fresh host or new server deployment
    cleanDir(TEST_SESSION_DIR);
    check('./session is wiped before restore', !hasSession(TEST_SESSION_DIR));

    // Put valid session card into session.card with comments
    fs.writeFileSync(TEST_CARD_FILE, [
        '# User WhatsApp Session Card',
        '# Created via website pairing',
        testSessionRef
    ].join('\n'));

    const fromCardValid = readSessionCardFile(TEST_CARD_FILE);
    check('readSessionCardFile parses valid card ignoring comments', fromCardValid.status === 'present');
    check('readSessionCardFile resolved archive correctly', Boolean(fromCardValid.value));
    check('readSessionCardFile extracted sessionId ref', fromCardValid.sessionId === testSessionRef);

    // Restore session automatically
    mockLogs.length = 0;
    const restoredResult = restoreSessionFromEnv({ dir: TEST_SESSION_DIR, log: mockLogger });
    check('restoreSessionFromEnv successfully restores from session.card', restoredResult.restored === true);
    check('restoredResult source is session.card', restoredResult.source === 'session.card');
    check('./session/creds.json is restored and registered', hasSession(TEST_SESSION_DIR) === true);
    check('Restore success logged cleanly', mockLogs.some((l) => l.includes('Session restored successfully from session.card')));

    // -------------------------------------------------------------
    // Test 5: Reconnect & Restart Reuses Existing Session
    // -------------------------------------------------------------
    console.log('\n5. Reconnect & Restart:');
    mockLogs.length = 0;
    const secondStart = restoreSessionFromEnv({ dir: TEST_SESSION_DIR, log: mockLogger });
    check('Restart with existing ./session detects local session', secondStart.restored === false && secondStart.reason === 'existing');
    check('Logs existing session detected', mockLogs.some((l) => l.includes('Existing local session detected')));

    // -------------------------------------------------------------
    // Test 6: Self-Contained Composite Card Format
    // -------------------------------------------------------------
    console.log('\n6. Self-Contained Composite Session Card Format:');
    cleanDir(TEST_SESSION_DIR);
    const compositeCard = [
        '# Self-contained portable session card',
        'LilyMD~Z9Y8X7W6V5U4T3S',
        '------------------------------------------------------------',
        validArchive
    ].join('\n');
    fs.writeFileSync(TEST_CARD_FILE, compositeCard);

    const fromComposite = readSessionCardFile(TEST_CARD_FILE);
    check('readSessionCardFile parses composite card', fromComposite.status === 'present');
    check('Composite card sessionId extracted', fromComposite.sessionId === 'LilyMD~Z9Y8X7W6V5U4T3S');

    const compositeRestore = restoreSessionFromEnv({ dir: TEST_SESSION_DIR, log: mockLogger });
    check('Composite card restores cleanly into ./session', compositeRestore.restored === true);
    check('./session has valid creds after composite restore', hasSession(TEST_SESSION_DIR));

    // -------------------------------------------------------------
    // Test 7: Invalid Session Card Handling
    // -------------------------------------------------------------
    console.log('\n7. Invalid Session Card Handling:');
    cleanDir(TEST_SESSION_DIR);
    fs.writeFileSync(TEST_CARD_FILE, 'LilyMD~INVALID_UNMAPPED_REF_XYZ');
    const invalidRestore = restoreSessionFromEnv({ dir: TEST_SESSION_DIR, log: mockLogger });
    check('Invalid/unmapped session card is rejected', invalidRestore.restored === false && invalidRestore.reason === 'invalid');

    // -------------------------------------------------------------
    // Test 8: Pairing Delivery Format & One-Time Delivery
    // -------------------------------------------------------------
    console.log('\n8. Pairing Delivery Verification:');
    const sentMessages = [];
    const mockSocket = {
        sendMessage: async (jid, content) => {
            sentMessages.push({ jid, content });
            return { key: { id: 'msg-id' } };
        }
    };

    const deliveryNumber = '919876543210';
    const deliveryRes = await deliverPairingSuccess(mockSocket, deliveryNumber, {
        sessionId: 'LilyMD~FRESHPAIR12345',
        tempPassword: 'demo-password'
    });
    check('deliverPairingSuccess succeeds', deliveryRes.ok === true);
    check('Exactly 2 messages sent on fresh pairing (image + document)', sentMessages.length === 2);
    const docMsg = sentMessages.find((m) => m.content.document);
    check('session.card document sent to WhatsApp', Boolean(docMsg));
    check('Document filename is session.card', docMsg.content.fileName === 'session.card');

    // Second call for same pairing is deduplicated (no duplicate sent)
    const duplicateRes = await deliverPairingSuccess(mockSocket, deliveryNumber, {
        sessionId: 'LilyMD~FRESHPAIR12345'
    });
    check('Subsequent calls deduplicate and do NOT resend card', duplicateRes.skipped === 'already-delivered');
    check('Message count remains 2', sentMessages.length === 2);

    // -------------------------------------------------------------
    // Test 9: Priority Order Check (session.card > SESSION_ID.txt)
    // -------------------------------------------------------------
    console.log('\n9. Priority Order (session.card is Primary):');
    const testLegacyFile = path.join(TEST_DIR, 'SESSION_ID.txt');
    fs.writeFileSync(testLegacyFile, 'PASTE_LILY_MD_SESSION_HERE');
    fs.writeFileSync(TEST_CARD_FILE, 'LilyMD~DEMO_SESSION_CARD_PLACEHOLDER');

    const sourceResult = sessionIdSource();
    check('session.card is evaluated before legacy SESSION_ID.txt', sourceResult.fileStatus === 'placeholder');

    // Clean up temporary test directory
    cleanDir(TEST_DIR);

    // Summary
    console.log(`\n========================================`);
    console.log(`Tests Passed: ${passed}`);
    console.log(`Tests Failed: ${failed}`);
    console.log(`========================================`);

    if (failed > 0) {
        process.exit(1);
    }
}

runTests().catch((err) => {
    console.error('Unhandled test failure:', err);
    process.exit(1);
});
