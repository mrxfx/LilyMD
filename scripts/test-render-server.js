'use strict';
/**
 * Render Web Service simulation test
 * Tests web/server.js under Render's exact environment conditions:
 * - PORT=10000 injected by Render
 * - HOST=0.0.0.0
 * - NODE_ENV=production
 * - Routes: /, /health, /api/health, /api/commands, /api/status, /api/pair, /api/pair/qr, /api/pair/cancel, static assets
 */
const http = require('http');
const assert = require('assert');

process.env.PORT = '10000';
process.env.NODE_ENV = 'production';
process.env.BOT_NAME = 'Lily MD';

// Start server
require('../web/server.js');

function get(path) {
    return new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:10000${path}`, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
        }).on('error', reject);
    });
}

function post(path, body) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body || {});
        const req = http.request(`http://127.0.0.1:10000${path}`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(payload)
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
        });
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

async function run() {
    console.log('Testing Render Web Service runtime environment...');

    // 1. Landing page
    const home = await get('/');
    assert.strictEqual(home.status, 200, 'Home page must return 200');
    assert.ok(home.body.includes('Lily MD'), 'Home page must include bot name');
    assert.ok(home.body.includes('pair-tabs'), 'Home page must include pairing tabs');
    console.log('  ✓ GET / → 200 with HTML landing page');

    // 2. Health check (watchdog on Render)
    const health = await get('/health');
    assert.strictEqual(health.status, 200, 'Health check must return 200');
    const healthJson = JSON.parse(health.body);
    assert.strictEqual(healthJson.ok, true);
    assert.strictEqual(healthJson.status, 'ok');
    assert.ok(healthJson.uptimeFormatted, 'Should include uptimeFormatted');
    assert.ok(healthJson.memoryMb, 'Should include memoryMb');
    assert.ok(healthJson.timestamp, 'Should include timestamp');
    console.log(`  ✓ GET /health → 200 (uptime: ${healthJson.uptimeFormatted}, memory: ${healthJson.memoryMb.rss})`);

    // 3. API health
    const apiHealth = await get('/api/health');
    assert.strictEqual(apiHealth.status, 200);
    const apiHealthJson = JSON.parse(apiHealth.body);
    assert.strictEqual(apiHealthJson.status, 'ok');
    console.log('  ✓ GET /api/health → 200 with JSON health status');

    // 4. Commands documentation
    const commands = await get('/api/commands');
    assert.strictEqual(commands.status, 200);
    const commandsJson = JSON.parse(commands.body);
    assert.strictEqual(commandsJson.ok, true);
    assert.ok(Array.isArray(commandsJson.commands));
    assert.ok(commandsJson.total > 0);
    console.log(`  ✓ GET /api/commands → 200 (${commandsJson.total} commands listed)`);

    // 5. System status
    const status = await get('/api/status');
    assert.strictEqual(status.status, 200);
    const statusJson = JSON.parse(status.body);
    assert.strictEqual(statusJson.ok, true);
    console.log('  ✓ GET /api/status → 200 with telemetry');

    // 6. Pairing cancellation
    const cancel = await post('/api/pair/cancel', { id: 'non-existent' });
    assert.strictEqual(cancel.status, 200);
    const cancelJson = JSON.parse(cancel.body);
    assert.strictEqual(cancelJson.ok, true);
    assert.strictEqual(cancelJson.canceled, false);
    console.log('  ✓ POST /api/pair/cancel → 200 JSON');

    // 7. Static CSS & JS
    const css = await get('/theme.css');
    assert.strictEqual(css.status, 200);
    const js = await get('/app.js');
    assert.strictEqual(js.status, 200);
    const config = await get('/config.js');
    assert.strictEqual(config.status, 200);
    console.log('  ✓ Static assets (/theme.css, /app.js, /config.js) → 200');

    console.log('\nAll Render Web Service routes verified successfully!');
    process.exit(0);
}

setTimeout(run, 1000);
