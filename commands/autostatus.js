const { channelInfo } = require('../lib/messageConfig');
const isOwnerOrSudo = require('../lib/isOwner');
const statusReaction = require('../lib/statusReaction');

// Auto status view + status reactions.
//
// Configuration lives in data/autoStatus.json through lib/statusReaction, which
// also owns the configurable reaction emoji (default 💖⭐) and the actual
// reaction call. Nothing is auto-reacted unless reactOn is explicitly enabled.

// One reaction per status id, even if WhatsApp delivers the same status through
// several update shapes.
const reactedStatusIds = new Map();
const REACTED_TTL_MS = 10 * 60 * 1000;
const REACTED_MAX = 300;

function alreadyReactedTo(id) {
    const key = String(id || '').trim();
    if (!key) return false;
    const now = Date.now();
    for (const [oldId, at] of reactedStatusIds) {
        if (now - at > REACTED_TTL_MS) reactedStatusIds.delete(oldId);
        else break;
    }
    if (reactedStatusIds.has(key)) return true;
    reactedStatusIds.set(key, now);
    while (reactedStatusIds.size > REACTED_MAX) {
        reactedStatusIds.delete(reactedStatusIds.keys().next().value);
    }
    return false;
}

function reactionSummary() {
    const reaction = statusReaction.getReaction();
    const count = statusReaction.emojiCount(reaction);
    return {
        reaction,
        count,
        isDefault: reaction === statusReaction.DEFAULT_REACTION,
        reactOn: statusReaction.isReactOn()
    };
}

function reactionHelpText() {
    const summary = reactionSummary();
    return [
        '💫 *STATUS REACTION*',
        '',
        `• Emoji: ${summary.reaction}${summary.isDefault ? ' (default)' : ''}`,
        `• Emoji in value: ${summary.count}${summary.count > 1 ? ' — WhatsApp shows one emoji per reaction, so it may render only the first' : ''}`,
        `• Auto-react to every status: ${summary.reactOn ? 'ON' : 'OFF'}`,
        '',
        '*Commands*',
        '• .aistatusreaction  — show this',
        '• .aistatusreaction 💖⭐  — set the reaction',
        '• .aisetstatusreaction 💖⭐  — same as above',
        '• .aistatusreaction reset  — back to 💖⭐',
        '• .aistatusreaction on | off  — auto-react to every status',
        '',
        'For a single status, react yourself from WhatsApp; AYHA uses this emoji when it reacts automatically.'
    ].join('\n');
}

async function autoStatusCommand(sock, chatId, msg, args) {
    try {
        const senderId = msg.key.participant || msg.key.remoteJid;
        const isOwner = await isOwnerOrSudo(senderId, sock, chatId);

        if (!msg.key.fromMe && !isOwner) {
            await sock.sendMessage(chatId, {
                text: '❌ This command can only be used by the owner!',
                ...channelInfo
            });
            return;
        }

        const config = statusReaction.readConfig();
        const reaction = reactionSummary();

        if (!args || args.length === 0) {
            await sock.sendMessage(chatId, {
                text: `🔄 *Auto Status Settings*\n\n📱 *Auto Status View:* ${config.enabled ? 'enabled' : 'disabled'}\n💫 *Status Reactions:* ${config.reactOn ? 'enabled' : 'disabled'}\n💖 *Reaction emoji:* ${reaction.reaction}${reaction.isDefault ? ' (default)' : ''}\n\n*Commands:*\n.autostatus on - Enable auto status view\n.autostatus off - Disable auto status view\n.autostatus react on - Enable status reactions\n.autostatus react off - Disable status reactions\n.aistatusreaction <emoji> - Change the reaction emoji`,
                ...channelInfo
            });
            return;
        }

        const command = String(args[0] || '').toLowerCase();

        if (command === 'on') {
            statusReaction.updateConfig({ enabled: true });
            await sock.sendMessage(chatId, {
                text: '✅ Auto status view has been enabled!\nBot will now automatically view all contact statuses.',
                ...channelInfo
            });
        } else if (command === 'off') {
            statusReaction.updateConfig({ enabled: false });
            await sock.sendMessage(chatId, {
                text: '❌ Auto status view has been disabled!\nBot will no longer automatically view statuses.',
                ...channelInfo
            });
        } else if (command === 'react') {
            if (!args[1]) {
                await sock.sendMessage(chatId, {
                    text: '❌ Please specify on/off for reactions!\nUse: .autostatus react on/off',
                    ...channelInfo
                });
                return;
            }

            const reactCommand = String(args[1]).toLowerCase();
            if (reactCommand === 'on') {
                statusReaction.setReactOn(true);
                await sock.sendMessage(chatId, {
                    text: `💫 Status reactions have been enabled!\nBot will now react to status updates with ${statusReaction.getReaction()}.`,
                    ...channelInfo
                });
            } else if (reactCommand === 'off') {
                statusReaction.setReactOn(false);
                await sock.sendMessage(chatId, {
                    text: '❌ Status reactions have been disabled!\nBot will no longer react to status updates.',
                    ...channelInfo
                });
            } else {
                await sock.sendMessage(chatId, {
                    text: '❌ Invalid reaction command! Use: .autostatus react on/off',
                    ...channelInfo
                });
            }
        } else if (command === 'reaction' || command === 'emoji') {
            const value = args.slice(1).join('');
            const saved = statusReaction.setReaction(value);
            await sock.sendMessage(chatId, {
                text: saved.ok
                    ? `💫 Status reaction emoji set to ${saved.value}`
                    : `❌ ${saved.error}\nUsage: .aistatusreaction 💖⭐`,
                ...channelInfo
            });
        } else {
            await sock.sendMessage(chatId, {
                text: '❌ Invalid command! Use:\n.autostatus on/off - Enable/disable auto status view\n.autostatus react on/off - Enable/disable status reactions\n.aistatusreaction <emoji> - Change the reaction emoji',
                ...channelInfo
            });
        }
    } catch (error) {
        console.error('Error in autostatus command:', error?.message || error);
        await sock.sendMessage(chatId, {
            text: '❌ Error occurred while managing auto status!',
            ...channelInfo
        });
    }
}

/**
 * .aistatusreaction / .aisetstatusreaction
 *   (none) | show      → current emoji, mode and the multi-emoji caveat
 *   <emoji> | set <emoji>
 *   reset
 *   on | off           → auto-react to every status
 */
async function statusReactionCommand(sock, chatId, msg, rawText) {
    try {
        const senderId = msg.key.participant || msg.key.remoteJid;
        const isOwner = Boolean(msg.key.fromMe) || (await isOwnerOrSudo(senderId, sock, chatId));
        if (!isOwner) {
            await sock.sendMessage(chatId, {
                text: '❌ Only the bot owner can change the status reaction.',
                ...channelInfo
            });
            return;
        }

        const body = String(rawText || '')
            .trim()
            .replace(/^[-.]\s*(aisetstatusreaction|aistatusreaction)\b/i, '')
            .trim();
        const action = body.toLowerCase();

        if (!body || action === 'show' || action === 'status') {
            await sock.sendMessage(chatId, { text: reactionHelpText(), ...channelInfo });
            return;
        }

        if (action === 'reset' || action === 'default' || action === 'clear') {
            const result = statusReaction.resetReaction();
            await sock.sendMessage(chatId, {
                text: `✅ Status reaction reset to the default ${result.value}`,
                ...channelInfo
            });
            return;
        }

        if (action === 'on' || action === 'off') {
            statusReaction.setReactOn(action === 'on');
            await sock.sendMessage(chatId, {
                text: action === 'on'
                    ? `💫 Auto status reactions are ON — every status will get ${statusReaction.getReaction()}.`
                    : '❌ Auto status reactions are OFF — AYHA will not react to statuses.',
                ...channelInfo
            });
            return;
        }

        const value = body.replace(/^set\s+/i, '').trim();
        const saved = statusReaction.setReaction(value);
        if (!saved.ok) {
            await sock.sendMessage(chatId, {
                text: `❌ ${saved.error}\n\nExamples:\n.aistatusreaction 💖⭐\n.aistatusreaction 🔥\n.aistatusreaction reset`,
                ...channelInfo
            });
            return;
        }

        const count = statusReaction.emojiCount(saved.value);
        await sock.sendMessage(chatId, {
            text: [
                `✅ *Status reaction saved:* ${saved.value}`,
                count > 1 ? 'ℹ️ WhatsApp shows one emoji per reaction, so it may render only the first emoji.' : '',
                `Auto-react is ${statusReaction.isReactOn() ? 'ON' : 'OFF'} — enable it with \`.aistatusreaction on\`.`
            ]
                .filter(Boolean)
                .join('\n'),
            ...channelInfo
        });
    } catch (error) {
        console.error('Error in status reaction command:', error?.message || error);
        await sock.sendMessage(chatId, {
            text: '❌ Could not update the status reaction.',
            ...channelInfo
        });
    }
}

function isAutoStatusEnabled() {
    return statusReaction.readConfig().enabled;
}

function isStatusReactionEnabled() {
    return statusReaction.isReactOn();
}

// React with the configured emoji, at most once per status.
async function reactIfEnabled(sock, statusKey) {
    if (!isStatusReactionEnabled()) return { ok: false, reason: 'disabled' };
    if (!statusKey?.id) return { ok: false, reason: 'bad-key' };
    if (alreadyReactedTo(statusKey.id)) return { ok: false, reason: 'duplicate' };

    const result = await statusReaction.reactToStatus(sock, statusKey);
    if (!result.ok && !['disabled', 'duplicate'].includes(result.reason)) {
        console.error(`❌ Status reaction failed (${result.reason}): ${result.error || 'unknown error'}`);
    }
    return result;
}

// Function to handle status updates
async function handleStatusUpdate(sock, status) {
    try {
        if (!isAutoStatusEnabled()) {
            return;
        }

        // Add delay to prevent rate limiting
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // Handle status from messages.upsert
        if (status.messages && status.messages.length > 0) {
            const msg = status.messages[0];
            if (msg.key && msg.key.remoteJid === 'status@broadcast') {
                try {
                    await sock.readMessages([msg.key]);
                    await reactIfEnabled(sock, msg.key);
                } catch (err) {
                    if (err.message?.includes('rate-overlimit')) {
                        console.log('⚠️ Rate limit hit, waiting before retrying...');
                        await new Promise((resolve) => setTimeout(resolve, 2000));
                        await sock.readMessages([msg.key]);
                    } else {
                        throw err;
                    }
                }
                return;
            }
        }

        // Handle direct status updates
        if (status.key && status.key.remoteJid === 'status@broadcast') {
            try {
                await sock.readMessages([status.key]);
                await reactIfEnabled(sock, status.key);
            } catch (err) {
                if (err.message?.includes('rate-overlimit')) {
                    console.log('⚠️ Rate limit hit, waiting before retrying...');
                    await new Promise((resolve) => setTimeout(resolve, 2000));
                    await sock.readMessages([status.key]);
                } else {
                    throw err;
                }
            }
            return;
        }

        // Handle status in reactions
        if (status.reaction && status.reaction.key.remoteJid === 'status@broadcast') {
            try {
                await sock.readMessages([status.reaction.key]);
                await reactIfEnabled(sock, status.reaction.key);
            } catch (err) {
                if (err.message?.includes('rate-overlimit')) {
                    console.log('⚠️ Rate limit hit, waiting before retrying...');
                    await new Promise((resolve) => setTimeout(resolve, 2000));
                    await sock.readMessages([status.reaction.key]);
                } else {
                    throw err;
                }
            }
            return;
        }
    } catch (error) {
        console.error('❌ Error in auto status view:', error?.message || error);
    }
}

module.exports = {
    autoStatusCommand,
    statusReactionCommand,
    handleStatusUpdate,
    isAutoStatusEnabled,
    isStatusReactionEnabled,
    reactIfEnabled
};
