const axios = require('axios');
const settings = require('../settings');
const APIs = require('../lib/api');

const processedMessages = new Set();

const FB_PATTERNS = [
  /https?:\/\/(?:www\.|m\.)?facebook\.com\//i,
  /https?:\/\/(?:www\.|m\.)?fb\.com\//i,
  /https?:\/\/fb\.watch\//i,
];

function extractUrl(text) {
  const match = String(text || '').match(/https?:\/\/[^\s]+/i);
  return match ? match[0] : '';
}

async function resolveFacebook(url) {
  // Atlas API layer (api-faa fbdownload)
  return APIs.knightFacebookDownload(url);
}

async function sendVideo(sock, chatId, message, videoUrl, title) {
  const bot = (settings.botName || 'Lily MD').toUpperCase();
  const caption = title ? `*DOWNLOADED BY ${bot}*\n\n📝 ${title}` : `*DOWNLOADED BY ${bot}*`;

  try {
    await sock.sendMessage(
      chatId,
      { video: { url: videoUrl }, mimetype: 'video/mp4', caption },
      { quoted: message }
    );
  } catch {
    const { data } = await axios.get(videoUrl, {
      responseType: 'arraybuffer',
      timeout: 120000,
      maxContentLength: 100 * 1024 * 1024,
      headers: {
        'User-Agent': APIs.UA,
        Accept: 'video/mp4,video/*,*/*',
        Referer: 'https://www.facebook.com/',
      },
    });
    await sock.sendMessage(
      chatId,
      { video: Buffer.from(data), mimetype: 'video/mp4', caption },
      { quoted: message }
    );
  }
}

async function facebookCommand(sock, chatId, message) {
  try {
    if (processedMessages.has(message.key.id)) return;
    processedMessages.add(message.key.id);
    setTimeout(() => processedMessages.delete(message.key.id), 5 * 60 * 1000);

    const text =
      message.message?.conversation || message.message?.extendedTextMessage?.text || '';
    const url = extractUrl(text);

    if (!url) {
      return sock.sendMessage(
        chatId,
        { text: 'Please provide a Facebook link.\nExample: `.fb https://facebook.com/reel/...`' },
        { quoted: message }
      );
    }
    if (!FB_PATTERNS.some((p) => p.test(url))) {
      return sock.sendMessage(
        chatId,
        { text: 'That is not a valid Facebook link.' },
        { quoted: message }
      );
    }

    await sock.sendMessage(chatId, { react: { text: '🔄', key: message.key } });

    const dl = await resolveFacebook(url);
    if (!dl?.download || !/^https?:\/\//i.test(dl.download)) {
      throw new Error('Invalid download response');
    }

    await sendVideo(sock, chatId, message, dl.download, dl.title);
  } catch (err) {
    console.error('[facebook]', err?.message || err);
    await sock.sendMessage(
      chatId,
      { text: '❌ Failed to download Facebook video. Try another link.' },
      { quoted: message }
    );
  }
}

module.exports = facebookCommand;
