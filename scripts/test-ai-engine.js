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

    console.log('\nAI Provider Architecture & Key/Model/Provider Failover (Section 8)');
    aiConfig.clearCooldowns();
    const originalChat2 = aiProviders.chat;
    try {
        // 1. Supported active providers
        check('active providers limited to gemini, groq, custom',
            aiProviders.PROVIDER_IDS.length === 3 &&
            aiProviders.PROVIDER_IDS.includes('gemini') &&
            aiProviders.PROVIDER_IDS.includes('groq') &&
            aiProviders.PROVIDER_IDS.includes('custom')
        );

        // 2. Multiple Groq API keys with one model
        aiConfig.setModels('groq', ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'openai/gpt-oss-20b']);
        const gKey1 = aiConfig.addKey('groq', 'gsk_test_groq_key_1_abcdef123456', { model: 'openai/gpt-oss-120b', label: 'groq-key-1' });
        const gKey2 = aiConfig.addKey('groq', 'gsk_test_groq_key_2_abcdef123456', { model: 'openai/gpt-oss-120b', label: 'groq-key-2' });
        const gKey3 = aiConfig.addKey('groq', 'gsk_test_groq_key_3_abcdef123456', { model: 'openai/gpt-oss-120b', label: 'groq-key-3' });
        check('multiple groq keys added', gKey1.ok && gKey2.ok && gKey3.ok);

        const groqPublic = aiConfig.getKeysPublic('groq');
        check('groq keys stored with masked representations',
            groqPublic.length >= 3 &&
            groqPublic.every((k) => k.maskedKey.includes('…') && !k.maskedKey.includes('abcdef123456'))
        );

        // 3. Multiple Gemini API keys
        const gemKey1 = aiConfig.addKey('gemini', 'AIzaSyGeminiTestKey1_abcdef123456', { label: 'gemini-key-1' });
        const gemKey2 = aiConfig.addKey('gemini', 'AIzaSyGeminiTestKey2_abcdef123456', { label: 'gemini-key-2' });
        check('multiple gemini keys added', gemKey1.ok && gemKey2.ok);

        // 4. Multiple Custom API keys
        aiConfig.setBaseUrl('custom', 'https://api.custom-ai.example/v1');
        aiConfig.addModel('custom', 'llama-3.3-70b');
        const cKey1 = aiConfig.addKey('custom', 'sk-custom-key-1-abcdef123456', { model: 'llama-3.3-70b', label: 'custom-key-1' });
        const cKey2 = aiConfig.addKey('custom', 'sk-custom-key-2-abcdef123456', { model: 'llama-3.3-70b', label: 'custom-key-2' });
        check('multiple custom keys added', cKey1.ok && cKey2.ok);

        // 5. Automatic key rotation after HTTP 429
        aiConfig.clearCooldowns();
        aiConfig.setPriority(['groq', 'gemini', 'custom']);
        const invokedKeys = [];
        aiProviders.chat = async (messages, options) => {
            invokedKeys.push(options.apiKey);
            if (options.apiKey === 'gsk_test_groq_key_1_abcdef123456') {
                const err = new Error('Rate limit reached: 429 Too Many Requests (TPM exceeded)');
                err.status = 429;
                throw err;
            }
            if (options.apiKey === 'gsk_test_groq_key_2_abcdef123456') {
                return 'Rotated to key 2 successfully!';
            }
            return 'Default reply';
        };

        const rotateResult = await aiConfig.chatWithFailover([{ role: 'user', content: 'test rotation' }], { depth: 'fast' });
        check('key 1 was attempted first', invokedKeys[0] === 'gsk_test_groq_key_1_abcdef123456');
        check('automatically rotated to key 2 on 429', invokedKeys.includes('gsk_test_groq_key_2_abcdef123456'));
        check('successful reply returned after key rotation', rotateResult.text === 'Rotated to key 2 successfully!');
        const key1Status = aiConfig.getKeysPublic('groq').find((k) => k.id === gKey1.id);
        check('rate-limited key is marked coolingDown', key1Status && key1Status.coolingDown === true);

        // 6. Strict model preservation: all keys for Model 1 fail -> does NOT switch to Model 2 of the same provider
        aiConfig.clearCooldowns();
        aiConfig.setPriority(['groq', 'gemini', 'custom']);
        const modelCalls = [];
        aiProviders.chat = async (messages, options) => {
            modelCalls.push({ provider: options.provider, model: options.model, key: options.apiKey });
            if (options.provider === 'groq') {
                const err = new Error('Groq model rate limited (429)');
                err.status = 429;
                throw err;
            }
            if (options.provider === 'gemini') {
                return 'Gemini provider fallback succeeded!';
            }
            return 'Other model reply';
        };

        const strictModelResult = await aiConfig.chatWithFailover([{ role: 'user', content: 'test strict model' }], { depth: 'fast' });
        check('Groq selected model attempted', modelCalls.some((c) => c.provider === 'groq'));
        check('Never switch to Model 2 of the same provider automatically', !modelCalls.some((c) => c.provider === 'groq' && c.model === 'qwen/qwen3.8-27b'));
        check('Fell back to Gemini provider when Groq model keys failed', modelCalls.some((c) => c.provider === 'gemini'));
        check('Gemini fallback returned response', strictModelResult.text === 'Gemini provider fallback succeeded!');

        // 7. Manual model selection (selectModel)
        aiConfig.clearCooldowns();
        const selRes = aiConfig.selectModel('groq', 2);
        check('manually selected Groq Model 2', selRes.ok && selRes.selectedModel === 2);
        const groqSel = aiConfig.getSelectedModel('groq');
        check('getSelectedModel reports Model 2', groqSel.selectedModel === 2 && groqSel.modelId === 'qwen/qwen3.8-27b');

        const manualModelCalls = [];
        aiProviders.chat = async (messages, options) => {
            manualModelCalls.push({ provider: options.provider, model: options.model });
            return 'Model 2 reply ok';
        };
        const manualModelResult = await aiConfig.chatWithFailover([{ role: 'user', content: 'test manual model' }], { depth: 'fast' });
        check('manual model request used Model 2 ID', manualModelCalls[0].model === 'qwen/qwen3.8-27b');
        check('manual model response returned', manualModelResult.text === 'Model 2 reply ok');
        aiConfig.selectModel('groq', 1);

        // 8. Independent 3 Providers × 4 Models × 4 Shared Keys architecture
        const allOverview = aiConfig.getAllProvidersOverview();
        check('3 independent providers in overview', allOverview.providers.length === 3);
        check('each provider has 4 model slots', allOverview.providers.every((p) => p.models.length === 4));
        check('each provider has 4 shared key slots', allOverview.providers.every((p) => p.keys.length === 4));

        // Shared key pool: setting key works across all models of the provider
        const setKeyRes = aiConfig.setKeySlot('gemini', 1, 'AIzaSy_Gemini_Shared_K1_TestKey123456');
        check('setKeySlot succeeds for gemini shared key 1', setKeyRes.ok === true && setKeyRes.keyIndex === 1);
        const getKeyRes = aiConfig.getKeySlot('gemini', 1);
        check('getKeySlot masks key properly', getKeyRes.configured === true && getKeyRes.maskedKey.startsWith('AIza'));
        check('key does not leak full secret', !getKeyRes.maskedKey.includes('TestKey123456'));

        const setModelRes = aiConfig.setModelId('custom', 1, 'meta-llama/llama-3.3-70b-instruct');
        check('setModelId succeeds for custom M1', setModelRes.ok === true && setModelRes.modelId === 'meta-llama/llama-3.3-70b-instruct');

        // Verify changing model does NOT change keys
        const initialKeys = aiConfig.getProviderOverview('gemini').keys.map((k) => k.maskedKey);
        aiConfig.selectModel('gemini', 2);
        const keysAfterModelChange = aiConfig.getProviderOverview('gemini').keys.map((k) => k.maskedKey);
        check('switching model preserves shared key pool', JSON.stringify(initialKeys) === JSON.stringify(keysAfterModelChange));
        aiConfig.selectModel('gemini', 1);

        // 9. Key Stickiness (remembers last successful key across calls)
        aiConfig.clearCooldowns();
        aiConfig.setKeySlot('groq', 1, 'gsk_stickiness_key_1_abcdef123456');
        aiConfig.setKeySlot('groq', 2, 'gsk_stickiness_key_2_abcdef123456');
        const stickinessCalls = [];
        aiProviders.chat = async (messages, options) => {
            stickinessCalls.push(options.apiKey);
            if (options.apiKey === 'gsk_stickiness_key_1_abcdef123456') {
                const err = new Error('Rate limit reached: 429');
                err.status = 429;
                throw err;
            }
            return 'Stickiness reply';
        };

        await aiConfig.chatWithFailover([{ role: 'user', content: 'stickiness 1' }], { depth: 'fast' });
        check('turn 1 rotated from key 1 to key 2', stickinessCalls[0] === 'gsk_stickiness_key_1_abcdef123456' && stickinessCalls[1] === 'gsk_stickiness_key_2_abcdef123456');

        stickinessCalls.length = 0;
        await aiConfig.chatWithFailover([{ role: 'user', content: 'stickiness 2' }], { depth: 'fast' });
        check('turn 2 started directly with sticky key 2', stickinessCalls[0] === 'gsk_stickiness_key_2_abcdef123456');

        // 10. Provider fallback when all keys for Groq fail
        aiConfig.clearCooldowns();
        aiConfig.setPriority(['groq', 'gemini', 'custom']);
        const providerCalls = [];
        aiProviders.chat = async (messages, options) => {
            providerCalls.push(options.provider);
            if (options.provider === 'groq') {
                const err = new Error('Groq provider unavailable (429)');
                err.status = 429;
                throw err;
            }
            if (options.provider === 'gemini') {
                return 'Gemini provider fallback succeeded!';
            }
            return 'Other provider';
        };

        const provFallbackResult = await aiConfig.chatWithFailover([{ role: 'user', content: 'test provider fallback' }], { depth: 'fast' });
        check('groq attempted before gemini in priority', providerCalls[0] === 'groq');
        check('fell back to gemini provider', providerCalls.includes('gemini'));
        check('gemini reply received', provFallbackResult.text === 'Gemini provider fallback succeeded!');

        // 11. Dynamic Provider Priority
        aiConfig.setPriority(['custom', 'gemini', 'groq']);
        check('priority order changed', aiConfig.getPriority().join(',') === 'custom,gemini,groq');
        providerCalls.length = 0;
        aiProviders.chat = async (messages, options) => {
            providerCalls.push(options.provider);
            return 'Custom provider reply';
        };
        const customPrioResult = await aiConfig.chatWithFailover([{ role: 'user', content: 'test custom priority' }], { depth: 'fast' });
        check('custom provider attempted first with updated priority', providerCalls[0] === 'custom');
        check('custom priority reply returned', customPrioResult.text === 'Custom provider reply');

        // 9. Invalid API key handling (401 does not put key in 429 rate-limit cooldown)
        aiConfig.clearCooldowns();
        aiConfig.setPriority(['groq', 'gemini', 'custom']);
        const invalidKeyCalls = [];
        aiProviders.chat = async (messages, options) => {
            invalidKeyCalls.push(options.apiKey);
            if (options.apiKey === 'gsk_test_groq_key_1_abcdef123456') {
                const err = new Error('401 Unauthorized: Invalid API Key');
                err.status = 401;
                throw err;
            }
            return 'Valid key reply';
        };
        await aiConfig.chatWithFailover([{ role: 'user', content: 'test invalid key' }], { depth: 'fast' });
        const key1StatusAfter401 = aiConfig.getKeysPublic('groq').find((k) => k.id === gKey1.id);
        check('invalid key (401) is not placed in rate-limit cooldown', key1StatusAfter401 && key1StatusAfter401.coolingDown === false);

        // 10. Key testing (.aiprovider test <provider> <key-id>)
        aiProviders.chat = async () => 'Test key response ok';
        const keyTestRes = await aiConfig.testKey('groq', gKey2.id);
        check('testKey succeeds with key-id', keyTestRes.ok === true && keyTestRes.reply === 'Test key response ok');
        check('testKey masks raw key', keyTestRes.maskedKey.includes('…'));

        // Explicit Verification of All 9 Scenarios:
        // Scenario 1: One Groq model + one Groq key
        aiConfig.clearCooldowns();
        aiConfig.selectModel('groq', 1);
        const s1Calls = [];
        aiProviders.chat = async (messages, options) => {
            s1Calls.push({ model: options.model, key: options.apiKey });
            return 'Scenario 1 reply';
        };
        const s1Res = await aiConfig.chatWithFailover([{ role: 'user', content: 'test s1' }], { depth: 'fast' });
        check('Scenario 1: One model + one key functions cleanly', s1Res.text === 'Scenario 1 reply' && s1Calls.length === 1);

        // Scenario 2: Four Groq models + one shared Groq key
        aiConfig.setKeySlot('groq', 2, '');
        aiConfig.setKeySlot('groq', 3, '');
        aiConfig.setKeySlot('groq', 4, '');
        aiConfig.selectModel('groq', 4);
        const s2Calls = [];
        aiProviders.chat = async (messages, options) => {
            s2Calls.push({ model: options.model, key: options.apiKey });
            return 'Scenario 2 reply';
        };
        const s2Res = await aiConfig.chatWithFailover([{ role: 'user', content: 'test s2' }], { depth: 'fast' });
        check('Scenario 2: Four models + one shared key uses shared key on Model 4', s2Calls[0].key.startsWith('gsk_') && s2Res.text === 'Scenario 2 reply');

        // Scenario 3: Four Groq models + four shared Groq keys
        aiConfig.setKeySlot('groq', 1, 'gsk_shared_groq_key_1_123456');
        aiConfig.setKeySlot('groq', 2, 'gsk_shared_groq_key_2_123456');
        aiConfig.setKeySlot('groq', 3, 'gsk_shared_groq_key_3_123456');
        aiConfig.setKeySlot('groq', 4, 'gsk_shared_groq_key_4_123456');
        const s3Overview = aiConfig.getProviderOverview('groq');
        check('Scenario 3: Four models + four shared keys loaded', s3Overview.models.length === 4 && s3Overview.totalKeys === 4);

        // Scenario 4: Key 1 reaches rate limit and Key 2 succeeds on same selected model
        aiConfig.clearCooldowns();
        aiConfig.selectModel('groq', 1);
        const s4Calls = [];
        aiProviders.chat = async (messages, options) => {
            s4Calls.push({ model: options.model, key: options.apiKey });
            if (options.apiKey === 'gsk_shared_groq_key_1_123456') {
                const err = new Error('Rate limit: 429');
                err.status = 429;
                throw err;
            }
            return 'Key 2 succeeded';
        };
        const s4Res = await aiConfig.chatWithFailover([{ role: 'user', content: 'test s4' }], { depth: 'fast' });
        check('Scenario 4: Key 1 rate limit rotates to Key 2 on SAME model', s4Res.text === 'Key 2 succeeded' && s4Calls[0].model === s4Calls[1].model);

        // Scenario 5: All four keys fail
        aiConfig.clearCooldowns();
        const s5Calls = [];
        aiProviders.chat = async (messages, options) => {
            s5Calls.push({ provider: options.provider, key: options.apiKey });
            const err = new Error('Quota exceeded 429');
            err.status = 429;
            throw err;
        };
        let s5Failed = false;
        try {
            await aiConfig.chatWithFailover([{ role: 'user', content: 'test s5' }], { depth: 'fast' });
        } catch (e) {
            s5Failed = true;
        }
        check('Scenario 5: All keys fail raises error / handles gracefully', s5Failed === true);

        // Scenario 6: Changing selected model does not change key pool
        const s6KeysBefore = aiConfig.getProviderOverview('groq').keys.map((k) => k.maskedKey);
        aiConfig.selectModel('groq', 3);
        const s6KeysAfter = aiConfig.getProviderOverview('groq').keys.map((k) => k.maskedKey);
        check('Scenario 6: Changing selected model preserves key pool exactly', JSON.stringify(s6KeysBefore) === JSON.stringify(s6KeysAfter));

        // Scenario 7: Gemini and Custom use independent key pools
        aiConfig.setKeySlot('gemini', 1, 'AIzaSy_Gemini_Only_Key_123456');
        aiConfig.setKeySlot('custom', 1, 'sk-custom-only-key-123456');
        const groqPool = aiConfig.getProviderOverview('groq').keys.map(k => k.maskedKey);
        const geminiPool = aiConfig.getProviderOverview('gemini').keys.map(k => k.maskedKey);
        const customPool = aiConfig.getProviderOverview('custom').keys.map(k => k.maskedKey);
        check('Scenario 7: Gemini and Custom use independent key pools', !groqPool.includes(geminiPool[0]) && !geminiPool.includes(customPool[0]));

        // Scenario 8: Restarting the bot preserves all settings
        aiConfig.selectModel('groq', 2);
        const storeAfter = aiConfig.readKeys();
        check('Scenario 8: Settings persisted to file store for restarts', storeAfter.providers.groq.selectedModel === 2);

        // Scenario 9: No API key appears in status cards or messages
        const groqCard = aiConfig.getProviderOverview('groq');
        const cardText = JSON.stringify(groqCard);
        check('Scenario 9: No raw API key appears in status or overview', !cardText.includes('123456'));

        // Clean up test keys
        aiConfig.removeKey('groq', gKey1.id);
        aiConfig.removeKey('groq', gKey2.id);
        aiConfig.removeKey('groq', gKey3.id);
        aiConfig.removeKey('gemini', gemKey1.id);
        aiConfig.removeKey('gemini', gemKey2.id);
        aiConfig.removeKey('custom', cKey1.id);
        aiConfig.removeKey('custom', cKey2.id);
    } finally {
        aiProviders.chat = originalChat2;
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
