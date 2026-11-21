'use strict';
/**
 * MySQL connection pool for Lily MD.
 *
 * Everything is configured through the environment (OptikLink panel):
 *   DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD, DB_CONNECTION_LIMIT
 *
 * - One reusable mysql2/promise pool, created lazily.
 * - Prepared statements only: every value is passed as a query parameter.
 * - Transient socket errors drop the pool and retry once (auto recovery).
 * - A failed connection never stops the bot: callers get a clear "unavailable"
 *   error and the file-based fallbacks keep working.
 * - Passwords and full DSNs are never logged or returned; status() exposes only
 *   booleans, the database name and a short error code.
 */
const path = require('path');

const DEFAULT_PORT = 3306;
const DEFAULT_LIMIT = 10;
const RETRYABLE_CODES = new Set([
    'PROTOCOL_CONNECTION_LOST',
    'PROTOCOL_SEQUENCE_TIMEOUT',
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'EPIPE',
    'ER_CON_COUNT_ERROR',
    'ER_LOCK_WAIT_TIMEOUT',
    'ER_LOCK_DEADLOCK'
]);

let pool = null;
let driver = null;
let ready = false;
let lastError = '';
let lastCheckAt = null;
let lastOkAt = null;
let connecting = null;
let testQuery = null;

function config() {
    const port = Number(process.env.DB_PORT || DEFAULT_PORT);
    const limit = Number(process.env.DB_CONNECTION_LIMIT || DEFAULT_LIMIT);
    return {
        host: String(process.env.DB_HOST || '').trim(),
        port: Number.isFinite(port) && port > 0 ? port : DEFAULT_PORT,
        database: String(process.env.DB_NAME || '').trim(),
        user: String(process.env.DB_USER || '').trim(),
        password: String(process.env.DB_PASSWORD || ''),
        connectionLimit: Number.isFinite(limit) && limit > 0 ? Math.min(50, Math.floor(limit)) : DEFAULT_LIMIT
    };
}

function configured() {
    const c = config();
    return Boolean(c.host && c.database && c.user);
}

function safeError(error) {
    const code = error && (error.code || error.errno);
    const message = String((error && error.message) || error || 'unknown error');
    return `${code ? `${code}: ` : ''}${message}`.replace(/\s+/g, ' ').slice(0, 180);
}

function loadDriver() {
    if (driver) return driver;
    // Lazy: the bot still runs (file fallbacks) when mysql2 is not installed.
    driver = require('mysql2/promise');
    return driver;
}

function makePool() {
    const c = config();
    const mysql = loadDriver();
    const created = mysql.createPool({
        host: c.host,
        port: c.port,
        database: c.database,
        user: c.user,
        password: c.password,
        waitForConnections: true,
        connectionLimit: c.connectionLimit,
        maxIdle: c.connectionLimit,
        idleTimeout: 60000,
        queueLimit: 0,
        enableKeepAlive: true,
        keepAliveInitialDelay: 10000,
        charset: 'utf8mb4',
        timezone: 'Z',
        // A blocked or silent host must fail fast instead of hanging the bot.
        connectTimeout: Math.max(3000, Number(process.env.DB_CONNECT_TIMEOUT_MS) || 10000),
        multipleStatements: false,
        dateStrings: false
    });
    created.on('error', (error) => {
        // Pool-level errors are surfaced through query() as well.
        lastError = safeError(error);
    });
    return created;
}

async function getPool() {
    if (testQuery) return null;
    if (!configured()) {
        const err = new Error('MySQL is not configured (DB_HOST / DB_NAME / DB_USER).');
        err.code = 'DB_NOT_CONFIGURED';
        throw err;
    }
    if (!pool) {
        pool = makePool();
    }
    return pool;
}

/** Connect/verify once. Safe to call repeatedly. */
async function connect() {
    if (testQuery) return true;
    if (!configured()) return false;
    if (connecting) return connecting;
    connecting = (async () => {
        try {
            const current = await getPool();
            const connection = await current.getConnection();
            try {
                await connection.ping();
            } finally {
                connection.release();
            }
            ready = true;
            lastError = '';
            lastCheckAt = lastOkAt = new Date().toISOString();
            return true;
        } catch (error) {
            ready = false;
            lastError = safeError(error);
            lastCheckAt = new Date().toISOString();
            console.error(`[db] connection failed: ${lastError}`);
            return false;
        } finally {
            connecting = null;
        }
    })();
    return connecting;
}

/** Ping the pool; used by the scheduler health tick and .dbstatus. */
async function ping() {
    if (testQuery) {
        lastCheckAt = lastOkAt = new Date().toISOString();
        ready = true;
        return { ok: true, latencyMs: 0 };
    }
    if (!configured()) {
        return { ok: false, error: 'not configured' };
    }
    const started = Date.now();
    try {
        const current = await getPool();
        const connection = await current.getConnection();
        try {
            await connection.ping();
        } finally {
            connection.release();
        }
        ready = true;
        lastError = '';
        lastCheckAt = lastOkAt = new Date().toISOString();
        return { ok: true, latencyMs: Date.now() - started };
    } catch (error) {
        ready = false;
        lastError = safeError(error);
        lastCheckAt = new Date().toISOString();
        // Rebuild the pool on the next call so a dead socket recovers.
        await closePool();
        return { ok: false, error: lastError };
    }
}

async function closePool() {
    if (!pool) return;
    const dying = pool;
    pool = null;
    try {
        await dying.end();
    } catch (error) {
        // ignore: the socket is already gone
    }
}

async function reconnect() {
    await closePool();
    return connect();
}

/**
 * Run one prepared statement. Returns the driver result
 * ([rows, fields] for SELECT, [ResultSetHeader, fields] otherwise).
 */
async function execute(sql, params = []) {
    if (testQuery) return testQuery(sql, params);
    let current;
    try {
        current = await getPool();
        return await current.execute(sql, params);
    } catch (error) {
        if (error && RETRYABLE_CODES.has(error.code)) {
            lastError = safeError(error);
            await closePool();
            const retried = await getPool();
            return retried.execute(sql, params);
        }
        lastError = safeError(error);
        ready = false;
        throw error;
    }
}

const query = execute;

/** Run a set of statements inside a transaction. */
async function transaction(work) {
    if (testQuery) {
        const fake = {
            execute: (sql, params) => testQuery(sql, params),
            beginTransaction: async () => {},
            commit: async () => {},
            rollback: async () => {},
            release: () => {}
        };
        return work(fake);
    }
    const current = await getPool();
    const connection = await current.getConnection();
    try {
        await connection.beginTransaction();
        const result = await work(connection);
        await connection.commit();
        return result;
    } catch (error) {
        try {
            await connection.rollback();
        } catch (rollbackError) {
            // ignore: the transaction is already gone
        }
        throw error;
    } finally {
        connection.release();
    }
}

/** Table counts for .dbstatus (parameterless, fixed SQL). */
async function tableStats() {
    const tables = ['contacts', 'conversation_messages', 'contact_memories', 'scheduled_jobs', 'scheduled_job_logs', 'bot_settings'];
    const stats = {};
    for (const table of tables) {
        try {
            const [rows] = await execute(`SELECT COUNT(*) AS total FROM \`${table}\``);
            stats[table] = Number(rows?.[0]?.total || 0);
        } catch (error) {
            stats[table] = null;
        }
    }
    return stats;
}

function status() {
    const c = config();
    return {
        configured: configured(),
        connected: ready,
        database: c.database || null,
        host: c.host ? c.host.replace(/^[^.]+/, '***') : null,
        connectionLimit: c.connectionLimit,
        poolSize: pool ? pool.pool?.size || pool.pool?._allConnections?.length || null : 0,
        lastCheckAt,
        lastOkAt,
        lastError: lastError || null,
        driver: 'mysql2/promise'
    };
}

function info() {
    return {
        host: config().host,
        port: config().port,
        database: config().database,
        connectionLimit: config().connectionLimit,
        hasPassword: Boolean(config().password)
    };
}

/* ------------------------------------------------------------------ tests */

function __setQueryForTests(fn) {
    testQuery = typeof fn === 'function' ? fn : null;
    ready = Boolean(testQuery);
}

function __resetForTests() {
    testQuery = null;
    pool = null;
    ready = false;
    lastError = '';
}

module.exports = {
    config,
    configured,
    connect,
    reconnect,
    ping,
    execute,
    query,
    transaction,
    tableStats,
    status,
    info,
    close: closePool,
    safeError,
    __setQueryForTests,
    __resetForTests,
    __setPoolForTests: __setQueryForTests
};
