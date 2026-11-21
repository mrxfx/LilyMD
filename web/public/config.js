// Default configuration for Render Web Service or standalone website hosting.
// When hosted on Render, the website serves its own API and static assets from the same origin.
// If you host the website separately from the WhatsApp bot and wish to point the dashboard
// at a remote bot host, set window.LILY_CONFIG.backendUrl:
//   window.LILY_CONFIG = { backendUrl: 'https://your-bot-host.example.com' };
// Leave blank to use the same-origin Render Web Service.
window.LILY_CONFIG = window.LILY_CONFIG || { backendUrl: '' };
