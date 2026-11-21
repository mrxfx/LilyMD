'use strict';
/**
 * Offline tests for the custom status reaction (no network, no node_modules):
 *
 *   node scripts/test-status-reaction.js
 *
 * Covers emoji validation, persistence, reset, the react-on switch, both
 * supported Baileys send paths, failure reporting and duplicate-proof payloads.
 * data/autoStatus.json is restored afterwards.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CONFIG = path.join(ROOT, 'data', 'autoStatus.json');

let passed = 0;
let failed = 0;
let previous = null;

function check(name, condition, detail) {
    if (condition) {
        passed += 1;
        console.log(`  ✓ ${name}`);
    } else {
        failed += 1;
        console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
    }
}

function makeSock({ failSend = false, failRelay = false } = {}) {
    const calls = [];
    return {
        calls,
        user: { id: '916033352400:12@s.whatsapp.net' },
        async sendMessage(jid, content, options) {
            calls.push({ via: 'sendMessage', jid, content, options });
            if (failSend) throw new Error('send failed');
        },
        async relayMessage(jid, content, options) {
            calls.push({ via: 'relayMessage', jid, content, options });
            if (failRelay) throw new Error('relay failed');
        }
    };
}

const STATUS_KEY = { remoteJid: 'status@broadcast', id: 'ABC123', participant: '916033271400@s.whatsapp.net' };

async function main() {
    previous = fs.existsSync(CONFIG) ? fs.readFileSync(CONFIG, 'utf8') : null;
    const statusReaction = require('../lib/statusReaction');

    console.log('\nReaction value');
    statusReaction.updateConfig({ statusReaction: statusReaction.DEFAULT_REACTION, reactOn: false });
    check('default reaction is 💖⭐', statusReaction.getReaction() === '💖⭐', statusReaction.getReaction());
    check('emoji count counts two emoji', statusReaction.emojiCount('💖⭐') === 2, String(statusReaction.emojiCount('💖⭐')));
    check('single emoji counts once', statusReaction.emojiCount('🔥') === 1);
    check('single emoji accepted', statusReaction.normaliseReaction('🔥').ok === true);
    check('multi emoji accepted', statusReaction.normaliseReaction('💖⭐').ok === true);
    check('skin-tone emoji accepted', statusReaction.normaliseReaction('👍🏽').ok === true);
    check('ZWJ emoji accepted', statusReaction.normaliseReaction('🏳️‍🌈').ok === true);
    check('words rejected', statusReaction.normaliseReaction('heart').ok === false);
    check('empty rejected', statusReaction.normaliseReaction('   ').ok === false);
    check('spaces rejected', statusReaction.normaliseReaction('💖 ⭐').ok === false);
    check('over-long value rejected', statusReaction.normaliseReaction('💖'.repeat(40)).ok === false);

    console.log('\nSet / view / reset');
    check('set reaction persists', statusReaction.setReaction('🔥').ok && statusReaction.getReaction() === '🔥', statusReaction.getReaction());
    const onDisk = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
    check('reaction stored in data/autoStatus.json', onDisk.statusReaction === '🔥');
    check('invalid set leaves the saved value', statusReaction.setReaction('fire').ok === false && statusReaction.getReaction() === '🔥');
    check('reset restores the default', statusReaction.resetReaction().ok && statusReaction.getReaction() === '💖⭐');

    console.log('\nLibrary support + auto-react switch');
    check('unsupported without a socket', statusReaction.supportsCustomStatusReaction(null).supported === false);
    check('unsupported for an empty object', statusReaction.supportsCustomStatusReaction({}).supported === false);
    check('supported for a Baileys-like socket', statusReaction.supportsCustomStatusReaction(makeSock()).supported === true);
    statusReaction.setReactOn(false);
    const disabledSock = makeSock();
    const disabled = await statusReaction.reactToStatus(disabledSock, STATUS_KEY);
    check('does not react unless enabled', disabled.ok === false && disabled.reason === 'disabled' && disabledSock.calls.length === 0);
    check('reactOn flag persists', statusReaction.updateConfig({ reactOn: true }).reactOn === true && statusReaction.isReactOn() === true);

    console.log('\nReaction sending');
    statusReaction.setReaction('💖⭐');
    const sock = makeSock();
    const sent = await statusReaction.reactToStatus(sock, STATUS_KEY);
    check('reacts through sendMessage', sent.ok === true && sent.via === 'sendMessage', sent.error);
    check('configured emoji is used, not the old 💚', sock.calls[0].content.react.text === '💖⭐', sock.calls[0].content.react.text);
    check('reaction key targets status@broadcast', sock.calls[0].content.react.key.remoteJid === 'status@broadcast' && sock.calls[0].content.react.key.id === 'ABC123');
    check('statusJidList includes the author', sock.calls[0].options.statusJidList.includes('916033271400@s.whatsapp.net'));
    check('statusJidList includes our own id', sock.calls[0].options.statusJidList.includes('916033352400:12@s.whatsapp.net'), sock.calls[0].options.statusJidList.join(','));

    statusReaction.setReaction('🔥');
    const single = makeSock();
    await statusReaction.reactToStatus(single, STATUS_KEY);
    check('a single custom emoji is sent exactly', single.calls[0].content.react.text === '🔥');

    const relayOnly = makeSock({ failSend: true });
    const relayed = await statusReaction.reactToStatus(relayOnly, STATUS_KEY);
    check('falls back to relayMessage', relayed.ok === true && relayed.via === 'relayMessage', relayed.error);
    check('relay payload carries the custom emoji', relayOnly.calls[1].content.reactionMessage.text === '🔥');

    const broken = makeSock({ failSend: true, failRelay: true });
    const failedResult = await statusReaction.reactToStatus(broken, STATUS_KEY);
    check('both methods failing is reported, not hidden', failedResult.ok === false && failedResult.reason === 'failed', failedResult.reason);
    check('failure detail mentions both attempts', /sendMessage/.test(failedResult.error) && /relayMessage/.test(failedResult.error));

    const missingId = await statusReaction.reactToStatus(makeSock(), { remoteJid: 'status@broadcast', participant: '916033271400@s.whatsapp.net' });
    check('missing status id rejected', missingId.ok === false && missingId.reason === 'bad-key');
    const badAuthor = await statusReaction.reactToStatus(makeSock(), { remoteJid: 'status@broadcast', id: 'X', participant: 'status@broadcast' });
    check('unknown author rejected', badAuthor.ok === false && badAuthor.reason === 'bad-key');
    const noSocket = await statusReaction.reactToStatus({}, STATUS_KEY);
    check('unsupported library is reported, not simulated', noSocket.ok === false && noSocket.reason === 'unsupported');

    console.log(`\nStatus reaction: ${passed} passed, ${failed} failed`);
    if (failed) process.exitCode = 1;
}

main()
    .catch((err) => {
        console.error('TEST RUN FAILED:', err && err.stack ? err.stack : err);
        process.exitCode = 1;
    })
    .finally(() => {
        try {
            if (previous === null) {
                if (fs.existsSync(CONFIG)) fs.unlinkSync(CONFIG);
            } else {
                fs.writeFileSync(CONFIG, previous);
            }
        } catch (err) {
            console.error('restore failed:', err.message);
        }
    });
