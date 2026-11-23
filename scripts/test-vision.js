'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

console.log('🧪 Running Lily MD Image Vision Test Suite...\n');

let passed = 0;
let failed = 0;

function it(desc, fn) {
    return Promise.resolve()
        .then(() => fn())
        .then(() => {
            console.log(`  ✓ ${desc}`);
            passed++;
        })
        .catch((err) => {
            console.error(`  ✗ ${desc}`);
            console.error(`    Error: ${err.message}`);
            failed++;
        });
}

const DATA_DIR = path.join(__dirname, '..', 'data');
const VISION_FILE = path.join(DATA_DIR, 'vision.json');

// Backup existing vision.json if present
let originalVisionData = null;
if (fs.existsSync(VISION_FILE)) {
    try {
        originalVisionData = fs.readFileSync(VISION_FILE, 'utf8');
    } catch (_) {}
}

async function runTests() {
    const vision = require('../lib/vision');
    const visionCommand = require('../commands/vision');
    const webApi = require('../lib/webApi');

    // Test 1: Configuration and defaults
    await it('Initializes with correct primary (gemini-3.6-flash) and fallback (gemini-3.1-flash-lite) models', () => {
        assert.strictEqual(vision.PRIMARY_MODEL, 'gemini-3.6-flash');
        assert.strictEqual(vision.FALLBACK_MODEL, 'gemini-3.1-flash-lite');
        const status = vision.getStatus();
        assert.strictEqual(status.primaryModel, 'gemini-3.6-flash');
        assert.strictEqual(status.fallbackModel, 'gemini-3.1-flash-lite');
    });

    // Test 2: Persistence across restarts
    await it('Saves setting persistently so it survives restarts', () => {
        vision.setEnabled(true);
        assert.strictEqual(vision.isEnabled(), true);
        const data1 = JSON.parse(fs.readFileSync(VISION_FILE, 'utf8'));
        assert.strictEqual(data1.enabled, true);

        // Simulate reload by calling readConfig afresh
        assert.strictEqual(vision.readConfig().enabled, true);

        vision.setEnabled(false);
        assert.strictEqual(vision.isEnabled(), false);
        const data2 = JSON.parse(fs.readFileSync(VISION_FILE, 'utf8'));
        assert.strictEqual(data2.enabled, false);
    });

    // Test 3: WhatsApp Admin Command - Unauthorized User
    await it('Rejects unauthorized users attempting to change vision setting', async () => {
        let sentMessage = null;
        const fakeSock = {
            sendMessage: async (chatId, content) => {
                sentMessage = content;
                return true;
            }
        };

        const fakeMessage = {
            key: {
                fromMe: false,
                participant: '1234567890@s.whatsapp.net',
                remoteJid: '9876543210@s.whatsapp.net'
            }
        };

        await visionCommand(fakeSock, '9876543210@s.whatsapp.net', fakeMessage, '.vision on', '1234567890@s.whatsapp.net');
        assert.ok(sentMessage && sentMessage.text.includes('only available for the owner or sudo'), 'Expected rejection message');
        assert.strictEqual(vision.isEnabled(), false, 'Vision should remain disabled');
    });

    // Test 4: WhatsApp Admin Command - Authorized Owner
    await it('Allows authorized owner to use .vision on, .vision off, and .vision status', async () => {
        let sentMessage = null;
        const fakeSock = {
            sendMessage: async (chatId, content) => {
                sentMessage = content;
                return true;
            }
        };

        // Authorized: fromMe = true
        const fakeOwnerMessage = {
            key: {
                fromMe: true,
                remoteJid: '9876543210@s.whatsapp.net'
            }
        };

        // Test .vision on
        await visionCommand(fakeSock, '9876543210@s.whatsapp.net', fakeOwnerMessage, '.vision on');
        assert.strictEqual(vision.isEnabled(), true);
        assert.ok(sentMessage.text.includes('Image Vision Enabled'));
        assert.ok(sentMessage.text.includes('gemini-3.6-flash'));
        assert.ok(sentMessage.text.includes('gemini-3.1-flash-lite'));

        // Test .vision status
        await visionCommand(fakeSock, '9876543210@s.whatsapp.net', fakeOwnerMessage, '.vision status');
        assert.ok(sentMessage.text.includes('Active (ON)'));
        assert.ok(sentMessage.text.includes('gemini-3.6-flash'));

        // Test .vision off
        await visionCommand(fakeSock, '9876543210@s.whatsapp.net', fakeOwnerMessage, '.vision off');
        assert.strictEqual(vision.isEnabled(), false);
        assert.ok(sentMessage.text.includes('Image Vision Disabled'));
    });

    // Test 5: Dashboard Toggle Synchronization
    await it('Keeps dashboard toggle and vision setting synchronized', () => {
        vision.setEnabled(true);
        let snap = webApi.settingsSnapshot();
        assert.strictEqual(snap.vision.enabled, true);
        assert.strictEqual(snap.toggles.vision.value, true);

        // Toggle via setToggle (dashboard mutation)
        webApi.setToggle('vision', false);
        assert.strictEqual(vision.isEnabled(), false);
        snap = webApi.settingsSnapshot();
        assert.strictEqual(snap.vision.enabled, false);
        assert.strictEqual(snap.toggles.vision.value, false);

        webApi.setToggle('vision', true);
        assert.strictEqual(vision.isEnabled(), true);
    });

    // Test 6: Image + Caption (Primary Model gemini-3.6-flash success)
    await it('Processes image + caption using primary model gemini-3.6-flash', async () => {
        const calls = [];
        const mockChatFn = async (messages, opts) => {
            calls.push(opts);
            return 'This is an image of a red sunset over the ocean.';
        };

        const fakeBuffer = Buffer.from('fake-image-bytes-jpeg');
        const res = await vision.analyzeImage({
            imageBuffer: fakeBuffer,
            mimeType: 'image/jpeg',
            prompt: 'What is shown in this picture?',
            history: [{ role: 'user', content: 'Hello' }],
            systemPrompt: 'You are Rahul.',
            chatFn: mockChatFn
        });

        assert.strictEqual(res.ok, true);
        assert.strictEqual(res.model, 'gemini-3.6-flash');
        assert.strictEqual(res.fallbackUsed, false);
        assert.strictEqual(res.text, 'This is an image of a red sunset over the ocean.');
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0].model, 'gemini-3.6-flash');
    });

    // Test 7: Image without Caption (Uses default prompt)
    await it('Processes image without caption using natural default prompt', async () => {
        let sentPrompt = null;
        const mockChatFn = async (messages, opts) => {
            const userMsg = messages.find((m) => m.role === 'user');
            const textPart = userMsg?.content?.find((p) => p.type === 'text');
            sentPrompt = textPart?.text;
            return 'A detailed analysis of the image.';
        };

        const fakeBuffer = Buffer.from('fake-image-bytes-png');
        const res = await vision.analyzeImage({
            imageBuffer: fakeBuffer,
            mimeType: 'image/png',
            prompt: '', // empty caption
            chatFn: mockChatFn
        });

        assert.strictEqual(res.ok, true);
        assert.strictEqual(res.model, 'gemini-3.6-flash');
        assert.ok(sentPrompt && sentPrompt.length > 5, 'Expected natural default prompt');
    });

    // Test 8: Primary Model Temporary Failure with Fallback to gemini-3.1-flash-lite
    await it('Falls back to gemini-3.1-flash-lite on rate limit (429) or temporary quota error', async () => {
        const calls = [];
        const mockChatFn = async (messages, opts) => {
            calls.push(opts.model);
            if (opts.model === 'gemini-3.6-flash') {
                const err = new Error('Resource has been exhausted (e.g. check quota).');
                err.status = 429;
                err.isRateLimit = true;
                throw err;
            }
            if (opts.model === 'gemini-3.1-flash-lite') {
                return 'Fallback successfully analyzed the diagram!';
            }
            throw new Error('Unknown model');
        };

        const fakeBuffer = Buffer.from('fake-image-bytes');
        const res = await vision.analyzeImage({
            imageBuffer: fakeBuffer,
            mimeType: 'image/jpeg',
            prompt: 'Explain this diagram',
            chatFn: mockChatFn
        });

        assert.strictEqual(res.ok, true);
        assert.strictEqual(res.model, 'gemini-3.1-flash-lite');
        assert.strictEqual(res.fallbackUsed, true);
        assert.strictEqual(res.text, 'Fallback successfully analyzed the diagram!');
        assert.deepStrictEqual(calls, ['gemini-3.6-flash', 'gemini-3.1-flash-lite']);
    });

    // Test 9: Permanent Error on Primary Does NOT Trigger Fallback
    await it('Does NOT switch models for invalid requests (400) or permanent auth errors (401/403)', async () => {
        const calls = [];
        const mockChatFn = async (messages, opts) => {
            calls.push(opts.model);
            const err = new Error('API key not valid. Please pass a valid API key.');
            err.status = 401;
            err.isInvalidKey = true;
            throw err;
        };

        const fakeBuffer = Buffer.from('fake-image-bytes');
        const res = await vision.analyzeImage({
            imageBuffer: fakeBuffer,
            mimeType: 'image/jpeg',
            prompt: 'Test auth error',
            chatFn: mockChatFn
        });

        assert.strictEqual(res.ok, false);
        assert.strictEqual(res.permanent, true);
        assert.deepStrictEqual(calls, ['gemini-3.6-flash'], 'Fallback must NOT be called on permanent error');
    });

    // Test 10: Both Models Failing Returns Short Helpful Error
    await it('Sends short helpful error message when both models fail (never silently pretends image was analyzed)', async () => {
        const calls = [];
        const mockChatFn = async (messages, opts) => {
            calls.push(opts.model);
            const err = new Error('Service Unavailable HTTP 503');
            err.status = 503;
            throw err;
        };

        const fakeBuffer = Buffer.from('fake-image-bytes');
        const res = await vision.analyzeImage({
            imageBuffer: fakeBuffer,
            mimeType: 'image/jpeg',
            prompt: 'Test double failure',
            chatFn: mockChatFn
        });

        assert.strictEqual(res.ok, false);
        assert.deepStrictEqual(calls, ['gemini-3.6-flash', 'gemini-3.1-flash-lite']);
        assert.ok(res.helpfulMessage && res.helpfulMessage.includes('unavailable'), 'Expected helpful failure message');
    });

    // Test 11: Non-image messages and Vision Disabled Flow in aiAutoReply
    await it('Preserves text-only AI flow when vision is disabled and handles non-image messages', async () => {
        const aiAutoReply = require('../lib/aiAutoReply');

        vision.setEnabled(false);
        assert.strictEqual(vision.isEnabled(), false);

        // When message has an image but no text, and vision is disabled, handleAiAutoReply returns false
        const fakeImageMsgWithoutText = {
            key: { id: 'test_msg_1', remoteJid: '12345@s.whatsapp.net', fromMe: false },
            message: {
                imageMessage: { mimetype: 'image/jpeg', fileLength: 50000 }
            }
        };

        const fakeSock = {
            sendMessage: async () => true,
            sendPresenceUpdate: async () => true
        };

        const replied = await aiAutoReply.handleAiAutoReply(fakeSock, '12345@s.whatsapp.net', fakeImageMsgWithoutText, '', '12345@s.whatsapp.net');
        assert.strictEqual(replied, false, 'Vision disabled message with no text caption should not be answered');
    });

    // Cleanup: restore original vision.json or remove if it was not originally present
    if (originalVisionData !== null) {
        fs.writeFileSync(VISION_FILE, originalVisionData);
    } else {
        try { fs.unlinkSync(VISION_FILE); } catch (_) {}
    }

    console.log(`\n========================================`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    console.log(`========================================\n`);

    if (failed > 0) {
        process.exit(1);
    }
}

runTests();
