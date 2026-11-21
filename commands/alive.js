const fs = require('fs');
const path = require('path');
const settings = require('../settings');
const { channelInfo } = require('../lib/messageConfig');

async function aliveCommand(sock, chatId, message) {
    const logoPath = path.join(process.cwd(), 'assets', 'bot_image.png');

    const caption =
        `╭───「 🌸 *LILY MD* 」───╮\n` +
        `│\n` +
        `│  ✨ *I'm online and ready!*\n` +
        `│\n` +
        `├─ *Version:* ${settings.version || 'Latest'}\n` +
        `├─ *AI:* ${settings.aiName || 'AYHA'}\n` +
        `├─ *Status:* Connected 🟢\n` +
        `├─ *Mode:* Public\n` +
        `│\n` +
        `├─ *Features*\n` +
        `│  ├ Group Management\n` +
        `│  ├ Anti-link Protection\n` +
        `│  ├ AI Assistant\n` +
        `│  └ Fun & Utility Commands\n` +
        `│\n` +
        `╰───「 Type *.menu* 」───╯\n` +
        `_Powered by Lily MD_`;

    try {
        if (fs.existsSync(logoPath)) {
            await sock.sendMessage(
                chatId,
                {
                    image: fs.readFileSync(logoPath),
                    caption,
                    ...channelInfo
                },
                { quoted: message }
            );
        } else {
            await sock.sendMessage(
                chatId,
                { text: caption, ...channelInfo },
                { quoted: message }
            );
        }
    } catch (error) {
        console.error('Alive command error:', error);

        await sock.sendMessage(
            chatId,
            { text: '🌸 *Lily MD is online!*', ...channelInfo },
            { quoted: message }
        );
    }
}

module.exports = aliveCommand;