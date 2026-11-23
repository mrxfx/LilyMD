try {
  require('dotenv').config();
} catch {
  const fs = require('fs');
  const path = require('path');
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx !== -1) {
        const k = trimmed.slice(0, idx).trim();
        const v = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
        if (!process.env[k]) process.env[k] = v;
      }
    }
  }
}

const { ownerNumbers } = require('./lib/ownerNumbers');

const configuredOwners = ownerNumbers();
const primaryOwner = String(process.env.OWNER_NUMBER || '916033352400').replace(/[^0-9]/g, '');
const settings = {
  packname: 'Lily MD 🐱💗',
  author: 'Rahul Haldar',
  botName: process.env.BOT_NAME || 'Lily MD 🐱💗',
  aiName: process.env.AI_NAME || 'AYHA',
  botOwner: process.env.BOT_OWNER || 'Rahul Haldar',
  ownerNumber: primaryOwner,
  ownerNumbers: configuredOwners.includes(primaryOwner) ? configuredOwners : [primaryOwner, ...configuredOwners],
  giphyApiKey: process.env.GIPHY_API_KEY || '',
  commandMode: process.env.COMMAND_MODE || 'public',
  maxStoreMessages: 20,
  storeWriteInterval: 10000,
  description: 'Your WhatsApp. Your Assistant. Your Intelligence.',
  version: '3.0.8',
  updateZipUrl: process.env.UPDATE_ZIP_URL || '',
  githubRepo: process.env.GITHUB_REPO || 'mrxfx/LilyMD',
  websiteUrl: process.env.WEBSITE_URL || 'https://lilymd.onrender.com',
  newsletterJid: process.env.NEWSLETTER_JID || '',
  channelLink: process.env.CHANNEL_LINK || '',
  supportGroupLink: process.env.SUPPORT_GROUP_LINK || '',
  aiDailyLimit: Number(process.env.AI_DAILY_LIMIT ?? 30),
  openrouterApiKey: process.env.OPENROUTER_API_KEY || '',
  openrouterModel: process.env.OPENROUTER_MODEL || 'openrouter/free',
  openrouterBaseUrl: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
  aiAutoReply: /^(1|true|on|yes)$/i.test(process.env.AI_AUTO_REPLY || ''),
  aiAutoReplyKey: process.env.AI_AUTO_REPLY_API_KEY || '',
  aiAutoReplyModel: process.env.AI_AUTO_REPLY_MODEL || '',
  aiPersonalityMode: process.env.AI_PERSONALITY_MODE || 'companion',
  autoReplyMode: String(process.env.AUTO_REPLY_MODE || 'PRIVATE').toLowerCase(),
  tenorApiKey: process.env.TENOR_API_KEY || '',
  openWeatherApiKey: process.env.OPENWEATHER_API_KEY || '',
  atlasFaaUrl: process.env.ATLAS_FAA_URL || 'https://api-faa.my.id/faa',
  atlasNexrayUrl: process.env.ATLAS_NEXRAY_URL || 'https://api.nexray.web.id/downloader',
  atlasTikwmUrl: process.env.ATLAS_TIKWM_URL || 'https://tikwm.com/api/',
};

module.exports = settings;
