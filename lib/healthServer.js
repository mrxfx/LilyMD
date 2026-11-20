
'use strict';

const http = require('http');
const settings = require('../settings');
const { handleRequest } = require('./webApp');

// Lily MD HTTP server
// GET /       -> Pairing website
// GET /health -> Health status JSON

function startHealthServer(getConnected) {
    // OptikLink allocation: 5745
    // Prefer explicitly configured PORT, then panel SERVER_PORT.
    const rawPort = process.env.PORT || process.env.SERVER_PORT || '5745';
    const port = Number(rawPort);

    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`[health] Invalid server port: ${rawPort}`);
    }

    const server = http.createServer(async (req, res) => {
        try {
            // Handle website and API routes first.
            if (await handleRequest(req, res, settings.botName)) {
                return;
            }

            const route = (req.url || '/').split('?')[0];

            if (route !== '/' && route !== '/health') {
                res.writeHead(404, {
                    'content-type': 'application/json; charset=utf-8'
                });
                res.end(JSON.stringify({ error: 'not found' }));
                return;
            }

            const connected =
                typeof getConnected === 'function'
                    ? Boolean(getConnected())
                    : Boolean(getConnected);

            const payload = {
                status: 'ok',
                bot: settings.botName,
                ai: settings.aiName,
                connected,
                website: true,
                uptime: Math.round(process.uptime())
            };

            res.writeHead(200, {
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'no-store'
            });

            res.end(JSON.stringify(payload));

        } catch (error) {
            console.error('[health] Request error:', error);

            if (res.destroyed || res.writableEnded) return;

            if (!res.headersSent) {
                res.writeHead(500, {
                    'content-type': 'application/json; charset=utf-8',
                    'cache-control': 'no-store'
                });
            }

            res.end(JSON.stringify({
                status: 'error',
                error: 'Internal server error'
            }));
        }
    });

    server.on('error', (err) => {
        console.error('[health] Server error:', err);
    });

    server.listen(port, '0.0.0.0', () => {
        console.log(
            `🌐 Lily MD server listening on 0.0.0.0:${port}`
        );
        console.log('💚 Health endpoint: /health');
        console.log('🌐 Pairing website: /');
    });

    return server;
}

module.exports = { startHealthServer };
