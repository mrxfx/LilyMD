// Static default for a separately hosted frontend (e.g. Vercel).
// Set window.LILY_CONFIG.backendUrl to your bot's public URL, e.g.
//   window.LILY_CONFIG = { backendUrl: 'https://lily-bot.up.railway.app' };
// The bot itself serves a generated /config.js that overrides this file when it
// hosts the site, so you only need to edit this if Vercel serves the page.
window.LILY_CONFIG = window.LILY_CONFIG || { backendUrl: '' };
