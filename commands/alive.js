const settings = require("../settings");
const { channelInfo } = require('../lib/messageConfig');
async function aliveCommand(sock, chatId, message) {
    try {
        const message1 = `*🤖 Lily MD is Active!*\n\n` +
                       `*Version:* ${settings.version}\n` +
                       `*AI Assistant:* ${settings.aiName || 'AYHA'}\n` +
                       `*Status:* Online\n` +
                       `*Mode:* Public\n\n` +
                       `*🌟 Features:*\n` +
                       `• Group Management\n` +
                       `• Antilink Protection\n` +
                       `• Fun Commands\n` +
                       `• And more!\n\n` +
                       `Type *.menu* for full command list`;

        await sock.sendMessage(chatId, {
            text: message1,
            ...channelInfo
        }, { quoted: message });
    } catch (error) {
        console.error('Error in alive command:', error);
        await sock.sendMessage(chatId, { text: 'Bot is alive and running!' }, { quoted: message });
    }
}

module.exports = aliveCommand;