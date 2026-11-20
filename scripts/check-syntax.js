#!/usr/bin/env node
// Syntax-checks every project JS file. Works without npm install.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const skipDirs = new Set(['node_modules', '.git', '.freebuff', '.cloud-attachments', 'session', 'temp', 'tmp']);
const files = [];

function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (skipDirs.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.js')) files.push(full);
    }
}

walk(root);

let failed = 0;
for (const file of files) {
    try {
        execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    } catch (err) {
        failed++;
        console.error(`✖ ${path.relative(root, file)}`);
        console.error(String(err.stderr || err.message).trim());
    }
}

if (failed) {
    console.error(`\n${failed} of ${files.length} files failed the syntax check`);
    process.exit(1);
}
console.log(`✓ syntax ok — ${files.length} files`);
