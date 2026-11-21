'use strict';
/**
 * Migration runner. Creates schema_migrations if needed, then applies each
 * missing migration once. Never drops or truncates anything.
 */
const db = require('./db');
const { MIGRATIONS } = require('./migrations');

const MIGRATIONS_TABLE = `CREATE TABLE IF NOT EXISTS schema_migrations (
    id VARCHAR(64) NOT NULL,
    applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

async function appliedMigrations() {
    const [rows] = await db.execute('SELECT id FROM schema_migrations ORDER BY id');
    return new Set((rows || []).map((row) => row.id));
}

async function runMigrations(options = {}) {
    if (!db.configured()) {
        return { ok: false, applied: [], error: 'MySQL is not configured' };
    }
    const log = options.log || ((line) => console.log(line));
    try {
        await db.execute(MIGRATIONS_TABLE);
        const done = await appliedMigrations();
        const applied = [];
        for (const migration of MIGRATIONS) {
            if (done.has(migration.id)) continue;
            for (const statement of migration.statements) {
                await db.execute(statement);
            }
            await db.execute('INSERT INTO schema_migrations (id) VALUES (?)', [migration.id]);
            applied.push(migration.id);
        }
        if (applied.length) log(`[db] migrations applied: ${applied.join(', ')}`);
        return { ok: true, applied };
    } catch (error) {
        const message = db.safeError(error);
        console.error(`[db] migration failed: ${message}`);
        return { ok: false, applied: [], error: message };
    }
}

module.exports = { runMigrations, appliedMigrations, MIGRATIONS_TABLE };
