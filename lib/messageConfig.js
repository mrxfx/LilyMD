const settings = require('../settings');

// Forwarded-channel context attached to bot messages.
// Only built when NEWSLETTER_JID is configured, so an unconfigured bot never
// forwards messages to someone else's channel. Commands spread `...channelInfo`,
// so an empty object simply means "no forwarding".
const newsletterJid = settings.newsletterJid || '';

const channelInfo = newsletterJid
    ? {
        contextInfo: {
            forwardingScore: 1,
            isForwarded: true,
            forwardedNewsletterMessageInfo: {
                newsletterJid,
                newsletterName: settings.botName || 'Lily MD',
                serverMessageId: -1
            }
        }
    }
    : {};

module.exports = {
    channelInfo: channelInfo
};
