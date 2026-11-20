const settings = require('../settings');
const { channelInfo } = require('../lib/messageConfig');

async function websiteCommand(sock, chatId, message) {
    const url = String(settings.websiteUrl || '').trim();

    if (!url) {
        return sock.sendMessage(chatId, {
            text: '🌐 No website is connected yet.\n\nSet `WEBSITE_URL` in your .env (or hosting panel) to your site address.',
            ...channelInfo
        }, { quoted: message });
    }

    return sock.sendMessage(chatId, {
        text: `🌐 *${settings.botName || 'Lily MD'}*\n\n${url}\n\nCommands, features and the pairing page live there.`,
        ...channelInfo
    }, { quoted: message });
}

module.exports = websiteCommand;
