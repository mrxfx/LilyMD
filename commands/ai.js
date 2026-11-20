const APIs = require('../lib/api');
const aiProviders = require('../lib/aiProviders');
const { buildSystemPrompt, getRuntime } = require('../lib/aiAutoReply');
const isOwnerOrSudo = require('../lib/isOwner');
const { checkAiLimit, recordAiUse, limitMessage } = require('../lib/aiLimit');

async function aiCommand(sock, chatId, message) {
  try {
    const text =
      message.message?.conversation || message.message?.extendedTextMessage?.text || '';
    const query = text.replace(/^\.(?:ai|gpt|gemini)\s*/i, '').trim();

    if (!query) {
      return sock.sendMessage(
        chatId,
        { text: 'Usage: `.ai <question>`\nExample: `.ai write a basic html page`' },
        { quoted: message }
      );
    }

    // Owner and sudo are exempt from the daily cap
    const senderId = message.key.participant || message.key.remoteJid;
    const isPrivileged = message.key.fromMe || (await isOwnerOrSudo(senderId, sock, chatId));
    if (!isPrivileged) {
      const usage = checkAiLimit(senderId);
      if (!usage.allowed) {
        return sock.sendMessage(chatId, { text: limitMessage(usage.limit) }, { quoted: message });
      }
    }

    await sock.sendMessage(chatId, { react: { text: '🤖', key: message.key } });

    let answer;
    // Provider, model and key as selected in the dashboard / .aisetkey
    const runtime = getRuntime();
    const steps = [
      [
        `AYHA (${runtime.provider})`,
        () =>
          aiProviders.chat(
            [
              // The agent, custom instructions and style picked in the dashboard
              { role: 'system', content: buildSystemPrompt() },
              { role: 'user', content: query },
            ],
            { provider: runtime.provider, apiKey: runtime.apiKey, model: runtime.model }
          ),
      ],
      ['Knight chat', () => APIs.knightChatAI(query)],
      ['Knight gpt', () => APIs.knightGptAI(query)],
      ['fallback', () => APIs.fallbackChatAI(query)],
    ];

    for (const [name, run] of steps) {
      try {
        answer = await run();
        if (answer) {
          console.log(`[ai] OK via ${name}`);
          break;
        }
      } catch (err) {
        console.log(`[ai] ${name} failed:`, err?.message || err);
      }
    }

    if (!answer) {
      return sock.sendMessage(
        chatId,
        { text: '❌ AYHA could not answer right now. Try again later.' },
        { quoted: message }
      );
    }

    if (!isPrivileged) recordAiUse(senderId);
    await sock.sendMessage(chatId, { text: answer }, { quoted: message });
  } catch (err) {
    console.error('[ai]', err?.message || err);
    await sock.sendMessage(
      chatId,
      { text: '❌ An error occurred. Please try again later.' },
      { quoted: message }
    );
  }
}

module.exports = aiCommand;
