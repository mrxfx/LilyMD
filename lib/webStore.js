'use strict';
/**
 * Tiny dependency-free JSON store used by the web platform (auth, settings).
 * Atomic writes (tmp file + rename) so a crash never leaves a half-written file.
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

function dataPath(name) {
    return path.join(DATA_DIR, name);
}

function readJson(file, fallback) {
    try {
        const raw = fs.readFileSync(file, 'utf8');
        const data = JSON.parse(raw);
        return data === null || data === undefined ? fallback : data;
    } catch {
        return fallback;
    }
}

function writeJson(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
    return data;
}

function appendLine(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const line = typeof value === 'string' ? value : JSON.stringify(value);
    fs.appendFileSync(file, line + '\n');
}

/** Keeps a JSONL file bounded by count (used by the audit log). */
function capLines(file, maxLines) {
    try {
        const stat = fs.statSync(file);
        if (stat.size < 512 * 1024) return;
        const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
        fs.writeFileSync(file, lines.slice(-maxLines).join('\n') + '\n');
    } catch {
        // best effort
    }
}

module.exports = { DATA_DIR, dataPath, readJson, writeJson, appendLine, capLines };
