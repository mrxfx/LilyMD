'use strict';
/**
 * Lily MD — standalone pairing site
 * Copyright (c) 2026 Rahul Haldar
 *
 *   npm run website        (WEB_PORT, default 3000)
 *
 * The same routes are also served by the bot itself on PORT (`node index.js`),
 * which is the 2-in-1 mode: one process runs WhatsApp and the website together.
 * Use this entry point only when you want the site without the bot.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { handleRequest, closeJobs } = require('../lib/webApp');

try {
    require('dotenv').config();
} catch {}

// Ensure local state directory exists on startup
try {
    fs.mkdirSync(path.join(process.cwd(), 'data'), { recursive: true });
} catch {}

const rawPort = process.env.PORT || process.env.WEB_PORT;
let PORT = Number(rawPort);
if (isNaN(PORT) || PORT <= 0 || PORT > 65535) {
    PORT = 3000;
}
const HOST = process.env.HOST || '0.0.0.0';
const BOT_NAME = process.env.BOT_NAME || 'Lily MD';

const server = http.createServer(async (req, res) => {
    if (await handleRequest(req, res, BOT_NAME)) return;
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, HOST, () => {
    console.log(`🌐 [Render/Web] ${BOT_NAME} website running at http://${HOST}:${PORT}`);
    console.log(`   Health check endpoint: http://${HOST}:${PORT}/health`);
    console.log(`   Node: ${process.version} | Platform: ${process.platform} | PID: ${process.pid}`);
});

function shutdown() {
    closeJobs();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
