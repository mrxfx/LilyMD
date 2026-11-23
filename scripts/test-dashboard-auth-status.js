'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const assert = require('assert');

const auth = require('../lib/webAuth');
const webApi = require('../lib/webApi');
const sessionBackup = require('../lib/sessionBackup');
const { handleRequest, setMainSocket } = require('../lib/webApp');
const store = require('../lib/webStore');

let pass = 0;
let fail = 0;

function check(desc, condition) {
    if (condition) {
        pass++;
        console.log(`  ✓ ${desc}`);
    } else {
        fail++;
        console.error(`  ✗ ${desc}`);
    }
}

async function run() {
    console.log('Testing Lily MD Dashboard Authentication & Online-Status Architecture:\n');

    const testNumber = '916033352400';
    const testNumber2 = '916033271400';

    // -------------------------------------------------------------
    // 1. Password Generation and Storage via Server Pairing
    // -------------------------------------------------------------
    console.log('1. Server Pairing Password Generation & Storage:');
    const mockSock = {
        user: { id: `${testNumber}:15@s.whatsapp.net` },
        sendMessage: async () => ({ key: { id: 'msg-1' } })
    };

    const serverResult = await sessionBackup.deliverPairingSuccess(mockSock, testNumber, {
        platform: 'Linux'
    });

    check('deliverPairingSuccess delivered on server pairing', serverResult.ok === true && serverResult.delivered === true);
    check('server pairing generated valid Dashboard Password', typeof serverResult.tempPassword === 'string' && serverResult.tempPassword.length >= 8);

    const account = auth.findAccount(testNumber);
    check('Account exists in webAccounts.json', account !== null);
    check('Account number matches paired number', account.number === testNumber);
    check('Password matches scrypt hash in webAccounts.json', auth.verifyPassword(serverResult.tempPassword, account.passwordHash));

    // -------------------------------------------------------------
    // 2. Authentication and Validation Logic
    // -------------------------------------------------------------
    console.log('\n2. Authentication & Validation Logic:');
    
    // Direct login with clean password
    const loginResult1 = auth.login(testNumber, serverResult.tempPassword, { headers: {} });
    check('auth.login succeeds with exact password', loginResult1.ok === true);
    check('auth.login returns token', typeof loginResult1.token === 'string' && loginResult1.token.length > 20);
    check('auth.login returns csrf', typeof loginResult1.csrf === 'string');

    // Login with password wrapped in backticks (as formatted in WhatsApp message)
    const backtickPass = `\`${serverResult.tempPassword}\``;
    const loginResult2 = auth.login(testNumber, backtickPass, { headers: {} });
    check('auth.login succeeds with backtick-wrapped password from WhatsApp', loginResult2.ok === true);

    // Login with password with leading/trailing whitespace
    const spacedPass = `  ${serverResult.tempPassword}  `;
    const loginResult3 = auth.login(testNumber, spacedPass, { headers: {} });
    check('auth.login succeeds with whitespace-padded password', loginResult3.ok === true);

    // Login with invalid password fails
    const badLogin = auth.login(testNumber, 'WrongPassword123', { headers: {} });
    check('auth.login rejects invalid password', badLogin.ok === false && badLogin.status === 401);

    // Session retrieval via Bearer Token header
    const mockBearerReq = {
        headers: {
            authorization: `Bearer ${loginResult1.token}`,
            cookie: ''
        }
    };
    const sessionFromBearer = auth.getSession(mockBearerReq);
    check('auth.getSession resolves valid session via Authorization: Bearer token', sessionFromBearer !== null && sessionFromBearer.account.number === testNumber);

    // Session retrieval via ?token= query param
    const mockQueryReq = {
        headers: {},
        url: `/api/events?token=${encodeURIComponent(loginResult1.token)}`
    };
    const sessionFromQuery = auth.getSession(mockQueryReq);
    check('auth.getSession resolves valid session via ?token= query parameter', sessionFromQuery !== null && sessionFromQuery.account.number === testNumber);

    // -------------------------------------------------------------
    // 3. Uniformity: Server and Website Pairing Use Same Auth Source
    // -------------------------------------------------------------
    console.log('\n3. Server vs Website Pairing Auth Uniformity:');
    const mockWebSock = {
        user: { id: `${testNumber2}:12@s.whatsapp.net` },
        sendMessage: async () => ({ key: { id: 'msg-2' } })
    };

    const webResult = await sessionBackup.deliverPairingSuccess(mockWebSock, testNumber2, {
        platform: 'Render'
    });

    check('deliverPairingSuccess delivered on website pairing', webResult.ok === true && webResult.delivered === true);
    check('website pairing generated valid Dashboard Password', typeof webResult.tempPassword === 'string');

    const webAccount = auth.findAccount(testNumber2);
    check('Web account provisioned in same webAccounts.json', webAccount !== null);
    check('Web password matches scrypt hash in webAccounts.json', auth.verifyPassword(webResult.tempPassword, webAccount.passwordHash));

    const webLogin = auth.login(testNumber2, webResult.tempPassword, { headers: {} });
    check('Web login succeeds with identical login mechanism', webLogin.ok === true);

    // -------------------------------------------------------------
    // 4. Dashboard Status While Connected
    // -------------------------------------------------------------
    console.log('\n4. Dashboard Status While Connected:');
    let isConnected = true;
    let currentSock = {
        user: { id: `${testNumber}:15@s.whatsapp.net` }
    };

    webApi.setRuntime({
        getConnected: () => isConnected,
        getSocket: () => currentSock
    });

    const statusConnected = webApi.status();
    check('webApi.status().connected is true when bot is connected', statusConnected.connected === true);
    check('webApi.status().state is "connected"', statusConnected.state === 'connected');
    check('webApi.status().whatsappNumber reflects connected number', statusConnected.whatsappNumber === testNumber);

    // Test through HTTP server: /api/dash/status, /api/status, and /health
    const testServer = http.createServer(async (req, res) => {
        if (await handleRequest(req, res, 'Lily MD')) return;
        res.writeHead(404);
        res.end();
    });

    await new Promise((resolve) => testServer.listen(0, '127.0.0.1', resolve));
    const port = testServer.address().port;

    async function httpGet(path, headers = {}) {
        return new Promise((resolve, reject) => {
            const req = http.request({
                hostname: '127.0.0.1',
                port,
                path,
                method: 'GET',
                headers
            }, (res) => {
                let data = '';
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => {
                    try {
                        resolve({ status: res.statusCode, data: JSON.parse(data), headers: res.headers });
                    } catch {
                        resolve({ status: res.statusCode, raw: data, headers: res.headers });
                    }
                });
            });
            req.on('error', reject);
            req.end();
        });
    }

    // Call /api/dash/status with Bearer token
    const dashStatusRes = await httpGet('/api/dash/status', {
        authorization: `Bearer ${loginResult1.token}`
    });
    check('HTTP GET /api/dash/status returns 200 with Bearer auth', dashStatusRes.status === 200);
    check('HTTP GET /api/dash/status reports connected: true', dashStatusRes.data.connected === true);
    check('HTTP GET /api/dash/status reports state: "connected"', dashStatusRes.data.state === 'connected');

    // Call public /api/status
    const publicStatusRes = await httpGet('/api/status');
    check('HTTP GET /api/status returns 200', publicStatusRes.status === 200);
    check('HTTP GET /api/status reports connected: true', publicStatusRes.data.connected === true);

    // Call /health
    const healthRes = await httpGet('/health');
    check('HTTP GET /health returns 200', healthRes.status === 200);
    check('HTTP GET /health reports connected: true', healthRes.data.connected === true);

    // -------------------------------------------------------------
    // 5. Dashboard Status After Disconnect
    // -------------------------------------------------------------
    console.log('\n5. Dashboard Status After Disconnect:');
    isConnected = false;
    currentSock = null;

    const statusDisconnected = webApi.status();
    check('webApi.status().connected is false when disconnected', statusDisconnected.connected === false);
    check('webApi.status().state is "disconnected"', statusDisconnected.state === 'disconnected');

    const dashStatusDisc = await httpGet('/api/dash/status', {
        authorization: `Bearer ${loginResult1.token}`
    });
    check('HTTP GET /api/dash/status reports connected: false when disconnected', dashStatusDisc.data.connected === false);
    check('HTTP GET /api/dash/status reports state: "disconnected"', dashStatusDisc.data.state === 'disconnected');

    const healthDisc = await httpGet('/health');
    check('HTTP GET /health reports connected: false when disconnected', healthDisc.data.connected === false);

    // -------------------------------------------------------------
    // 6. Persistence Across Server Restart
    // -------------------------------------------------------------
    console.log('\n6. Persistence Across Server Restart:');
    // On restart: saved accounts and hashes remain valid on disk
    const reloadedAccount = auth.findAccount(testNumber);
    check('Account persists on disk across server restart', reloadedAccount !== null);
    check('Original password still verifies after restart', auth.verifyPassword(serverResult.tempPassword, reloadedAccount.passwordHash));

    // Simulating reconnect after restart
    isConnected = true;
    currentSock = { user: { id: `${testNumber}:15@s.whatsapp.net` } };
    const dashStatusReconnected = await httpGet('/api/dash/status', {
        authorization: `Bearer ${loginResult1.token}`
    });
    check('Dashboard status recovers to connected: true after server restart & reconnect', dashStatusReconnected.data.connected === true);

    // -------------------------------------------------------------
    // 7. CORS and Cross-Origin Headers for Dashboard
    // -------------------------------------------------------------
    console.log('\n7. CORS & Cross-Origin Support for Dashboard:');
    const corsRes = await httpGet('/api/dash/status', {
        origin: 'http://localhost:3000',
        authorization: `Bearer ${loginResult1.token}`
    });
    check('CORS allows localhost origin on separate port', corsRes.headers['access-control-allow-origin'] === 'http://localhost:3000');
    check('CORS enables credentials', corsRes.headers['access-control-allow-credentials'] === 'true');
    check('CORS exposes authorization header in allow-headers', corsRes.headers['access-control-allow-headers'].includes('authorization'));

    // Close test server
    await new Promise((resolve) => testServer.close(resolve));

    console.log(`\nResults: ${pass} passed, ${fail} failed`);
    if (fail > 0) process.exit(1);
}

run().catch((err) => {
    console.error('Test run failed:', err);
    process.exit(1);
});
