const atlas = require('../lib/atlasApi');
const { channelInfo } = require('../lib/messageConfig');

// Atlas-MD's anime reaction pack: one command per reaction, animated GIFs from
// Tenor through the Atlas API layer.
const REACTIONS = Object.keys(atlas.REACTIONS);

function displayName(jid) {
    return `@${String(jid || '').split('@')[0]}`;
}

async function reactionCommand(sock, chatId, message, type) {
    const reaction = String(type || '').toLowerCase();

    if (!REACTIONS.includes(reaction)) {
        return sock.sendMessage(chatId, {
            text: `Usage: .<reaction>\nAvailable: ${REACTIONS.map((name) => `.${name}`).join(', ')}`,
            ...channelInfo
        }, { quoted: message });
    }

    try {
        await sock.sendMessage(chatId, { react: { text: '✨', key: message.key } });

        const gif = await atlas.reaction(reaction);
        if (!gif?.url) {
            return sock.sendMessage(chatId, {
                text: '❌ No reaction GIF found. Try again.',
                ...channelInfo
            }, { quoted: message });
        }

        // Whoever triggered the command, or the quoted user when replying
        const quotedParticipant = message.message?.extendedTextMessage?.contextInfo?.participant;
        const sender = message.key.participant || message.key.remoteJid;
        const target = quotedParticipant || sender;
        const caption = `${displayName(target)} *${reaction}s*`;

        const payload = gif.isVideo
            ? { video: { url: gif.url }, gifPlayback: true, caption, mentions: [target] }
            : { image: { url: gif.url }, caption, mentions: [target] };

        await sock.sendMessage(chatId, { ...payload, ...channelInfo }, { quoted: message });
    } catch (err) {
        console.error('[reactions]', reaction, err?.message || err);
        await sock.sendMessage(chatId, {
            text: '❌ Could not fetch that reaction right now.',
            ...channelInfo
        }, { quoted: message });
    }
}

module.exports = { reactionCommand, REACTIONS };
