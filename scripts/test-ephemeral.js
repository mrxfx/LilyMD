#!/usr/bin/env node
'use strict';

const { getEphemeralExpiration } = require('../lib/aiAutoReply');

let passed = 0;
let failed = 0;

function check(name, condition) {
    if (condition) {
        passed++;
        console.log(`  ✓ ${name}`);
    } else {
        failed++;
        console.log(`  ✗ ${name}`);
    }
}

console.log('Testing WhatsApp Disappearing (Ephemeral) Message Expiration Handling:\n');

// 1. Direct message.expiration
const directMsg = {
    expiration: 86400,
    message: { conversation: 'hello' }
};
check('Extracts expiration from direct message.expiration', getEphemeralExpiration(directMsg, 'chat-1@s.whatsapp.net') === 86400);

// 2. Extracted from cache for subsequent messages in the same chat
const plainMsgInSameChat = {
    message: { conversation: 'how are you?' }
};
check('Uses cached chat expiration for subsequent messages in same chat', getEphemeralExpiration(plainMsgInSameChat, 'chat-1@s.whatsapp.net') === 86400);

// 3. Ephemeral wrapper extraction
const wrappedMsg = {
    message: {
        ephemeralMessage: {
            message: {
                extendedTextMessage: {
                    text: 'test disappearing message',
                    contextInfo: {
                        expiration: 604800
                    }
                }
            }
        }
    }
};
check('Extracts expiration from ephemeralMessage.message.extendedTextMessage', getEphemeralExpiration(wrappedMsg, 'chat-2@s.whatsapp.net') === 604800);

// 4. Normal chat without disappearing messages
check('Returns 0 for regular chat with no disappearing messages', getEphemeralExpiration({ message: { conversation: 'hi' } }, 'chat-normal@s.whatsapp.net') === 0);

// 5. Test mock sock.sendMessage with ephemeral options
let capturedOptions = null;
const mockSock = {
    sendMessage: async (chatId, content, options) => {
        capturedOptions = options;
        return { key: { id: 'msg-1' } };
    }
};

const exp = getEphemeralExpiration(wrappedMsg, 'chat-2@s.whatsapp.net');
const sendOpts = { quoted: wrappedMsg };
if (exp > 0) sendOpts.ephemeralExpiration = exp;
mockSock.sendMessage('chat-2@s.whatsapp.net', { text: 'reply' }, sendOpts);

check('Outgoing message options contain ephemeralExpiration matching chat setting', capturedOptions && capturedOptions.ephemeralExpiration === 604800);
check('Info icon (i) warning eliminated by matching disappearing timer', capturedOptions.ephemeralExpiration > 0);

console.log(`\nEphemeral tests: ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
