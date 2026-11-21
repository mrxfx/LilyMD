'use strict';
/**
 * MySQL migrations for Lily MD.
 *
 * Every migration is idempotent (CREATE TABLE IF NOT EXISTS / ADD COLUMN only
 * once) and is recorded in schema_migrations. Startup never drops a table or
 * deletes rows: existing data is always preserved.
 */

const MIGRATIONS = [
    {
        id: '001_core_schema',
        statements: [
            `CREATE TABLE IF NOT EXISTS contacts (
                id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                jid VARCHAR(191) NOT NULL,
                phone VARCHAR(32) NULL,
                push_name VARCHAR(120) NULL,
                language VARCHAR(32) NULL,
                first_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                PRIMARY KEY (id),
                UNIQUE KEY uq_contacts_jid (jid),
                KEY idx_contacts_phone (phone)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

            `CREATE TABLE IF NOT EXISTS conversation_messages (
                id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                contact_id BIGINT UNSIGNED NOT NULL,
                role ENUM('user','assistant') NOT NULL,
                body TEXT NOT NULL,
                had_media TINYINT(1) NOT NULL DEFAULT 0,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (id),
                KEY idx_messages_contact (contact_id, id),
                KEY idx_messages_created (created_at),
                CONSTRAINT fk_messages_contact FOREIGN KEY (contact_id) REFERENCES contacts (id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

            `CREATE TABLE IF NOT EXISTS contact_memories (
                id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                contact_id BIGINT UNSIGNED NOT NULL,
                fact_key VARCHAR(64) NOT NULL,
                fact_value VARCHAR(512) NOT NULL,
                source ENUM('contact','owner') NOT NULL DEFAULT 'contact',
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                PRIMARY KEY (id),
                UNIQUE KEY uq_memory_fact (contact_id, fact_key),
                KEY idx_memory_contact (contact_id),
                CONSTRAINT fk_memory_contact FOREIGN KEY (contact_id) REFERENCES contacts (id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

            `CREATE TABLE IF NOT EXISTS contact_preferences (
                contact_id BIGINT UNSIGNED NOT NULL,
                auto_reply ENUM('inherit','on','off') NOT NULL DEFAULT 'inherit',
                never_reply TINYINT(1) NOT NULL DEFAULT 0,
                tone VARCHAR(200) NULL,
                language VARCHAR(32) NULL,
                delay_sec INT NULL,
                handoff_until DATETIME NULL,
                last_owner_message_at DATETIME NULL,
                needs_review VARCHAR(32) NULL,
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                PRIMARY KEY (contact_id),
                CONSTRAINT fk_prefs_contact FOREIGN KEY (contact_id) REFERENCES contacts (id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

            `CREATE TABLE IF NOT EXISTS owner_style_profile (
                id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                sample TEXT NOT NULL,
                language VARCHAR(32) NULL,
                sample_hash CHAR(64) NOT NULL,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (id),
                UNIQUE KEY uq_style_sample (sample_hash),
                KEY idx_style_created (created_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

            `CREATE TABLE IF NOT EXISTS bot_settings (
                setting_key VARCHAR(64) NOT NULL,
                setting_value TEXT NULL,
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                PRIMARY KEY (setting_key)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
        ]
    },
    {
        id: '002_scheduling',
        statements: [
            `CREATE TABLE IF NOT EXISTS scheduled_jobs (
                id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                public_id CHAR(10) NOT NULL,
                kind ENUM('message','status') NOT NULL DEFAULT 'message',
                target_jid VARCHAR(191) NOT NULL,
                target_type ENUM('contact','group','status') NOT NULL DEFAULT 'contact',
                body TEXT NULL,
                media_type ENUM('none','image','video','document') NOT NULL DEFAULT 'none',
                media_path VARCHAR(255) NULL,
                media_mime VARCHAR(120) NULL,
                media_size BIGINT UNSIGNED NULL,
                run_at DATETIME NOT NULL,
                timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Kolkata',
                recurrence ENUM('none','daily','weekly','monthly') NOT NULL DEFAULT 'none',
                status ENUM('pending','sending','sent','failed','cancelled') NOT NULL DEFAULT 'pending',
                attempts INT UNSIGNED NOT NULL DEFAULT 0,
                max_attempts INT UNSIGNED NOT NULL DEFAULT 3,
                locked_at DATETIME NULL,
                last_error VARCHAR(255) NULL,
                created_by VARCHAR(32) NULL,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                sent_at DATETIME NULL,
                PRIMARY KEY (id),
                UNIQUE KEY uq_jobs_public (public_id),
                KEY idx_jobs_due (status, run_at),
                KEY idx_jobs_target (target_jid),
                KEY idx_jobs_kind (kind, status)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

            `CREATE TABLE IF NOT EXISTS scheduled_job_logs (
                id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                job_id BIGINT UNSIGNED NOT NULL,
                status ENUM('claimed','sent','failed','retry','cancelled') NOT NULL,
                detail VARCHAR(255) NULL,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (id),
                KEY idx_job_logs_job (job_id, id),
                KEY idx_job_logs_created (created_at),
                CONSTRAINT fk_job_logs_job FOREIGN KEY (job_id) REFERENCES scheduled_jobs (id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

            // Real table (not a view): shared MySQL users often lack CREATE VIEW.
            // It mirrors kind='status' jobs for pending/published/failed history;
            // scheduled_jobs stays the single queue that the worker claims.
            `CREATE TABLE IF NOT EXISTS scheduled_status (
                id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                job_public_id CHAR(10) NOT NULL,
                target_jid VARCHAR(191) NOT NULL,
                body TEXT NULL,
                media_type ENUM('none','image','video','document') NOT NULL DEFAULT 'none',
                media_path VARCHAR(255) NULL,
                run_at DATETIME NOT NULL,
                timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Kolkata',
                status ENUM('pending','sending','sent','failed','cancelled') NOT NULL DEFAULT 'pending',
                attempts INT UNSIGNED NOT NULL DEFAULT 0,
                last_error VARCHAR(255) NULL,
                created_by VARCHAR(32) NULL,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                sent_at DATETIME NULL,
                PRIMARY KEY (id),
                UNIQUE KEY uq_status_job (job_public_id),
                KEY idx_status_run (status, run_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
        ]
    }
];

module.exports = { MIGRATIONS };
