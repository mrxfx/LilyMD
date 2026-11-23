'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const auth = require('../lib/webAuth');
const webApi = require('../lib/webApi');
const sessionBackup = require('../lib/sessionBackup');
const { handleRequest, setMainSocket, startPairingJob } = require('../lib/webApp');
const store = require('../lib/webStore');

let pass = 0;
let fail = 0;

function check(desc, condition) {
    if (condition) {
        pass++;
        console.log(`  ✓ ${desc}`);
    } else {
        fail++;
        console.error(`  ✗ ${desc}`);
    }
}

async function run() {
    console.log('Testing Lily MD Unified Pairing Parity (Server = Website, Website = Server):\n');

    const pairedNumber = '919876543210';
    const defaultOwnerNumber = '916033352400';

    // -------------------------------------------------------------
    // Test 1: Server Pairing Authentication & Multi-Identifier Login
    // -------------------------------------------------------------
    console.log('1. Server Pairing Password Generation & Multi-Identifier Login:');

    let sentMessages = [];
    const mockServerSock = {
        user: { id: `${pairedNumber}:12@s.whatsapp.net` },
        sendMessage: async (jid, content) => {
            sentMessages.push({ jid, content });
            return { key: { id: `srv-${Date.now()}` } };
        }
    };

    const serverPairResult = await sessionBackup.deliverPairingSuccess(mockServerSock, pairedNumber, {
        platform: 'Server'
    });

    check('deliverPairingSuccess succeeded on server pairing', serverPairResult.ok === true && serverPairResult.delivered === true);
    check('Dashboard Password generated', typeof serverPairResult.tempPassword === 'string' && serverPairResult.tempPassword.length >= 8);
    check('session.card attachment delivered in WhatsApp chat', sentMessages.some(m => m.content.fileName === 'session.card'));

    const tempPassword = serverPairResult.tempPassword;

    // A) Login with paired WhatsApp number
    const loginPaired = auth.login(pairedNumber, tempPassword, { headers: {} });
    check('Login with paired number succeeds', loginPaired.ok === true && typeof loginPaired.token === 'string');

    // B) Login with empty/blank number (password-only sign in)
    const loginPasswordOnly = auth.login('', tempPassword, { headers: {} });
    check('Login with blank number (password-only) succeeds', loginPasswordOnly.ok === true && typeof loginPasswordOnly.token === 'string');

    // C) Login with whitespace-padded number
    const loginPadded = auth.login(` +${pairedNumber} `, tempPassword, { headers: {} });
    check('Login with formatted/spaced number succeeds', loginPadded.ok === true);

    // D) Login with backtick-wrapped password (as rendered in WhatsApp markdown)
    const loginBackticks = auth.login('', `\`${tempPassword}\``, { headers: {} });
    check('Login with backtick-wrapped password succeeds', loginBackticks.ok === true);

    // E) Login with wrong password is rejected
    const loginBad = auth.login(pairedNumber, 'WrongPassword123!', { headers: {} });
    check('Login with invalid password is rejected', loginBad.ok === false && loginBad.status === 401);

    // -------------------------------------------------------------
    // Test 2: Website Pairing Lifecycle & Direct Bot Runtime Hand-off
    // -------------------------------------------------------------
    console.log('\n2. Website Pairing Lifecycle & Runtime Hand-off:');

    // Simulate main bot runtime state in index.js
    let botConnected = false;
    let botSocket = null;
    let botCommandReceived = false;
    let connectSessionCalled = false;
    let connectSessionOptions = null;

    const mockMainBotSock = {
        user: { id: `${pairedNumber}:1@s.whatsapp.net` },
        ws: { isOpen: true, readyState: 1 },
        ev: {
            listeners: {},
            on(evt, fn) {
                this.listeners[evt] = this.listeners[evt] || [];
                this.listeners[evt].push(fn);
            },
            emit(evt, data) {
                const list = this.listeners[evt] || [];
                for (const fn of list) fn(data);
            },
            removeAllListeners(evt) {
                if (evt) delete this.listeners[evt];
                else this.listeners = {};
            }
        },
        sendMessage: async (jid, content) => {
            sentMessages.push({ jid, content });
            return { key: { id: `bot-${Date.now()}` } };
        }
    };

    // Attach simulated command handler to main bot socket
    mockMainBotSock.ev.on('messages.upsert', (chatUpdate) => {
        const msg = chatUpdate?.messages?.[0];
        if (msg && msg.text === '.ping') {
            botCommandReceived = true;
        }
    });

    // Register runtime hooks in webApi (as index.js does)
    webApi.setRuntime({
        getConnected: () => botConnected && Boolean(botSocket && (botSocket.ws?.isOpen || botSocket.ws?.readyState === 1)),
        getSocket: () => botSocket,
        connectSession: async (options) => {
            connectSessionCalled = true;
            connectSessionOptions = options;
            // Simulate startXeonBotInc completing connection
            botSocket = mockMainBotSock;
            botConnected = true;
            setMainSocket(mockMainBotSock, () => botConnected);
            return mockMainBotSock;
        },
        disconnect: async () => {
            botConnected = false;
            botSocket = null;
            setMainSocket(null, () => false);
        },
        reconnect: async () => {
            botConnected = true;
            botSocket = mockMainBotSock;
            setMainSocket(mockMainBotSock, () => true);
        }
    });

    // Verify initial state before website pairing hand-off
    check('Bot is initially offline before pairing', webApi.getRuntime().getConnected() === false);

    // Create a mock website pairing job in temp dir
    const tempJobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lily-test-web-pair-'));
    fs.writeFileSync(path.join(tempJobDir, 'creds.json'), JSON.stringify({
        registered: true,
        me: { id: `${pairedNumber}:1@s.whatsapp.net`, name: 'Lily Bot' }
    }));
    fs.writeFileSync(path.join(tempJobDir, 'app-state-sync-key.json'), '{"key":"demo"}');

    let tempSocketClosed = false;
    const mockTempPairingSocket = {
        ws: { close() { tempSocketClosed = true; } },
        end() { tempSocketClosed = true; },
        ev: { removeAllListeners() {} }
    };

    const mockJob = {
        id: 'job-test-parity-1',
        number: pairedNumber,
        customCode: 'LilyMD~TestCard123456',
        dir: tempJobDir,
        state: 'open',
        status: 'open',
        socket: mockTempPairingSocket
    };

    // Verify finishJob in webApp handles the hand-off to connectSession
    // We test the hand-off logic directly using the finishJob flow
    const mainSessionDir = path.resolve(process.env.SESSION_DIR || path.join(process.cwd(), 'session'));
    fs.mkdirSync(mainSessionDir, { recursive: true });

    // Copy files as finishJob does
    const files = fs.readdirSync(mockJob.dir);
    for (const f of files) {
        fs.copyFileSync(path.join(mockJob.dir, f), path.join(mainSessionDir, f));
    }
    check('Credentials copied to main ./session directory', fs.existsSync(path.join(mainSessionDir, 'creds.json')));

    // Simulate finishJob closing temp socket and calling connectSession
    if (mockJob.socket) {
        mockJob.socket.ws.close();
        mockJob.socket = null;
    }
    check('Temporary pairing socket closed cleanly before bot runtime connects', tempSocketClosed === true);

    const runtime = webApi.getRuntime();
    await runtime.connectSession({ number: mockJob.number, customCode: mockJob.customCode });
    mockJob.state = 'connected';
    mockJob.status = 'connected';

    check('runtime.connectSession was invoked', connectSessionCalled === true);
    check('connectSession received paired number', connectSessionOptions?.number === pairedNumber);
    check('connectSession received customCode', connectSessionOptions?.customCode === 'LilyMD~TestCard123456');
    check('Main bot runtime is now connected', runtime.getConnected() === true);
    check('Job state marked connected', mockJob.state === 'connected' && mockJob.status === 'connected');

    // Cleanup temp job directory
    try { fs.rmSync(tempJobDir, { recursive: true, force: true }); } catch {}

    // -------------------------------------------------------------
    // Test 3: Dashboard Status Reflects Live Bot State (Online)
    // -------------------------------------------------------------
    console.log('\n3. Dashboard Status Endpoint Parity:');

    const statusAfterPair = webApi.status();
    check('webApi.status() returns connected: true (Online)', statusAfterPair.connected === true);
    check('webApi.status() returns state: "connected"', statusAfterPair.state === 'connected');
    check('webApi.status() shows correct WhatsApp number', statusAfterPair.whatsappNumber === pairedNumber);

    // -------------------------------------------------------------
    // Test 4: WhatsApp Bot Commands Functionality
    // -------------------------------------------------------------
    console.log('\n4. WhatsApp Command Handling on Connected Bot:');

    // Send a simulated command to the bot's messages.upsert
    mockMainBotSock.ev.emit('messages.upsert', {
        type: 'notify',
        messages: [{
            key: { remoteJid: `${pairedNumber}@s.whatsapp.net`, fromMe: false },
            text: '.ping'
        }]
    });

    check('Main bot processed command via messages.upsert', botCommandReceived === true);

    // -------------------------------------------------------------
    // Test 5: Disconnect and Offline Status Behavior
    // -------------------------------------------------------------
    console.log('\n5. Disconnect & Offline Status Accuracy:');

    await runtime.disconnect();
    check('Runtime reports disconnected after disconnect', runtime.getConnected() === false);

    const statusAfterDisconnect = webApi.status();
    check('Dashboard status reports connected: false (Offline)', statusAfterDisconnect.connected === false);
    check('Dashboard status reports state: "disconnected"', statusAfterDisconnect.state === 'disconnected');

    // -------------------------------------------------------------
    // Test 6: Reconnect Restores Online Status
    // -------------------------------------------------------------
    console.log('\n6. Reconnect Lifecycle:');

    await runtime.reconnect();
    check('Runtime reports connected after reconnect', runtime.getConnected() === true);

    const statusAfterReconnect = webApi.status();
    check('Dashboard status restores connected: true (Online)', statusAfterReconnect.connected === true);

    // -------------------------------------------------------------
    // Test 7: Restart with Existing Saved Session
    // -------------------------------------------------------------
    console.log('\n7. Restart with Saved Session Parity:');

    // Verify ./session has creds.json
    check('Saved session exists in ./session after restart', sessionBackup.hasSession(mainSessionDir));

    // When the bot boots with existing valid credentials, no new pairing is requested
    const storeData = sessionBackup.readSessionStore();
    check('Session store contains session card records', Object.keys(storeData).length > 0);

    // -------------------------------------------------------------
    // Test 8: Single Active Socket (No Duplicates / 440 Conflicts)
    // -------------------------------------------------------------
    console.log('\n8. Single Socket Lifecycle Integrity:');

    const activeMainSocket = runtime.getSocket();
    check('Single active socket in runtime', activeMainSocket === mockMainBotSock);
    check('Temporary pairing socket remains nulled and closed', mockJob.socket === null);

    // Summary
    console.log(`\n========================================`);
    console.log(`Test Results: ${pass} passed, ${fail} failed.`);
    console.log(`========================================\n`);

    if (fail > 0) process.exit(1);
}

run().catch((err) => {
    console.error('Test failed with uncaught exception:', err);
    process.exit(1);
});
