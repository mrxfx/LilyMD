const http = require('http');
const settings = require('../settings');
const { handleRequest } = require('./webApp');

// 2-in-1 server: the bot's health endpoint and the pairing website share one
// port, so a single process on a single port gives you both.
//   GET /          -> pairing website
//   GET /health    -> JSON status for panels / uptime monitors
function startHealthServer(getConnected) {
    const port = Number(process.env.PORT || 8080);
    const server = http.createServer(async (req, res) => {
        if (await handleRequest(req, res, settings.botName)) return;

        const route = (req.url || '/').split('?')[0];
        if (route !== '/' && route !== '/health') {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'not found' }));
            return;
        }
        const connected = typeof getConnected === 'function' ? getConnected() : Boolean(getConnected);
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({
            status: 'ok',
            bot: settings.botName,
            ai: settings.aiName,
            connected,
            website: true,
            uptime: Math.round(process.uptime())
        }));
    });
    server.on('error', (err) => console.error(`[health] server error: ${err.message}`));
    server.listen(port, () => {
        console.log(`🌐 Server listening on http://localhost:${port} — website + /health`);
    });
    return server;
}

module.exports = { startHealthServer };
