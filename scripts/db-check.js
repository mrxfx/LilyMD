'use strict';
/**
 * Live database check for a deployment (OptikLink panel or local .env):
 *
 *   npm run db:check
 *
 * Connects, applies pending migrations, pings, and prints safe status only
 * (database name, latency, table counts). Never prints the host user, the
 * password or any DSN, and never modifies existing rows.
 */
const db = require('../lib/db');
const { runMigrations } = require('../lib/migrate');

async function main() {
    if (!db.configured()) {
        console.error('✗ MySQL is not configured. Set DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD.');
        process.exitCode = 1;
        return;
    }
    const connected = await db.connect();
    if (!connected) {
        const state = db.status();
        console.error(`✗ Could not connect to the database${state.database ? ` (${state.database})` : ''}: ${state.lastError || 'unknown error'}`);
        process.exitCode = 1;
        return;
    }
    const migrated = await runMigrations();
    if (!migrated.ok) {
        console.error(`✗ Migrations failed: ${migrated.error}`);
        process.exitCode = 1;
        return;
    }
    const ping = await db.ping();
    const stats = await db.tableStats();
    console.log('✓ Connected to MySQL');
    console.log(`  database: ${db.status().database} · latency ${ping.latencyMs} ms · pool limit ${db.status().connectionLimit}`);
    console.log(`  migrations applied now: ${migrated.applied.length ? migrated.applied.join(', ') : 'none (already up to date)'}`);
    console.log('  rows:');
    for (const [table, count] of Object.entries(stats)) {
        console.log(`    ${table}: ${count === null ? 'unreadable' : count}`);
    }
    await db.close();
}

main().catch((error) => {
    console.error(`✗ Database check failed: ${db.safeError(error)}`);
    process.exitCode = 1;
});
