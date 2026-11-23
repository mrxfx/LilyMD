'use strict';

const auth = require('../lib/webAuth');
const isOwnerOrSudo = require('../lib/isOwner');
const { ownerNumbers, digits } = require('../lib/ownerNumbers');
const { getEphemeralExpiration } = require('../lib/aiAutoReply');

/**
 * .setpass <new-password>
 * Owner command to set a permanent Dashboard Password from WhatsApp.
 */
async function setpassCommand(sock, chatId, message, userMessage, senderId, rawText) {
    try {
        const sender = senderId || message?.key?.participant || message?.key?.remoteJid;
        const isPrivileged = Boolean(message?.key?.fromMe) || (await isOwnerOrSudo(sender, sock, chatId));

        // Security: reject unauthorized users without revealing anything about passwords
        if (!isPrivileged) {
            await sock.sendMessage(chatId, {
                text: '❌ This command is only available for the bot owner.'
            }, { quoted: message });
            return;
        }

        // Extract raw password preserving exact case
        const sourceText = String(
            rawText ||
            message?.message?.conversation ||
            message?.message?.extendedTextMessage?.text ||
            userMessage ||
            ''
        ).trim();

        const match = sourceText.match(/^[.-]setpass\s*(.*)$/is);
        const newPassword = match && match[1] ? match[1].trim() : '';

        if (!newPassword) {
            const usageText = [
                '🔐 *Lily MD Dashboard Password*',
                '',
                '*Usage:*',
                '• `.setpass <new-password>`',
                '',
                '*Example:*',
                '• `.setpass MyNewPass123`',
                '',
                '*Requirements:*',
                '• Minimum 8 characters',
                '• Mix letters and numbers',
                '',
                '_Note: The new password will take effect immediately for Dashboard login, and the temporary password will no longer work._'
            ].join('\n');

            await sock.sendMessage(chatId, { text: usageText }, { quoted: message });
            return;
        }

        // Determine target owner account number
        const senderDigits = digits(sender);
        const botUserDigits = digits(sock?.user?.id);
        const targetNumber = senderDigits && (await isOwnerOrSudo(sender, sock, chatId))
            ? senderDigits
            : (botUserDigits || ownerNumbers()[0]);

        // Update password securely
        const result = auth.setOwnerPassword(targetNumber, newPassword);

        if (!result.ok) {
            await sock.sendMessage(chatId, {
                text: `❌ Password rejected: ${result.error || 'Invalid password'}`
            }, { quoted: message });
            return;
        }

        // Security: Delete the command message in groups if bot has permission
        const isGroup = chatId && chatId.endsWith('@g.us');
        if (isGroup && message?.key) {
            try {
                await sock.sendMessage(chatId, { delete: message.key });
            } catch {}
        }

        let port = 5745;
        try {
            const settings = require('../settings');
            port = settings.port || Number(process.env.PORT || '5745');
        } catch {}

        const successText = [
            '🔐 *Dashboard Password Updated Successfully!* ✅',
            '',
            '• *Status:* Permanent password is now active',
            '• *Previous Password:* Temporary password has been invalidated',
            '',
            `🌐 *Login URL:* http://localhost:${port}/login`,
            '',
            '🔒 _For security, your new password is not displayed or logged._'
        ].join('\n');

        const exp = typeof getEphemeralExpiration === 'function' ? getEphemeralExpiration(message, chatId) : 0;
        const sendOptions = { quoted: message };
        if (exp > 0) sendOptions.ephemeralExpiration = exp;

        await sock.sendMessage(chatId, { text: successText }, sendOptions);
    } catch (err) {
        console.error('[setpass command error]', err?.message || err);
        try {
            await sock.sendMessage(chatId, { text: '❌ An error occurred while setting the password.' }, { quoted: message });
        } catch {}
    }
}

module.exports = setpassCommand;
