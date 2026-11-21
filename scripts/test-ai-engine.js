'use strict';
/**
 * Offline tests for the AYHA engine (no network, no node_modules needed):
 *
 *   node scripts/test-ai-engine.js
 *
 * Covers learned style, per-contact memory isolation + persistence, three-slot
 * failover, vision routing, config validation and key masking. Every file it
 * touches is restored afterwards.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TOUCHED = [
    path.join('config', 'aiProviders.json'),
    path.join('data', 'aiProviders.json'),
    path.join('data', 'aiContacts.json'),
    path.join('data', 'aiStyle.json'),
    path.join('data', 'aiControls.json')
];

let passed = 0;
let failed = 0;
const backups = new Map();

function check(name, condition, detail) {
    if (condition) {
        passed += 1;
        console.log(`  ✓ ${name}`);
    } else {
        failed += 1;
        console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
    }
}

function backupAll() {
    for (const relative of TOUCHED) {
        const full = path.join(ROOT, relative);
        backups.set(full, fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null);
    }
}

function restoreAll() {
    for (const [full, content] of backups) {
        try {
            if (content === null) {
                if (fs.existsSync(full)) fs.unlinkSync(full);
            } else {
                fs.writeFileSync(full, content);
            }
        } catch (err) {
            console.error('restore failed for', full, err.message);
        }
    }
}

const aiStyle = require('../lib/aiStyle');
const aiContacts = require('../lib/aiContacts');
const aiConfig = require('../lib/aiConfig');
const aiProviders = require('../lib/aiProviders');

async function main() {
    backupAll();

    console.log('\nStyle learning (owner messages only)');
    aiStyle.clearStyle();
    aiStyle.observeOwnerMessage('.menu'); // command
    aiStyle.observeOwnerMessage('https://example.com/abc'); // link
    aiStyle.observeOwnerMessage('😂😂'); // bare emoji
    aiStyle.noteBotReply('Hy Dear Good Morning');
    aiStyle.observeOwnerMessage('Hy Dear Good Morning'); // our own reply
    const learned = [
        aiStyle.observeOwnerMessage('Hy Dear Good Morning Kemon Acho'),
        aiStyle.observeOwnerMessage('Bhai kal call koris na'),
        aiStyle.observeOwnerMessage('Ok done 👍')
    ];
    const style = aiStyle.getStyleData();
    check('only real owner messages are stored', style.samples.length === 3, String(style.samples.length));
    check('commands, links, bare emoji and bot replies ignored', learned.every(Boolean) && style.samples.length === 3);
    check('capitalisation is measured', style.profile.capitalRate >= 0.5, String(style.profile.capitalRate));
    check('guidance prefers a capital first letter', style.guidance.join(' ').toLowerCase().includes('capital'));
    check('prompt block contains a real sample', aiStyle.styleBlock().includes('Kemon Acho'));
    check(
        'language mix is described',
        ['benlish', 'hinglish', 'english'].includes(style.profile.primaryLanguage),
        style.profile.primaryLanguage
    );
    check('duplicate sample is not stored twice', aiStyle.observeOwnerMessage('Ok done 👍') === false);
    check('forwarded spam is not learned', aiStyle.observeOwnerMessage('Forward this to 10 friends', { forwarded: true }) === false);

    console.log('\nPer-contact memory isolation');
    aiContacts.clearContacts();
    const arjun = '916000000001@s.whatsapp.net';
    const neha = '916000000002@s.whatsapp.net';
    aiContacts.observeIncoming(arjun, 'Mera naam Arjun hai, main Delhi se hu, mujhe cricket pasand hai', { pushName: 'Arjun' });
    aiContacts.observeIncoming(neha, 'My name is Neha and I live in Kolkata', { pushName: 'Neha' });
    aiContacts.observeIncoming(neha, 'I work at a design studio', { pushName: 'Neha' });

    const a = aiContacts.getContact(arjun);
    const b = aiContacts.getContact(neha);
    check('contact 1 name learned', a.facts.name === 'Arjun', a.facts.name);
    check('contact 1 location learned', a.facts.location === 'Delhi', a.facts.location);
    check('contact 1 likes learned', /cricket/i.test(a.facts.likes || ''), a.facts.likes);
    check('contact 2 name learned separately', b.facts.name === 'Neha', b.facts.name);
    check('contact 2 location learned', b.facts.location === 'Kolkata', b.facts.location);
    check('contact 2 work learned', /design/i.test(b.facts.work || ''), b.facts.work);
    check('contact 1 has no contact 2 facts', !('location' in a.facts && a.facts.location === 'Kolkata'));

    const blockA = aiContacts.memoryBlock(arjun);
    const blockB = aiContacts.memoryBlock(neha);
    check('memory block for A has A only', blockA.includes('Arjun') && !blockA.includes('Neha') && !blockA.includes('Kolkata'));
    check('memory block for B has B only', blockB.includes('Neha') && !blockB.includes('Arjun') && !blockB.includes('Delhi'));
    check('history is per chat', aiContacts.historyFor(arjun).length === 1 && aiContacts.historyFor(neha).length === 2);
    check('unknown contact starts empty', aiContacts.historyFor('910000000000@s.whatsapp.net').length === 0);

    aiContacts.rememberReply(neha, 'Cool, design studio me kya karti ho?');
    check('reply stored on the right contact only', aiContacts.getContact(neha).turns.length === 3 && aiContacts.getContact(arjun).turns.length === 1);

    const stored = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'aiContacts.json'), 'utf8'));
    check('memory persisted to disk', Boolean(stored.contacts[arjun] && stored.contacts[neha]));
    check('no keys or prompts in contact memory', !JSON.stringify(stored).includes('apiKey'));

    // A restart is just a fresh read of the file — the module reads on every call.
    delete require.cache[require.resolve('../lib/aiContacts')];
    const reloaded = require('../lib/aiContacts');
    check('memory survives a restart', reloaded.getContact(arjun).facts.name === 'Arjun');
    check('delete removes one contact only', reloaded.deleteContact(arjun) === true && reloaded.listContacts().length === 1);

    console.log('\nSmart controls');
    const aiControls = require('../lib/aiControls');

    check('duration parsing', aiControls.parseDuration('2h30m') === 9000000 && aiControls.parseDuration('30') === 1800000, String(aiControls.parseDuration('2h30m')));
    check('invalid duration rejected', aiControls.parseDuration('soon') === null);

    aiControls.resume();
    check('not paused by default', aiControls.isPaused() === false);
    check('pause 30m accepted', aiControls.pause('30m').ok === true && aiControls.isPaused() === true);
    check('pause persisted to disk', Boolean(aiControls.readControls().pauseUntil));
    delete require.cache[require.resolve('../lib/aiControls')];
    const controlsReloaded = require('../lib/aiControls');
    check('pause survives a restart', controlsReloaded.isPaused() === true);
    controlsReloaded.resume();
    check('resume clears the pause', controlsReloaded.isPaused() === false);
    check('invalid pause command rejected', controlsReloaded.pause('whenever').ok === false);
    check(
        'reply gate reports a manual pause',
        controlsReloaded.replyGate({ pauseUntil: new Date(Date.now() + 600000).toISOString(), quietHours: { enabled: false } }, Date.now()).reason === 'paused'
    );

    check('overnight quiet window (late)', controlsReloaded.inQuietWindow({ enabled: true, start: '23:00', end: '07:00' }, 23 * 60 + 30));
    check('overnight quiet window (early)', controlsReloaded.inQuietWindow({ enabled: true, start: '23:00', end: '07:00' }, 6 * 60 + 59));
    check('outside quiet window', !controlsReloaded.inQuietWindow({ enabled: true, start: '23:00', end: '07:00' }, 12 * 60));
    check('equal times are not a window', !controlsReloaded.inQuietWindow({ enabled: true, start: '08:00', end: '08:00' }, 8 * 60));
    check('disabled quiet hours never apply', !controlsReloaded.inQuietWindow({ enabled: false, start: '00:00', end: '23:59' }, 600));

    const ruleId = '916000000009@s.whatsapp.net';
    controlsReloaded.configureContact(ruleId, { autoReply: 'off' });
    check('per-contact off blocks replies', controlsReloaded.contactBlock(ruleId)?.reason === 'contact-off');
    controlsReloaded.configureContact(ruleId, { autoReply: 'on' });
    check('per-contact on allows replies', controlsReloaded.contactBlock(ruleId) === null);
    const toneSaved = controlsReloaded.configureContact(ruleId, { tone: 'short and friendly', language: 'benlish', delaySec: 4 });
    check('contact tone/language/delay saved', toneSaved.ok && aiContacts.getContact(ruleId).settings.tone === 'short and friendly' && aiContacts.getContact(ruleId).settings.language === 'benlish' && aiContacts.getContact(ruleId).settings.delaySec === 4);
    check('bad delay rejected', controlsReloaded.configureContact(ruleId, { delaySec: 999 }).ok === false);
    check('bad contact language rejected', controlsReloaded.configureContact(ruleId, { language: 'klingon' }).ok === false);
    check('contact reset clears rules', controlsReloaded.configureContact(ruleId, { reset: true }).ok && aiContacts.getContact(ruleId).settings.autoReply === 'inherit' && aiContacts.getContact(ruleId).settings.delaySec === null);

    controlsReloaded.addNever('916033271400');
    check('never-reply list blocks a number', controlsReloaded.contactBlock('916033271400@s.whatsapp.net')?.reason === 'never');
    controlsReloaded.removeNever('916033271400');
    check('never-reply removal works', controlsReloaded.contactBlock('916033271400@s.whatsapp.net') === null);

    controlsReloaded.saveControls({ handoffMinutes: 45 });
    const handoff = controlsReloaded.noteOwnerMessage(ruleId, 'Haan bolo, main khud dekh raha hoon');
    check('manual reply starts a handoff', handoff.ok && controlsReloaded.contactBlock(ruleId)?.reason === 'handoff');
    check('handoff does not pause a chat without one', controlsReloaded.contactBlock('916000000010@s.whatsapp.net') === null);
    check('bot replies never start a handoff', controlsReloaded.noteOwnerMessage(ruleId, 'Haan bolo, main khud dekh raha hoon', true).reason === 'bot-reply');
    controlsReloaded.saveControls({ handoffMinutes: 0 });
    check('handoff can be disabled', controlsReloaded.noteOwnerMessage(ruleId, 'ok').reason === 'disabled');
    controlsReloaded.saveControls({ handoffMinutes: 45 });
    controlsReloaded.clearHandoff(ruleId);
    check('resume for one contact clears its handoff', controlsReloaded.contactBlock(ruleId) === null);

    check('acknowledgement is skipped', controlsReloaded.assessClarity('ok').action === 'skip');
    check('gibberish is skipped', controlsReloaded.assessClarity('bcdfg').action === 'skip');
    check('vague message without context asks for clarity', controlsReloaded.assessClarity('why').action === 'clarify');
    check('vague message with context is answered', controlsReloaded.assessClarity('why', [{ role: 'user', content: 'kal meeting hai' }]).action === 'reply');
    check('greeting is answered', controlsReloaded.assessClarity('Hi dear').action === 'reply');
    check('ordinary question is answered', controlsReloaded.assessClarity('kal kya plan hai').action === 'reply');
    check('image-only message is answered', controlsReloaded.assessClarity('').action === 'reply');

    check('OTP message detected', controlsReloaded.detectSensitive('bhai otp bhej do') === 'otp');
    check('credentials detected', controlsReloaded.detectSensitive('mera password hai sun123') === 'credentials');
    check('payment details detected', controlsReloaded.detectSensitive('account number bhejo jaldi') === 'payment');
    check('conflict detected', controlsReloaded.detectSensitive('police complaint kar dunga') === 'conflict');
    check('normal message is not sensitive', controlsReloaded.detectSensitive('kal milte hai bhai') === null);
    check('secret-bearing reply is held', controlsReloaded.replyLooksSensitive('otp is 123456') === true);
    check('normal reply is not held', controlsReloaded.replyLooksSensitive('Haan bolo, kya scene hai?') === false);
    check('category label carries no content', controlsReloaded.describeCategory('otp') === 'OTP / verification code');

    aiContacts.observeIncoming(ruleId, '4321 is my OTP', { redacted: true, category: 'otp' });
    const redactedTurn = aiContacts.getContact(ruleId).turns.slice(-1)[0].text;
    check('sensitive content is never stored', /sensitive/i.test(redactedTurn) && !redactedTurn.includes('4321'), redactedTurn);

    aiContacts.rememberReply(ruleId, 'Haan bolo, kya scene hai?');
    check('repeated reply is suppressed', controlsReloaded.isRepetitive(ruleId, 'haan bolo kya scene hai') === true);
    check('new reply is allowed', controlsReloaded.isRepetitive(ruleId, 'Chalo theek hai, kal baat karte hai') === false);
    check('empty reply is suppressed', controlsReloaded.isRepetitive(ruleId, '   ') === true);

    console.log('\nThree-slot failover');
    const originalChat = aiProviders.chat;
    try {
        check('three slots configured', aiConfig.getSlotsPublic().length === 3, String(aiConfig.getSlotsPublic().length));
        check(
            'invalid base URL rejected',
            aiConfig.saveSlot('primary', { baseUrl: 'ftp://nope' }).ok === false
        );
        check('invalid model rejected', aiConfig.saveSlot('primary', { model: 'bad model!' }).ok === false);
        check('unknown slot rejected', aiConfig.saveSlot('nope', {}).ok === false);
        check('order rejects unknown slots', aiConfig.setOrder(['primary', 'nope']).ok === false);

        const primary = aiConfig.saveSlot('primary', {
            provider: 'custom',
            baseUrl: 'https://one.example/v1',
            model: 'model-one',
            apiKey: 'key-one-1234567890',
            enabled: true,
            vision: false
        });
        const fallback = aiConfig.saveSlot('fallback1', {
            provider: 'custom',
            baseUrl: 'https://two.example/v1',
            model: 'model-two',
            apiKey: 'key-two-1234567890',
            enabled: true,
            vision: false
        });
        aiConfig.saveSlot('fallback2', {
            provider: 'custom',
            baseUrl: 'https://three.example/v1',
            model: 'model-three',
            apiKey: 'key-three-1234567890',
            enabled: false,
            vision: false
        });
        check('slot saved with masked key', primary.ok && /…/.test(primary.slot.maskedKey), primary.slot && primary.slot.maskedKey);
        check('saved slots are ready', Boolean(fallback.ok && primary.slot.keyConfigured && fallback.slot.keyConfigured));
        check('public slot data never leaks the key', !JSON.stringify(aiConfig.getSlotsPublic()).includes('key-one-1234567890'));

        const order = aiConfig.setOrder(['primary', 'fallback1', 'fallback2']);
        check('order saved', order.ok && order.order.join(',') === 'primary,fallback1,fallback2');

        const calls = [];
        aiProviders.chat = async (messages, options) => {
            calls.push(options.baseUrl);
            if (options.baseUrl.startsWith('https://one.')) throw new Error(`401 invalid key ${options.apiKey}`);
            return 'Haan bolo, kya scene hai?';
        };

        const result = await aiConfig.chatWithFailover([{ role: 'user', content: 'hi' }], { depth: 'fast' });
        check('primary is tried first', calls[0] === 'https://one.example/v1', calls[0]);
        check('falls back to slot 2 when slot 1 fails', result.slot === 'fallback1', result.slot);
        check('answer is returned', result.text.includes('scene'));
        check('failure of slot 1 is recorded', result.attempts[0].ok === false && result.attempts[1].ok === true);
        check('provider key never appears in diagnostics', !JSON.stringify(result.attempts).includes('key-one-1234567890'));

        aiProviders.chat = async () => {
            throw new Error('429 rate limited');
        };
        let allFailed = null;
        try {
            await aiConfig.chatWithFailover([{ role: 'user', content: 'hi' }], { depth: 'fast' });
        } catch (err) {
            allFailed = err;
        }
        check('all failures raise ALL_PROVIDERS_FAILED', allFailed && allFailed.code === 'ALL_PROVIDERS_FAILED');
        check('failover is bounded (no infinite retries)', allFailed && allFailed.attempts.length === 2, allFailed && String(allFailed.attempts.length));

        let visionError = null;
        try {
            await aiConfig.chatWithFailover([{ role: 'user', content: 'what is this?' }], { depth: 'fast', vision: true });
        } catch (err) {
            visionError = err;
        }
        check('image with no vision slot reports NO_VISION_PROVIDER', visionError && visionError.code === 'NO_VISION_PROVIDER');

        aiConfig.saveSlot('primary', { vision: true });
        aiProviders.chat = async () => 'Ye ek bill hai.';
        const visionResult = await aiConfig.chatWithFailover(
            [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: 'what is this?' },
                        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } }
                    ]
                }
            ],
            { depth: 'fast', vision: true }
        );
        check('vision request uses the vision slot', visionResult.slot === 'primary' && visionResult.text === 'Ye ek bill hai.');

        const health = await aiConfig.testSlot('fallback1', 'hi');
        check('testSlot reports a real answer', health.ok === true && health.reply === 'Ye ek bill hai.');

        const draft = await aiConfig.testSlot('fallback2', 'hi', {
            provider: 'custom',
            baseUrl: 'https://draft.example/v1',
            model: 'model-draft',
            apiKey: 'draft-key-1234567890'
        });
        check('draft configuration can be tested before saving', draft.ok === true && draft.model === 'model-draft', draft.error);
        check(
            'draft test does not persist anything',
            !JSON.stringify(aiConfig.getSlotsPublic()).includes('draft-key-1234567890') &&
                !JSON.stringify(aiConfig.readConfig()).includes('model-draft')
        );

        aiConfig.saveSlot('fallback2', { clearKey: true });
        const noKey = await aiConfig.testSlot('fallback2', 'hi');
        check('keyless slot test fails safely', noKey.ok === false && /no API key/i.test(noKey.error || ''), noKey.error);
    } finally {
        aiProviders.chat = originalChat;
    }

    console.log(`\nAI engine: ${passed} passed, ${failed} failed`);
    if (failed) process.exitCode = 1;
}

main()
    .catch((err) => {
        console.error('TEST RUN FAILED:', err && err.stack ? err.stack : err);
        process.exitCode = 1;
    })
    .finally(() => {
        restoreAll();
    });
