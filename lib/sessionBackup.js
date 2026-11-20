const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// Session backup / restore without extra dependencies (uses the system `tar`).
//   restore  -> base64 tar.gz in SESSION_ID is unpacked into ./session on boot
//   backup   -> ./session is packed into session-backup.txt (gitignored) so the
//               value can be copied into SESSION_ID on a hosting panel
const SESSION_DIR = path.join(process.cwd(), 'session');
const BACKUP_FILE = path.join(process.cwd(), 'session-backup.txt');
const BACKUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MAX_BUFFER = 64 * 1024 * 1024;

let timer = null;

function hasSession() {
    return fs.existsSync(path.join(SESSION_DIR, 'creds.json'));
}

function packSession() {
    const result = spawnSync('tar', ['-czf', '-', '.'], { cwd: SESSION_DIR, maxBuffer: MAX_BUFFER });
    if (result.error) throw new Error(`tar is unavailable (${result.error.message})`);
    if (result.status !== 0) throw new Error(String(result.stderr || '').trim() || `tar exited with ${result.status}`);
    return result.stdout.toString('base64');
}

function restoreSessionFromEnv() {
    const sessionId = String(process.env.SESSION_ID || '')
        .replace(/^data:.*?base64,/, '')
        .replace(/\s+/g, '');
    if (!sessionId) return false;
    if (hasSession()) {
        console.log('🔐 Existing session found, skipping SESSION_ID restore');
        return false;
    }
    try {
        fs.mkdirSync(SESSION_DIR, { recursive: true });
        const result = spawnSync('tar', ['-xzf', '-'], {
            cwd: SESSION_DIR,
            input: Buffer.from(sessionId, 'base64'),
            maxBuffer: MAX_BUFFER
        });
        if (result.error) throw new Error(result.error.message);
        if (result.status !== 0) throw new Error(String(result.stderr || '').trim() || `tar exited with ${result.status}`);
        if (!hasSession()) throw new Error('archive did not contain creds.json');
        console.log('🔐 Session restored from SESSION_ID');
        return true;
    } catch (err) {
        console.error(`[session] could not restore from SESSION_ID: ${err.message}`);
        return false;
    }
}

function writeSessionBackup() {
    if (!hasSession()) return false;
    try {
        fs.writeFileSync(BACKUP_FILE, packSession());
        console.log('💾 Session backup written to session-backup.txt — copy its contents into SESSION_ID on your panel');
        return true;
    } catch (err) {
        console.error(`[session] backup failed: ${err.message}`);
        return false;
    }
}

function scheduleSessionBackup() {
    writeSessionBackup();
    if (timer) return;
    timer = setInterval(writeSessionBackup, BACKUP_INTERVAL_MS);
    if (timer.unref) timer.unref();
}

module.exports = {
    restoreSessionFromEnv,
    writeSessionBackup,
    scheduleSessionBackup
};
