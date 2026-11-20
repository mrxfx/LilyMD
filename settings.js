require('dotenv').config();

const settings = {
  packname: 'Lily MD',
  author: '‎',
  botName: "Lily MD",
  aiName: "AYHA",
  botOwner: process.env.BOT_OWNER || 'Rahul Haldar', // Your name
  ownerNumber: '916033352400', //Set your number here without + symbol, just add country code & number without any space
  giphyApiKey: 'qnl7ssQChTdPjsKta2Ax2LMaGXz303tq',
  commandMode: "public",
  maxStoreMessages: 20, 
  storeWriteInterval: 10000,
  description: "This is a bot for managing group commands and automating tasks.",
  version: "3.0.8",
  updateZipUrl: process.env.UPDATE_ZIP_URL || "",
  githubRepo: process.env.GITHUB_REPO || '',
  // Public website / dashboard (Vercel). Used for .website and the AI referer.
  websiteUrl: process.env.WEBSITE_URL || 'https://lilymd.vercel.app',
  // Channel / community links (leave empty to hide them)
  newsletterJid: process.env.NEWSLETTER_JID || '',
  channelLink: process.env.CHANNEL_LINK || '',
  supportGroupLink: process.env.SUPPORT_GROUP_LINK || '',
  // AYHA usage cap per user per day (0 = unlimited, owner/sudo exempt)
  aiDailyLimit: Number(process.env.AI_DAILY_LIMIT ?? 30),
  // AI assistant AYHA (OpenRouter)
  openrouterApiKey: process.env.OPENROUTER_API_KEY || '',
  openrouterModel: process.env.OPENROUTER_MODEL || 'openrouter/free',
  openrouterBaseUrl: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
  // Private-chat AYHA auto-reply (toggle also available at runtime with .aiutoreply on)
  aiAutoReply: /^(1|true|on|yes)$/i.test(process.env.AI_AUTO_REPLY || ''),
  aiAutoReplyKey: process.env.AI_AUTO_REPLY_API_KEY || '',
  aiAutoReplyModel: process.env.AI_AUTO_REPLY_MODEL || '',
  // Atlas API layer (Atlas-MD endpoints + key pools)
  tenorApiKey: process.env.TENOR_API_KEY || '',
  openWeatherApiKey: process.env.OPENWEATHER_API_KEY || '',
  // Media / Atlas API (song, video, cards, etc.)
  // Atlas endpoints (see lib/atlasApi.js)
  atlasFaaUrl: process.env.ATLAS_FAA_URL || 'https://api-faa.my.id/faa',
  atlasNexrayUrl: process.env.ATLAS_NEXRAY_URL || 'https://api.nexray.web.id/downloader',
  atlasTikwmUrl: process.env.ATLAS_TIKWM_URL || 'https://tikwm.com/api/',
};

module.exports = settings;
