'use strict';

const vision = require('../lib/vision');
const isOwnerOrSudo = require('../lib/isOwner');
const { getEphemeralExpiration } = require('../lib/aiAutoReply');

/**
 * .vision on | .vision off | .vision status
 * WhatsApp Owner/Admin Command for Lily MD Image Vision
 */
async function visionCommand(sock, chatId, message, userMessage, senderId) {
    try {
        const sender = senderId || message?.key?.participant || message?.key?.remoteJid;
        const isPrivileged = message?.key?.fromMe || (await isOwnerOrSudo(sender, sock, chatId));

        if (!isPrivileged) {
            await sock.sendMessage(chatId, { text: '❌ This command is only available for the owner or sudo!' }, { quoted: message });
            return;
        }

        const args = String(userMessage || '').trim().split(/\s+/).slice(1);
        const sub = (args[0] || 'status').toLowerCase();

        let responseText = '';

        if (sub === 'on' || sub === 'enable' || sub === '1') {
            vision.setEnabled(true);
            responseText = [
                '👁️ *Image Vision Enabled*',
                '',
                '• *Status:* Active (ON)',
                `• *Primary Model:* ${vision.PRIMARY_MODEL}`,
                `• *Fallback Model:* ${vision.FALLBACK_MODEL}`,
                '',
                'Incoming WhatsApp images will now be analyzed with Google Gemini.'
            ].join('\n');
        } else if (sub === 'off' || sub === 'disable' || sub === '0') {
            vision.setEnabled(false);
            responseText = [
                '👁️ *Image Vision Disabled*',
                '',
                '• *Status:* Inactive (OFF)',
                `• *Primary Model:* ${vision.PRIMARY_MODEL}`,
                `• *Fallback Model:* ${vision.FALLBACK_MODEL}`,
                '',
                'Image analysis is currently turned off.'
            ].join('\n');
        } else if (sub === 'status' || !args.length) {
            const st = vision.getStatus();
            responseText = [
                '👁️ *Image Vision Status*',
                '',
                `• *Status:* ${st.enabled ? 'Active (ON) 🟢' : 'Inactive (OFF) 🔴'}`,
                `• *Primary Model:* ${st.primaryModel}`,
                `• *Fallback Model:* ${st.fallbackModel}`,
                `• *API Key:* ${st.hasKey ? 'Configured ✅' : 'Not configured ⚠️'}`,
                '',
                '*Commands:*',
                '• `.vision on` — Enable image vision',
                '• `.vision off` — Disable image vision',
                '• `.vision status` — Show current status'
            ].join('\n');
        } else {
            responseText = [
                '👁️ *Lily MD Image Vision*',
                '',
                'Usage:',
                '• `.vision on` — Turn ON image vision',
                '• `.vision off` — Turn OFF image vision',
                '• `.vision status` — Check current status & models'
            ].join('\n');
        }

        const exp = typeof getEphemeralExpiration === 'function' ? getEphemeralExpiration(message, chatId) : 0;
        const sendOptions = { quoted: message };
        if (exp > 0) sendOptions.ephemeralExpiration = exp;

        await sock.sendMessage(chatId, { text: responseText }, sendOptions);
    } catch (err) {
        console.error('[vision command]', err?.message || err);
        await sock.sendMessage(chatId, { text: '❌ Failed to update vision setting.' }, { quoted: message });
    }
}

module.exports = visionCommand;
