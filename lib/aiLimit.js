const fs = require('fs');
const path = require('path');
const settings = require('../settings');

// Daily per-user cap for AYHA calls. Counters live in data/aiUsage.json and are
// pruned to the current day, so the file never grows.
const USAGE_FILE = path.join(__dirname, '../data/aiUsage.json');

function todayKey() {
    return new Date().toISOString().slice(0, 10);
}

function usageId(userId) {
    return String(userId || 'unknown').split(':')[0];
}

function dailyLimit() {
    const limit = Number(settings.aiDailyLimit);
    if (!Number.isFinite(limit) || limit < 0) return 30;
    return Math.floor(limit);
}

function readUsage() {
    try {
        const data = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
        return data && typeof data === 'object' ? data : {};
    } catch (err) {
        return {};
    }
}

function writeUsage(data) {
    try {
        fs.mkdirSync(path.dirname(USAGE_FILE), { recursive: true });
        fs.writeFileSync(USAGE_FILE, JSON.stringify(data, null, 2));
    } catch (err) {
        console.error('[aiLimit] could not save usage:', err.message);
    }
}

// { allowed, used, limit } — limit 0 means unlimited
function checkAiLimit(userId) {
    const limit = dailyLimit();
    if (limit === 0) return { allowed: true, used: 0, limit };
    const day = readUsage()[todayKey()] || {};
    const used = Number(day[usageId(userId)]) || 0;
    return { allowed: used < limit, used, limit };
}

// Increments the counter; returns the new count (never above the limit).
function recordAiUse(userId) {
    const limit = dailyLimit();
    if (limit === 0) return 0;
    const data = readUsage();
    const key = todayKey();
    const id = usageId(userId);
    data[key] = data[key] || {};
    if ((Number(data[key][id]) || 0) >= limit) return Number(data[key][id]);
    data[key][id] = (Number(data[key][id]) || 0) + 1;
    for (const oldDay of Object.keys(data)) {
        if (oldDay !== key) delete data[oldDay];
    }
    writeUsage(data);
    return data[key][id];
}

function limitMessage(limit) {
    return `⚠️ AYHA's daily limit is *${limit}* questions per user.\nIt resets at midnight UTC — try again later.`;
}

module.exports = {
    checkAiLimit,
    recordAiUse,
    limitMessage
};
