'use strict';

const { isSudo } = require('./index');
const { ownerNumbers, digits } = require('./ownerNumbers');
const { buildComparableIds } = require('./jidHelper');

const PHONE_SERVERS = new Set(['s.whatsapp.net', 'c.us', 'hosted']);

function jidServer(jid) {
    const value = String(jid || '');
    return value.includes('@') ? value.slice(value.lastIndexOf('@') + 1) : '';
}

function comparableIds(value) {
    if (!value) return [];
    try {
        return buildComparableIds(String(value));
    } catch {
        return [String(value)];
    }
}

function isConfiguredOwnerJid(jid, owners) {
    const value = String(jid || '');
    if (!value) return false;

    // Never interpret a LID's numeric user part as a phone number. A LID is
    // only trusted when Baileys' persisted LID mapping resolves it to an owner PN.
    const server = jidServer(value);
    if (PHONE_SERVERS.has(server) && owners.has(digits(value))) return true;

    const variants = comparableIds(value);
    return variants.some((candidate) => {
        const candidateServer = jidServer(candidate);
        return PHONE_SERVERS.has(candidateServer) &&
            owners.has(digits(candidate));
    });
}

async function isOwnerOrSudo(senderId, sock = null, chatId = null) {
    const owners = new Set(ownerNumbers());
    const sender = String(senderId || '');

    if (isConfiguredOwnerJid(sender, owners)) return true;

    // For group messages, resolve the sender's participant record and check
    // only that participant's phone/JID aliases. Never compare against the
    // bot's own LID or grant access because another owner is in the group.
    if (sock && chatId && chatId.endsWith('@g.us') && sender) {
        try {
            const metadata = await sock.groupMetadata(chatId);
            const senderIds = new Set(comparableIds(sender));
            senderIds.add(sender);

            const participant = (metadata?.participants || []).find((entry) => {
                const ids = [entry?.id, entry?.lid, entry?.phoneNumber]
                    .filter(Boolean)
                    .flatMap((id) => [String(id), ...comparableIds(id)]);
                return ids.some((id) => senderIds.has(id));
            });

            if (participant) {
                const aliases = [
                    participant.id,
                    participant.lid,
                    participant.phoneNumber,
                    participant.phone_number
                ].filter(Boolean);

                if (aliases.some((alias) => isConfiguredOwnerJid(alias, owners))) {
                    return true;
                }
            }
        } catch (error) {
            console.error('[isOwner] Could not resolve group participant:', error?.message || error);
        }
    }

    try {
        return await isSudo(sender);
    } catch (error) {
        console.error('[isOwner] Sudo check failed:', error?.message || error);
        return false;
    }
}

module.exports = isOwnerOrSudo;
