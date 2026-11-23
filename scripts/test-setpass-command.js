'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const auth = require('../lib/webAuth');
const sessionBackup = require('../lib/sessionBackup');
const setpassCommand = require('../commands/setpass');
const { ownerNumbers } = require('../lib/ownerNumbers');

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
    console.log('Testing Lily MD Dashboard Password Setup via .setpass WhatsApp Command:\n');

    const ownerNum = '916033352400';
    const pairedNum = '919876543210';
    const unauthorizedNum = '14155552671';

    // -------------------------------------------------------------
    // Test 1: Pairing Generates Temporary Password & Caption Guidance
    // -------------------------------------------------------------
    console.log('1. Pairing Completion & Temporary Password:');
    let capturedMessages = [];
    const mockSock = {
        user: { id: `${pairedNum}:10@s.whatsapp.net` },
        sendMessage: async (jid, content, options) => {
            capturedMessages.push({ jid, content, options });
            return { key: { id: `msg-${Date.now()}` } };
        }
    };

    const delivery = await sessionBackup.deliverPairingSuccess(mockSock, pairedNum, {
        platform: 'Server'
    });

    check('Pairing delivery succeeded', delivery.ok === true && delivery.delivered === true);
    check('Temporary Dashboard Password generated', typeof delivery.tempPassword === 'string' && delivery.tempPassword.length >= 8);
    check('Caption includes temporary password', delivery.caption.includes('*Dashboard Password:*'));
    check('Caption guides user to set permanent password with .setpass', delivery.caption.includes('.setpass <new-password>'));

    const tempPassword = delivery.tempPassword;

    // Verify temp password works for login
    const loginTemp = auth.login(pairedNum, tempPassword, { headers: {} });
    check('Temporary password logs in successfully', loginTemp.ok === true && typeof loginTemp.token === 'string');

    // -------------------------------------------------------------
    // Test 2: Unauthorized Sender Rejected
    // -------------------------------------------------------------
    console.log('\n2. Unauthorized User Access Rejection:');
    capturedMessages = [];

    const unauthorizedMessage = {
        key: {
            remoteJid: `${unauthorizedNum}@s.whatsapp.net`,
            participant: `${unauthorizedNum}@s.whatsapp.net`,
            fromMe: false
        },
        message: {
            conversation: '.setpass HackerPass999!'
        }
    };

    await setpassCommand(
        mockSock,
        `${unauthorizedNum}@s.whatsapp.net`,
        unauthorizedMessage,
        '.setpass hackerpass999!',
        `${unauthorizedNum}@s.whatsapp.net`,
        '.setpass HackerPass999!'
    );

    check('Unauthorized user was sent error message', capturedMessages.length > 0);
    check('Rejection message states owner-only permission', capturedMessages[0]?.content?.text?.includes('only available for the bot owner'));
    check('Rejection does not leak password or validation status', !capturedMessages[0]?.content?.text?.includes('HackerPass999'));

    // Verify password was NOT changed by unauthorized user
    const loginHacker = auth.login(pairedNum, 'HackerPass999!', { headers: {} });
    check('Unauthorized password does not work for login', loginHacker.ok === false);
    const loginStillTemp = auth.login(pairedNum, tempPassword, { headers: {} });
    check('Original temporary password is still intact after unauthorized attempt', loginStillTemp.ok === true);

    // -------------------------------------------------------------
    // Test 3: Password Validation (Weak / Empty / Placeholder)
    // -------------------------------------------------------------
    console.log('\n3. Password Validation & Strength Checks:');

    const ownerMessage = (text) => ({
        key: {
            remoteJid: `${ownerNum}@s.whatsapp.net`,
            participant: `${ownerNum}@s.whatsapp.net`,
            fromMe: true
        },
        message: { conversation: text }
    });

    // A) Empty password argument (shows usage)
    capturedMessages = [];
    await setpassCommand(mockSock, `${ownerNum}@s.whatsapp.net`, ownerMessage('.setpass'), '.setpass', `${ownerNum}@s.whatsapp.net`, '.setpass');
    check('Empty .setpass returns usage instructions', capturedMessages[0]?.content?.text?.includes('*Usage:*'));
    check('Usage shows example .setpass MyNewPass123', capturedMessages[0]?.content?.text?.includes('.setpass MyNewPass123'));

    // B) Too short password (< 8 chars)
    capturedMessages = [];
    await setpassCommand(mockSock, `${ownerNum}@s.whatsapp.net`, ownerMessage('.setpass Abc1'), '.setpass abc1', `${ownerNum}@s.whatsapp.net`, '.setpass Abc1');
    check('Short password rejected', capturedMessages[0]?.content?.text?.includes('Password rejected'));
    check('Rejection message does NOT contain the password', !capturedMessages[0]?.content?.text?.includes('Abc1'));

    // C) Missing numbers (all letters)
    capturedMessages = [];
    await setpassCommand(mockSock, `${ownerNum}@s.whatsapp.net`, ownerMessage('.setpass OnlyLetters'), '.setpass onlyletters', `${ownerNum}@s.whatsapp.net`, '.setpass OnlyLetters');
    check('Password missing numbers rejected', capturedMessages[0]?.content?.text?.includes('Password rejected'));

    // D) Missing letters (all numbers)
    capturedMessages = [];
    await setpassCommand(mockSock, `${ownerNum}@s.whatsapp.net`, ownerMessage('.setpass 123456789'), '.setpass 123456789', `${ownerNum}@s.whatsapp.net`, '.setpass 123456789');
    check('Password missing letters rejected', capturedMessages[0]?.content?.text?.includes('Password rejected'));

    // E) Reject demo/placeholder values
    capturedMessages = [];
    await setpassCommand(mockSock, `${ownerNum}@s.whatsapp.net`, ownerMessage('.setpass DEMO'), '.setpass demo', `${ownerNum}@s.whatsapp.net`, '.setpass DEMO');
    check('Demo placeholder rejected', capturedMessages[0]?.content?.text?.includes('Password rejected'));

    // -------------------------------------------------------------
    // Test 4: Owner Sets Permanent Password Successfully
    // -------------------------------------------------------------
    console.log('\n4. Successful Permanent Password Change:');
    capturedMessages = [];
    const permanentPass = 'MyNewPass123';

    await setpassCommand(
        mockSock,
        `${ownerNum}@s.whatsapp.net`,
        ownerMessage(`.setpass ${permanentPass}`),
        `.setpass ${permanentPass.toLowerCase()}`,
        `${ownerNum}@s.whatsapp.net`,
        `.setpass ${permanentPass}`
    );

    check('Confirmation message sent to WhatsApp', capturedMessages.length > 0);
    const replyText = capturedMessages[0]?.content?.text || '';
    check('Confirmation states permanent password is now active', replyText.includes('Permanent password is now active'));
    check('Confirmation notes previous password invalidated', replyText.includes('invalidated'));
    check('Confirmation NEVER repeats the new password', !replyText.includes(permanentPass));

    // -------------------------------------------------------------
    // Test 5: Immediate Dashboard Login with New Password
    // -------------------------------------------------------------
    console.log('\n5. Dashboard Login Verification:');

    // A) Login with new permanent password succeeds
    const loginNew = auth.login(ownerNum, permanentPass, { headers: {} });
    check('Dashboard login succeeds with new permanent password', loginNew.ok === true && typeof loginNew.token === 'string');

    // B) Login with paired number + new permanent password succeeds
    const loginPairedNew = auth.login(pairedNum, permanentPass, { headers: {} });
    check('Dashboard login succeeds for paired number with new password', loginPairedNew.ok === true);

    // C) Login with password-only (blank number) succeeds
    const loginBlankNew = auth.login('', permanentPass, { headers: {} });
    check('Dashboard login succeeds with password-only (blank number)', loginBlankNew.ok === true);

    // D) Old temporary password is now completely INVALID
    const loginOldTemp = auth.login(ownerNum, tempPassword, { headers: {} });
    check('Old temporary password is now rejected (401)', loginOldTemp.ok === false && loginOldTemp.status === 401);

    const loginOldTempPaired = auth.login(pairedNum, tempPassword, { headers: {} });
    check('Old temporary password rejected for paired number (401)', loginOldTempPaired.ok === false && loginOldTempPaired.status === 401);

    // -------------------------------------------------------------
    // Test 6: Persistence Across Server Restart
    // -------------------------------------------------------------
    console.log('\n6. Persistence Across Restart:');

    // Read account directly from disk to simulate cold reload
    const storedAccount = auth.findAccount(ownerNum);
    check('Account persists on disk with updated passwordHash', storedAccount !== null);
    check('Stored hash verifies against new permanent password', auth.verifyPassword(permanentPass, storedAccount.passwordHash));
    check('Stored hash rejects old temporary password', !auth.verifyPassword(tempPassword, storedAccount.passwordHash));

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
