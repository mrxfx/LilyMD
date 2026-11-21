'use strict';
/**
 * MySQL-backed schedule queue (messages and statuses).
 *
 * Atomic claim: every due row is moved pending -> sending with a conditional
 * UPDATE (WHERE status = 'pending'); only the worker that changed the row may
 * send it, so two ticks or two processes cannot double-send.
 */
const crypto = require('crypto');
const db = require('./db');
const time = require('./scheduleTime');

const BACKOFF_MINUTES = [1, 5, 15, 60];
const MAX_ATTEMPTS = 3;

let warned = false;

function unavailable(error) {
    if (!warned) {
        console.error(`[dbSchedules] MySQL unavailable: ${db.safeError(error)}`);
        warned = true;
    }
    return null;
}

async function ready() {
    if (!db.configured()) return false;
    if (db.status().connected) return true;
    return db.connect();
}

function publicId() {
    return crypto.randomBytes(5).toString('hex').toUpperCase();
}

function mapJob(row) {
    if (!row) return null;
    return {
        id: Number(row.id),
        publicId: row.public_id,
        kind: row.kind,
        target: row.target_jid,
        targetType: row.target_type,
        body: row.body || '',
        mediaType: row.media_type || 'none',
        mediaPath: row.media_path || null,
        mediaMime: row.media_mime || null,
        mediaSize: row.media_size === null || row.media_size === undefined ? null : Number(row.media_size),
        runAt: time.fromSqlDate(row.run_at),
        timezone: row.timezone || time.timezone(),
        recurrence: row.recurrence || 'none',
        status: row.status,
        attempts: Number(row.attempts || 0),
        maxAttempts: Number(row.max_attempts || MAX_ATTEMPTS),
        lastError: row.last_error || null,
        createdBy: row.created_by || null,
        createdAt: time.fromSqlDate(row.created_at),
        sentAt: time.fromSqlDate(row.sent_at)
    };
}

async function createJob(job) {
    try {
        if (!(await ready())) return { ok: false, error: 'Database unavailable' };
        const runAt = job.runAt instanceof Date ? job.runAt : new Date(job.runAt);
        if (!Number.isFinite(runAt.getTime())) return { ok: false, error: 'Invalid run time' };
        const id = publicId();
        await db.execute(
            `INSERT INTO scheduled_jobs
                (public_id, kind, target_jid, target_type, body, media_type, media_path, media_mime, media_size,
                 run_at, timezone, recurrence, status, max_attempts, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
            [
                id,
                job.kind === 'status' ? 'status' : 'message',
                String(job.target || '').slice(0, 191),
                ['contact', 'group', 'status'].includes(job.targetType) ? job.targetType : 'contact',
                String(job.body || '').slice(0, 4000) || null,
                ['none', 'image', 'video', 'document'].includes(job.mediaType) ? job.mediaType : 'none',
                job.mediaPath ? String(job.mediaPath).slice(0, 255) : null,
                job.mediaMime ? String(job.mediaMime).slice(0, 120) : null,
                Number(job.mediaSize || 0) || null,
                time.toSqlDate(runAt),
                String(job.timezone || time.timezone()).slice(0, 64),
                ['none', 'daily', 'weekly', 'monthly'].includes(job.recurrence) ? job.recurrence : 'none',
                Math.max(1, Math.min(5, Number(job.maxAttempts || MAX_ATTEMPTS))),
                job.createdBy ? String(job.createdBy).slice(0, 32) : null
            ]
        );
        if (job.kind === 'status') {
            try {
                await db.execute(
                    `INSERT INTO scheduled_status
                        (job_public_id, target_jid, body, media_type, media_path, run_at, timezone, status, created_by)
                     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
                    [
                        id,
                        String(job.target || 'status@broadcast').slice(0, 191),
                        String(job.body || '').slice(0, 4000) || null,
                        ['none', 'image', 'video', 'document'].includes(job.mediaType) ? job.mediaType : 'none',
                        job.mediaPath ? String(job.mediaPath).slice(0, 255) : null,
                        time.toSqlDate(runAt),
                        String(job.timezone || time.timezone()).slice(0, 64),
                        job.createdBy ? String(job.createdBy).slice(0, 32) : null
                    ]
                );
            } catch (error) {
                // The queue row exists; the history mirror is best-effort.
            }
        }
        return { ok: true, publicId: id };
    } catch (error) {
        return { ok: false, error: db.safeError(error) };
    }
}

/** Keep scheduled_status in step with its queue job (status jobs only). */
async function mirrorStatus(publicIdValue, status, error, attemptIncrement = 0) {
    try {
        await db.execute(
            'UPDATE scheduled_status SET status = ?, attempts = attempts + ?, last_error = ?, sent_at = ? WHERE job_public_id = ?',
            [
                status,
                Math.max(0, Number(attemptIncrement) || 0),
                String(error || '').slice(0, 255) || null,
                status === 'sent' ? time.toSqlDate(new Date()) : null,
                String(publicIdValue || '').toUpperCase()
            ]
        );
    } catch (err) {
        // best-effort mirror
    }
}

async function find(publicIdValue) {
    try {
        if (!(await ready())) return null;
        const [rows] = await db.execute('SELECT * FROM scheduled_jobs WHERE public_id = ? LIMIT 1', [
            String(publicIdValue || '').toUpperCase()
        ]);
        return mapJob(rows?.[0]);
    } catch (error) {
        return unavailable(error);
    }
}

async function listJobs(options = {}) {
    try {
        if (!(await ready())) return null;
        const params = [];
        let where = 'WHERE 1 = 1';
        if (options.status) {
            where += ' AND status = ?';
            params.push(String(options.status));
        }
        if (options.kind) {
            where += ' AND kind = ?';
            params.push(options.kind === 'status' ? 'status' : 'message');
        }
        if (options.upcoming) {
            where += " AND status IN ('pending','sending')";
        }
        const limit = Math.max(1, Math.min(100, Number(options.limit || 10)));
        const [rows] = await db.execute(
            `SELECT * FROM scheduled_jobs ${where} ORDER BY run_at ASC, id ASC LIMIT ?`,
            [...params, limit]
        );
        return (rows || []).map(mapJob);
    } catch (error) {
        return unavailable(error);
    }
}

async function updateJob(publicIdValue, patch) {
    try {
        if (!(await ready())) return { ok: false, error: 'Database unavailable' };
        const fields = [];
        const params = [];
        if (patch.body !== undefined) {
            fields.push('body = ?');
            params.push(String(patch.body || '').slice(0, 4000) || null);
        }
        if (patch.runAt) {
            fields.push('run_at = ?');
            params.push(time.toSqlDate(patch.runAt));
        }
        if (patch.recurrence) {
            fields.push('recurrence = ?');
            params.push(['none', 'daily', 'weekly', 'monthly'].includes(patch.recurrence) ? patch.recurrence : 'none');
        }
        if (patch.mediaPath !== undefined) {
            fields.push('media_path = ?', 'media_type = ?', 'media_mime = ?', 'media_size = ?');
            params.push(patch.mediaPath, patch.mediaType || 'none', patch.mediaMime || null, Number(patch.mediaSize || 0) || null);
        }
        if (!fields.length) return { ok: false, error: 'Nothing to update' };
        params.push(String(publicIdValue || '').toUpperCase());
        const [result] = await db.execute(
            `UPDATE scheduled_jobs SET ${fields.join(', ')} WHERE public_id = ? AND status = 'pending'`,
            params
        );
        if (!Number(result?.affectedRows || 0)) return { ok: false, error: 'No pending schedule with that id' };
        return { ok: true };
    } catch (error) {
        return { ok: false, error: db.safeError(error) };
    }
}

async function cancelJob(publicIdValue) {
    try {
        if (!(await ready())) return { ok: false, error: 'Database unavailable' };
        const [result] = await db.execute(
            "UPDATE scheduled_jobs SET status = 'cancelled', locked_at = NULL WHERE public_id = ? AND status = 'pending'",
            [String(publicIdValue || '').toUpperCase()]
        );
        if (!Number(result?.affectedRows || 0)) return { ok: false, error: 'No pending schedule with that id' };
        await log(publicIdValue, 'cancelled', 'Cancelled by owner');
        await mirrorStatus(publicIdValue, 'cancelled', null);
        return { ok: true };
    } catch (error) {
        return { ok: false, error: db.safeError(error) };
    }
}

async function deleteJob(publicIdValue) {
    try {
        if (!(await ready())) return { ok: false, error: 'Database unavailable' };
        const [result] = await db.execute(
            "DELETE FROM scheduled_jobs WHERE public_id = ? AND status IN ('cancelled','failed','sent')",
            [String(publicIdValue || '').toUpperCase()]
        );
        if (!Number(result?.affectedRows || 0)) {
            return { ok: false, error: 'Only cancelled, failed or finished schedules can be deleted (cancel it first)' };
        }
        return { ok: true };
    } catch (error) {
        return { ok: false, error: db.safeError(error) };
    }
}

async function log(jobIdOrPublic, status, detail) {
    try {
        if (!(await ready())) return;
        const [rows] = await db.execute(
            'SELECT id FROM scheduled_jobs WHERE public_id = ? OR id = ? LIMIT 1',
            [String(jobIdOrPublic || '').toUpperCase(), Number(jobIdOrPublic) || 0]
        );
        const jobId = rows?.[0]?.id;
        if (!jobId) return;
        await db.execute(
            'INSERT INTO scheduled_job_logs (job_id, status, detail) VALUES (?, ?, ?)',
            [jobId, status, String(detail || '').slice(0, 255) || null]
        );
    } catch (error) {
        // logging must never break a send
    }
}

/**
 * Claim up to `limit` due jobs. Each row is updated conditionally, so a job is
 * returned to exactly one caller even with overlapping ticks.
 */
async function claimDue(limit = 5, now = new Date()) {
    try {
        if (!(await ready())) return [];
        const [rows] = await db.execute(
            `SELECT * FROM scheduled_jobs
             WHERE status = 'pending' AND run_at <= ?
             ORDER BY run_at ASC, id ASC LIMIT ?`,
            [time.toSqlDate(now), Math.max(1, Math.min(20, Number(limit) || 5))]
        );
        const claimed = [];
        for (const row of rows || []) {
            const [result] = await db.execute(
                `UPDATE scheduled_jobs
                 SET status = 'sending', locked_at = ?, attempts = attempts + 1
                 WHERE id = ? AND status = 'pending'`,
                [time.toSqlDate(new Date()), row.id]
            );
            if (!Number(result?.affectedRows || 0)) continue; // another worker won
            await log(row.public_id, 'claimed', `Attempt ${Number(row.attempts || 0) + 1}`);
            claimed.push(mapJob({ ...row, status: 'sending', attempts: Number(row.attempts || 0) + 1 }));
        }
        return claimed;
    } catch (error) {
        unavailable(error);
        return [];
    }
}

async function markSent(job) {
    try {
        if (!(await ready())) return false;
        const [result] = await db.execute(
            "UPDATE scheduled_jobs SET status = 'sent', sent_at = ?, locked_at = NULL, last_error = NULL WHERE id = ? AND status = 'sending'",
            [time.toSqlDate(new Date()), job.id]
        );
        await log(job.publicId, 'sent', job.kind === 'status' ? 'Status published' : 'Message sent');
        if (job.kind === 'status') await mirrorStatus(job.publicId, 'sent', null, 1);
        return Number(result?.affectedRows || 0) > 0;
    } catch (error) {
        return unavailable(error);
    }
}

async function markFailed(job, error, retry = true) {
    try {
        if (!(await ready())) return false;
        const attempts = Number(job.attempts || 1);
        const canRetry = retry && attempts < Number(job.maxAttempts || MAX_ATTEMPTS);
        if (canRetry) {
            const delay = BACKOFF_MINUTES[Math.min(attempts - 1, BACKOFF_MINUTES.length - 1)];
            const next = new Date(Date.now() + delay * 60000);
            await db.execute(
                "UPDATE scheduled_jobs SET status = 'pending', run_at = ?, locked_at = NULL, last_error = ? WHERE id = ? AND status = 'sending'",
                [time.toSqlDate(next), String(error || '').slice(0, 255), job.id]
            );
            await log(job.publicId, 'retry', `Retry in ${delay}m: ${String(error || '').slice(0, 180)}`);
            if (job.kind === 'status') await mirrorStatus(job.publicId, 'pending', error, 1);
            return 'retry';
        }
        await db.execute(
            "UPDATE scheduled_jobs SET status = 'failed', locked_at = NULL, last_error = ? WHERE id = ? AND status = 'sending'",
            [String(error || '').slice(0, 255), job.id]
        );
        await log(job.publicId, 'failed', String(error || '').slice(0, 180));
        if (job.kind === 'status') await mirrorStatus(job.publicId, 'failed', error, 1);
        return 'failed';
    } catch (err) {
        return unavailable(err);
    }
}

/** Move a job for a recurring schedule to its next occurrence. */
async function rescheduleRecurring(job, nextRunAt) {
    try {
        if (!(await ready())) return null;
        const id = publicId();
        await db.execute(
            `INSERT INTO scheduled_jobs
                (public_id, kind, target_jid, target_type, body, media_type, media_path, media_mime, media_size,
                 run_at, timezone, recurrence, status, max_attempts, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
            [
                id,
                job.kind,
                job.target,
                job.targetType,
                job.body || null,
                job.mediaType || 'none',
                job.mediaPath || null,
                job.mediaMime || null,
                job.mediaSize || null,
                time.toSqlDate(nextRunAt),
                job.timezone || time.timezone(),
                job.recurrence || 'none',
                job.maxAttempts || MAX_ATTEMPTS,
                job.createdBy || null
            ]
        );
        return id;
    } catch (error) {
        return unavailable(error);
    }
}

/** Jobs left in 'sending' by a crash go back to the queue (attempt already counted). */
async function releaseStale(leaseMinutes = 10) {
    try {
        if (!(await ready())) return 0;
        const cutoff = time.toSqlDate(new Date(Date.now() - Math.max(1, leaseMinutes) * 60000));
        const [result] = await db.execute(
            "UPDATE scheduled_jobs SET status = 'pending', locked_at = NULL WHERE status = 'sending' AND (locked_at IS NULL OR locked_at < ?)",
            [cutoff]
        );
        return Number(result?.affectedRows || 0);
    } catch (error) {
        return unavailable(error) || 0;
    }
}

async function history(limit = 10) {
    try {
        if (!(await ready())) return null;
        const [rows] = await db.execute(
            `SELECT l.status, l.detail, l.created_at, j.public_id, j.kind, j.target_jid, j.run_at
             FROM scheduled_job_logs l
             JOIN scheduled_jobs j ON j.id = l.job_id
             WHERE l.status IN ('sent','failed','retry','cancelled')
             ORDER BY l.id DESC LIMIT ?`,
            [Math.max(1, Math.min(50, Number(limit) || 10))]
        );
        return (rows || []).map((row) => ({
            status: row.status,
            detail: row.detail || '',
            at: time.fromSqlDate(row.created_at),
            publicId: row.public_id,
            kind: row.kind,
            target: row.target_jid,
            runAt: time.fromSqlDate(row.run_at)
        }));
    } catch (error) {
        return unavailable(error);
    }
}

async function statusSummary() {
    try {
        if (!(await ready())) return null;
        const [rows] = await db.execute(
            "SELECT status, COUNT(*) AS total FROM scheduled_jobs WHERE kind = 'status' GROUP BY status"
        );
        const summary = { pending: 0, sending: 0, sent: 0, failed: 0, cancelled: 0 };
        for (const row of rows || []) summary[row.status] = Number(row.total || 0);
        const [next] = await db.execute(
            "SELECT * FROM scheduled_jobs WHERE kind = 'status' AND status = 'pending' ORDER BY run_at ASC LIMIT 1"
        );
        return { ...summary, next: mapJob(next?.[0]) };
    } catch (error) {
        return unavailable(error);
    }
}

module.exports = {
    BACKOFF_MINUTES,
    MAX_ATTEMPTS,
    createJob,
    find,
    listJobs,
    updateJob,
    cancelJob,
    deleteJob,
    log,
    claimDue,
    markSent,
    markFailed,
    releaseStale,
    rescheduleRecurring,
    history,
    statusSummary
};
