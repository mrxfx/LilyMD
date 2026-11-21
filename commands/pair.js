const { channelInfo } = require('../lib/messageConfig');
const { startPairing } = require('../lib/webApp');
const { sleep } = require('../lib/myfunc');

const CODE_WAIT_MS = 90 * 1000; // time WhatsApp allows for entering the code
const SESSION_WAIT_MS = 4 * 60 * 1000; // time to finish linking and get the session

async function waitForCode(job) {
    const deadline = Date.now() + CODE_WAIT_MS;
    while (Date.now() < deadline) {
        if (job.code) return job.code;
        if (job.status === 'error') throw new Error(job.error || 'Pairing failed');
        await sleep(1500);
    }
    throw new Error('Timed out waiting for a pairing code');
}

async function waitForSession(job) {
    const deadline = Date.now() + SESSION_WAIT_MS;
    while (Date.now() < deadline) {
        if (job.sessionId) return job.sessionId;
        if (job.status === 'error') throw new Error(job.error || 'Pairing failed');
        await sleep(2000);
    }
    return null;
}

async function pairCommand(sock, chatId, message, q) {
    try {
        // A session backup is full access to the linked account: owner only, and
        // never in a group where other members could read it.
        if (String(chatId).endsWith('@g.us')) {
            return await sock.sendMessage(chatId, {
                text: '🔐 Pairing and session backups are private. Run `.pair` in a direct chat with the bot.',
                ...channelInfo
            });
        }
        const senderId = message?.key?.participant || message?.key?.remoteJid || chatId;
        if (!message?.key?.fromMe) {
            const isOwnerOrSudo = require('../lib/isOwner');
            if (!(await isOwnerOrSudo(senderId, sock, chatId))) {
                return await sock.sendMessage(chatId, {
                    text: '🔐 Only the bot owner can pair another device.',
                    ...channelInfo
                });
            }
        }

        if (!q) {
            return await sock.sendMessage(chatId, {
                text: 'Please provide a valid WhatsApp number\nExample: .pair 91702395XXXX',
                ...channelInfo
            });
        }

        const numbers = q
            .split(',')
            .map((value) => value.replace(/[^0-9]/g, ''))
            .filter((value) => value.length > 5 && value.length < 20);

        if (numbers.length === 0) {
            return await sock.sendMessage(chatId, {
                text: 'Invalid number❌️ Please use the correct format!',
                ...channelInfo
            });
        }

        for (const number of numbers) {
            const whatsappID = number + '@s.whatsapp.net';
            const result = await sock.onWhatsApp(whatsappID);

            if (!result?.[0]?.exists) {
                await sock.sendMessage(chatId, {
                    text: 'That number is not registered on WhatsApp❗️',
                    ...channelInfo
                });
                continue;
            }

            await sock.sendMessage(chatId, { text: 'Wait a moment for the code', ...channelInfo });

            // Local pairing: no third-party API, same engine as the website
            const job = startPairing(number);
            try {
                const code = await waitForCode(job);
                await sock.sendMessage(chatId, {
                    text: `Your pairing code: *${code}*\n\nOpen WhatsApp → Linked devices → Link a device → Link with phone number instead.\n\nThe code expires in about a minute; I'll send the SESSION_ID here once you confirm.`,
                    ...channelInfo
                });

                const sessionId = await waitForSession(job);
                if (!sessionId) {
                    await sock.sendMessage(chatId, {
                        text: '⌛ Pairing was not confirmed in time. Run `.pair` again.',
                        ...channelInfo
                    });
                    continue;
                }

                await sock.sendMessage(chatId, {
                    text: `✅ Linked.\n\nPaste this into \`SESSION_ID\` on your host. Keep it private — it is full access to that WhatsApp account.\n\n${sessionId}`,
                    ...channelInfo
                });
                await sock.sendMessage(
                    chatId,
                    {
                        document: Buffer.from(sessionId),
                        mimetype: 'text/plain',
                        fileName: `lily-md-session-${number}.txt`,
                        caption: 'Lily MD session backup'
                    },
                    { quoted: message }
                );
            } catch (pairError) {
                console.error('[pair]', pairError?.message || pairError);
                await sock.sendMessage(chatId, {
                    text: `Failed to pair: ${pairError?.message || 'unknown error'}. Please try again later.`,
                    ...channelInfo
                });
            }
        }
    } catch (error) {
        console.error('[pair]', error);
        await sock.sendMessage(chatId, {
            text: 'An error occurred. Please try again later.',
            ...channelInfo
        });
    }
}

module.exports = pairCommand;
