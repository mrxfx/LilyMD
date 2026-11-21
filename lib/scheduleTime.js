'use strict';
/**
 * Timezone-aware schedule parsing (no external date library).
 * Default zone: Asia/Kolkata (owner-configurable with SCHEDULE_TIMEZONE).
 */
const DEFAULT_TIMEZONE = 'Asia/Kolkata';
const MAX_FUTURE_MS = 365 * 24 * 60 * 60 * 1000;

function timezone() {
    const value = String(process.env.SCHEDULE_TIMEZONE || '').trim();
    if (!value) return DEFAULT_TIMEZONE;
    try {
        new Intl.DateTimeFormat('en-GB', { timeZone: value }).format(new Date());
        return value;
    } catch (error) {
        return DEFAULT_TIMEZONE;
    }
}

function zoneParts(date, timeZone) {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone,
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    }).formatToParts(date);
    const pick = (type) => Number(parts.find((part) => part.type === type)?.value);
    return {
        year: pick('year'),
        month: pick('month'),
        day: pick('day'),
        hour: pick('hour') % 24,
        minute: pick('minute'),
        second: pick('second')
    };
}

/** Offset of the zone at that instant, in minutes (ahead of UTC is positive). */
function offsetMinutes(date, timeZone) {
    const parts = zoneParts(date, timeZone);
    const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    return (asUtc - date.getTime()) / 60000;
}

/** Convert wall-clock time in a zone to a real UTC Date. */
function zonedToUtc(year, month, day, hour, minute, timeZone) {
    const wall = Date.UTC(year, month - 1, day, hour, minute, 0);
    let guess = wall;
    for (let i = 0; i < 3; i += 1) {
        const offset = offsetMinutes(new Date(guess), timeZone);
        const next = wall - offset * 60000;
        if (Math.abs(next - guess) < 1000) return new Date(next);
        guess = next;
    }
    return new Date(guess);
}

function parseClock(value) {
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
    if (!match) return null;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) return null;
    return { hour, minute };
}

/**
 * Parse an owner-supplied schedule time.
 *   "+30m" / "+2h" / "+1d"          relative
 *   "20:30"                          today or tomorrow (zone)
 *   "tomorrow 09:00"
 *   "2026-11-22 09:30" / "2026-11-22T09:30"
 *   "22/11/2026 09:30"
 * Returns { ok, date, error }.
 */
function parseWhen(input, options = {}) {
    const raw = String(input || '').trim();
    const timeZone = options.timezone || timezone();
    const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
    if (!raw) return { ok: false, error: 'Give a time, e.g. 2026-11-22 09:30 or +2h' };

    const relative = /^\+?\s*(\d{1,4})\s*(m|min|mins|minutes|h|hr|hrs|hours|d|day|days)$/i.exec(raw);
    if (relative) {
        const amount = Number(relative[1]);
        const unit = relative[2].toLowerCase();
        const ms = unit.startsWith('m') ? amount * 60000 : unit.startsWith('h') ? amount * 3600000 : amount * 86400000;
        const date = new Date(now.getTime() + ms);
        return { ok: true, date, timezone: timeZone };
    }
    if (/^in\s+/i.test(raw)) return parseWhen(raw.replace(/^in\s+/i, '+'), options);

    const today = zoneParts(now, timeZone);
    const clockOnly = parseClock(raw);
    if (clockOnly) {
        let date = zonedToUtc(today.year, today.month, today.day, clockOnly.hour, clockOnly.minute, timeZone);
        if (date.getTime() <= now.getTime() + 5000) {
            date = new Date(date.getTime() + 86400000);
        }
        return { ok: true, date, timezone: timeZone };
    }

    const tomorrow = /^tomorrow\s+(\d{1,2}:\d{2})$/i.exec(raw);
    if (tomorrow) {
        const clock = parseClock(tomorrow[1]);
        if (!clock) return { ok: false, error: 'Invalid time of day.' };
        const base = new Date(now.getTime() + 86400000);
        const parts = zoneParts(base, timeZone);
        const date = zonedToUtc(parts.year, parts.month, parts.day, clock.hour, clock.minute, timeZone);
        return { ok: true, date, timezone: timeZone };
    }

    const iso = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/.exec(raw);
    const euro = /^(\d{1,2})\/(\d{1,2})\/(\d{4})[ ](\d{1,2}):(\d{2})$/.exec(raw);
    let year;
    let month;
    let day;
    let clock;
    if (iso) {
        year = Number(iso[1]);
        month = Number(iso[2]);
        day = Number(iso[3]);
        clock = { hour: Number(iso[4]), minute: Number(iso[5]) };
    } else if (euro) {
        day = Number(euro[1]);
        month = Number(euro[2]);
        year = Number(euro[3]);
        clock = { hour: Number(euro[4]), minute: Number(euro[5]) };
    } else {
        return { ok: false, error: 'Could not read that time. Use 2026-11-22 09:30, 22/11/2026 09:30, 20:30, tomorrow 09:00 or +2h.' };
    }
    if (month < 1 || month > 12 || day < 1 || day > 31 || clock.hour > 23 || clock.minute > 59) {
        return { ok: false, error: 'That date or time is not valid.' };
    }
    const date = zonedToUtc(year, month, day, clock.hour, clock.minute, timeZone);
    const check = zoneParts(date, timeZone);
    if (check.year !== year || check.month !== month || check.day !== day || check.hour !== clock.hour || check.minute !== clock.minute) {
        return { ok: false, error: 'That date does not exist.' };
    }
    if (date.getTime() <= now.getTime()) {
        return { ok: false, error: 'That time is in the past.' };
    }
    if (date.getTime() - now.getTime() > MAX_FUTURE_MS) {
        return { ok: false, error: 'Schedules can be at most one year ahead.' };
    }
    return { ok: true, date, timezone: timeZone };
}

function addRecurrence(date, recurrence) {
    const next = new Date(date.getTime());
    if (recurrence === 'daily') next.setUTCDate(next.getUTCDate() + 1);
    else if (recurrence === 'weekly') next.setUTCDate(next.getUTCDate() + 7);
    else if (recurrence === 'monthly') {
        const day = next.getUTCDate();
        next.setUTCDate(1);
        next.setUTCMonth(next.getUTCMonth() + 1);
        const lastDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
        next.setUTCDate(Math.min(day, lastDay));
    } else return null;
    return next;
}

function formatInZone(date, zone = timezone()) {
    const value = date instanceof Date ? date : new Date(date);
    if (!Number.isFinite(value.getTime())) return '—';
    const parts = zoneParts(value, zone);
    const pad = (n) => String(n).padStart(2, '0');
    return `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}`;
}

function relativeLabel(date, now = new Date()) {
    const diff = new Date(date).getTime() - now.getTime();
    if (!Number.isFinite(diff)) return '—';
    if (diff <= 0) return 'due now';
    const minutes = Math.round(diff / 60000);
    if (minutes < 60) return `in ${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `in ${hours}h ${minutes % 60}m`;
    return `in ${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** MySQL DATETIME literal in UTC. */
function toSqlDate(date) {
    const value = date instanceof Date ? date : new Date(date);
    if (!Number.isFinite(value.getTime())) return null;
    return value.toISOString().slice(0, 19).replace('T', ' ');
}

/** Read a MySQL DATETIME (driver may return a Date or a string). */
function fromSqlDate(value) {
    if (!value) return null;
    if (value instanceof Date) return value;
    const text = String(value).replace('T', ' ').slice(0, 19);
    // The pool uses timezone 'Z', so DATETIME values are UTC.
    const date = new Date(`${text.replace(' ', 'T')}Z`);
    return Number.isFinite(date.getTime()) ? date : null;
}

module.exports = {
    DEFAULT_TIMEZONE,
    timezone,
    offsetMinutes,
    zonedToUtc,
    parseWhen,
    addRecurrence,
    formatInZone,
    relativeLabel,
    toSqlDate,
    fromSqlDate,
    parseClock
};
