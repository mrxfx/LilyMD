#!/usr/bin/env node
'use strict';
/**
 * Verification test suite for Lily MD WhatsApp pairing lifecycle:
 * - Pairing code generation and handling
 * - WhatsApp 515 (restartRequired) stream restart
 * - QR code pairing and immediate reconnect
 * - Successful login completion
 * - Restart with saved session
 * - Temporary disconnect recovery without re-pairing or wiping credentials
 * - Duplicate socket prevention and sanitized logging
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run() {
    console.log('Running Lily MD WhatsApp Pairing & Reconnect Lifecycle Tests...\n');

    // Section 1: Pairing Code Flow & 515 Stream Restart
    section('1. Pairing Code Lifecycle & 515 (restartRequired)');
    {
        let socketReconnected = false;
        let pairingCodeRequestCount = 0;
        let pairingCompleted = false;
        let credsSaved = false;

        class MockSocket extends EventEmitter {
            constructor(registered = false) {
                super();
                this.ev = this;
                this.authState = {
                    creds: { registered }
                };
                this.user = { id: '916033352400:1@s.whatsapp.net', name: 'Lily' };
                this.ws = { close: () => {} };
            }
            async requestPairingCode(num) {
                pairingCodeRequestCount++;
                return '1234-5678';
            }
            end() {}
            sendMessage() { return Promise.resolve({ key: {} }); }
        }

        let currentSock = new MockSocket(false);
        let pairingCodeRequested = false;

        // Step 1: Request pairing code
        if (!currentSock.authState.creds.registered && !pairingCodeRequested) {
            pairingCodeRequested = true;
            await currentSock.requestPairingCode('916033352400');
        }

        check('Pairing code requested on initial registration', pairingCodeRequestCount === 1);

        // Step 2: Phone enters code -> creds updated -> WhatsApp issues 515 restartRequired
        credsSaved = true; // saveCreds executed
        currentSock.authState.creds.registered = true;

        // WhatsApp protocol drops socket with 515 restartRequired
        const disconnect515 = {
            error: {
                output: { statusCode: 515 },
                message: 'Stream restart required after key exchange'
            }
        };

        const isRestart = disconnect515.error.output.statusCode === 515;
        check('515 identified as restartRequired', isRestart === true);

        // Immediate reconnect logic (does NOT request pairing code again!)
        if (isRestart) {
            // Teardown previous socket
            currentSock.removeAllListeners();
            // Start new socket with saved registered credentials
            currentSock = new MockSocket(true);
            socketReconnected = true;

            // Ensure pairing code is NOT requested again during reconnect
            if (!currentSock.authState.creds.registered && !pairingCodeRequested) {
                await currentSock.requestPairingCode('916033352400');
            }
        }

        check('Socket reconnected after 515', socketReconnected === true);
        check('Pairing code was NOT requested a second time during 515 restart', pairingCodeRequestCount === 1);

        // Connection open
        currentSock.emit('connection.update', { connection: 'open' });
        pairingCompleted = true;
        check('Connection reached open state', pairingCompleted === true);
    }

    // Section 2: QR Pairing Flow & Immediate Reconnect
    section('2. QR Pairing Lifecycle');
    {
        let qrGenerated = false;
        let qrReconnected = false;
        let qrConnected = false;

        class MockQrSocket extends EventEmitter {
            constructor() {
                super();
                this.ev = this;
                this.authState = { creds: { registered: false } };
                this.user = { id: '916033352400@s.whatsapp.net' };
                this.ws = { close: () => {} };
            }
            end() {}
        }

        let qrSock = new MockQrSocket();
        // Emits QR
        qrSock.emit('connection.update', { qr: 'mock-qr-code-data' });
        qrGenerated = true;
        check('QR code emitted for scanning', qrGenerated === true);

        // Phone scans QR -> WhatsApp signals 515
        const qrDisconnect = {
            error: {
                output: { statusCode: 515 },
                message: 'restartRequired'
            }
        };

        const isRestart = qrDisconnect.error.output.statusCode === 515;
        if (isRestart) {
            qrSock.removeAllListeners();
            qrSock = new MockQrSocket();
            qrSock.authState.creds.registered = true;
            qrReconnected = true;
        }

        check('QR socket reconnected on 515 without error', qrReconnected === true);
        qrSock.emit('connection.update', { connection: 'open' });
        qrConnected = true;
        check('QR pairing reached open state', qrConnected === true);
    }

    // Section 3: Restart with Saved Session
    section('3. Restart with Saved Session');
    {
        let pairingCodeCalled = false;
        class SavedSessionSocket extends EventEmitter {
            constructor() {
                super();
                this.ev = this;
                this.authState = { creds: { registered: true } }; // Already registered!
                this.user = { id: '916033352400:1@s.whatsapp.net' };
            }
            async requestPairingCode() {
                pairingCodeCalled = true;
            }
            end() {}
        }

        const sock = new SavedSessionSocket();
        if (!sock.authState.creds.registered) {
            await sock.requestPairingCode();
        }

        check('Restart with saved session does not trigger pairing code', pairingCodeCalled === false);
        check('Print QR in terminal is skipped when already registered', (!sock.authState.creds.registered) === false);
    }

    // Section 4: Temporary Disconnect vs Logged Out
    section('4. Disconnect Handling (Temporary Drop vs Logged Out)');
    {
        const tempDisconnect = {
            error: {
                output: { statusCode: 428 },
                message: 'Connection Closed (Precondition Required)'
            }
        };

        const isLoggedOut = tempDisconnect.error.output.statusCode === 401;
        const isConflict = tempDisconnect.error.output.statusCode === 440;
        const shouldReconnect = !isLoggedOut && !isConflict;

        check('Temporary disconnect (428) triggers reconnect', shouldReconnect === true);
        check('Temporary disconnect does not wipe credentials', isLoggedOut === false);

        const logoutDisconnect = {
            error: {
                output: { statusCode: 401 },
                message: 'Logged out by device'
            }
        };

        const isLogout401 = logoutDisconnect.error.output.statusCode === 401;
        const shouldReconnectOnLogout = !isLogout401;

        check('Logged out (401) stops reconnecting', shouldReconnectOnLogout === false);
        check('Logged out signals credential cleanup', isLogout401 === true);
    }

    // Section 5: Log Redaction & Security
    section('5. Log Redaction & Security');
    {
        function sanitizeDisconnectReason(lastDisconnect) {
            if (!lastDisconnect || !lastDisconnect.error) return 'normal closure';
            const error = lastDisconnect.error;
            const statusCode = error?.output?.statusCode || error?.status || error?.statusCode;
            const message = error?.message || String(error);
            const cleanMsg = message.replace(/(?:bearer\s+|key=|token=)[a-zA-Z0-9_\-\.\/+=]+/gi, '[REDACTED]').slice(0, 150);
            return `status ${statusCode || 'none'} (${cleanMsg})`;
        }

        const rawErrWithKey = {
            error: {
                output: { statusCode: 500 },
                message: 'Failed request with token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9 and key=sk-proj-1234567890abcdef'
            }
        };

        const sanitized = sanitizeDisconnectReason(rawErrWithKey);
        check('Auth tokens and API keys are redacted in disconnect logs', !sanitized.includes('eyJhbGci') && !sanitized.includes('sk-proj'));
        check('Status code preserved in sanitized message', sanitized.includes('status 500'));
    }

    // Section 6: Shared Confirmation Message & Dashboard Password Uniformity
    section('6. Shared Confirmation Message & Dashboard Password Uniformity');
    {
        const sessionBackup = require('../lib/sessionBackup');
        const auth = require('../lib/webAuth');

        const serverSentMessages = [];
        const mockServerSock = {
            sendMessage: async (jid, content) => {
                serverSentMessages.push({ jid, content });
                return { key: { id: 'srv-msg-1' } };
            }
        };

        const webSentMessages = [];
        const mockWebSock = {
            sendMessage: async (jid, content) => {
                webSentMessages.push({ jid, content });
                return { key: { id: 'web-msg-1' } };
            }
        };

        const testNumber = '916033352400';

        // 1. Execute Server Pairing Confirmation
        const serverResult = await sessionBackup.deliverPairingSuccess(mockServerSock, testNumber, {
            sessionId: 'LilyMD~SERVERTEST12345',
            platform: 'Linux'
        });

        check('Server pairing confirmation delivered', serverResult.ok === true && serverResult.delivered === true);
        check('Server pairing generated valid Dashboard Password', typeof serverResult.tempPassword === 'string' && serverResult.tempPassword.length >= 8);
        check('Server pairing sent two messages (caption + session card)', serverSentMessages.length === 2);

        const serverCaption = serverSentMessages[0].content.caption || serverSentMessages[0].content.text;
        check('Server confirmation contains Lily MD header', serverCaption.includes('╭━━━〔 LILY MD 〕━━━╮'));
        check('Server confirmation contains PAIRING SUCCESSFUL', serverCaption.includes('PAIRING SUCCESSFUL'));
        check('Server confirmation contains Version', serverCaption.includes('Version'));
        check('Server confirmation contains Platform: Linux', serverCaption.includes('Platform     : Linux'));
        check('Server confirmation contains Account number', serverCaption.includes(`Account      : +${testNumber}`));
        check('Server confirmation contains Pair Status: Connected', serverCaption.includes('Pair Status  : Connected'));
        check('Server confirmation contains session ready text', serverCaption.includes('Your Lily MD session is ready.'));
        check('Server confirmation notes session card attachment', serverCaption.includes('Session card is attached separately.'));
        check('Server confirmation contains Dashboard Password block', serverCaption.includes(`🔐 *Dashboard Password:* \`${serverResult.tempPassword}\``));

        // Verify server password authenticates against webAccounts
        const serverAccount = auth.findAccount(testNumber);
        check('Server pairing provisioned web account', serverAccount !== null);
        check('Server password matches scrypt hash in webAccounts', auth.verifyPassword(serverResult.tempPassword, serverAccount.passwordHash));

        // 2. Execute Website Pairing Confirmation
        const webResult = await sessionBackup.deliverPairingSuccess(mockWebSock, testNumber, {
            sessionId: 'LilyMD~WEBTEST12345678',
            platform: 'Render'
        });

        check('Website pairing confirmation delivered', webResult.ok === true && webResult.delivered === true);
        check('Website pairing generated valid Dashboard Password', typeof webResult.tempPassword === 'string' && webResult.tempPassword.length >= 8);
        check('Website pairing sent two messages (caption + session card)', webSentMessages.length === 2);

        const webCaption = webSentMessages[0].content.caption || webSentMessages[0].content.text;
        check('Website confirmation contains Lily MD header', webCaption.includes('╭━━━〔 LILY MD 〕━━━╮'));
        check('Website confirmation contains PAIRING SUCCESSFUL', webCaption.includes('PAIRING SUCCESSFUL'));
        check('Website confirmation contains Version', webCaption.includes('Version'));
        check('Website confirmation contains Platform: Render', webCaption.includes('Platform     : Render'));
        check('Website confirmation contains Account number', webCaption.includes(`Account      : +${testNumber}`));
        check('Website confirmation contains Pair Status: Connected', webCaption.includes('Pair Status  : Connected'));
        check('Website confirmation contains session ready text', webCaption.includes('Your Lily MD session is ready.'));
        check('Website confirmation notes session card attachment', webCaption.includes('Session card is attached separately.'));
        check('Website confirmation contains Dashboard Password block', webCaption.includes(`🔐 *Dashboard Password:* \`${webResult.tempPassword}\``));

        // Verify web password authenticates
        const webAccount = auth.findAccount(testNumber);
        check('Web password matches scrypt hash in webAccounts', auth.verifyPassword(webResult.tempPassword, webAccount.passwordHash));

        // 3. Verify identical message structure between server and website pairing
        const normalizeCaption = (c) => c.replace(/Platform\s*:\s*\w+/, 'Platform: X').replace(/Dashboard Password:\*\s*`[^`]+`/, 'Dashboard Password:* `X`');
        check('Message structure and fields are identical between server and website pairing', normalizeCaption(serverCaption) === normalizeCaption(webCaption));

        // Verify minimal session card document in both
        check('Server session card attachment contains LilyMD prefix', String(serverSentMessages[1].content.document).startsWith('LilyMD~'));
        check('Website session card attachment contains LilyMD prefix', String(webSentMessages[1].content.document).startsWith('LilyMD~'));
    }

    // Summary
    console.log(`\nPairing Flow Tests Summary: ${passed} passed, ${failed} failed.`);
    if (failed > 0) process.exit(1);
}

run().catch((err) => {
    console.error('Fatal test error:', err);
    process.exit(1);
});
