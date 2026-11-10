import type { Database } from 'better-sqlite3';
import { getDatabase } from '../db/connection.js';
import { getStorageManager, type StorageManager } from '../storage/StorageManager.js';
import { JobQueue } from './JobQueue.js';
import { recomputeAndSaveReelStatus } from '../reels/stateMachine.js';
import { NotificationService } from '../notifications/NotificationService.js';
import { logger } from '../logger.js';

interface ExpiredJobRow {
  id: number;
  type: string;
  reel_id: number | null;
  destination_id: number | null;
  publishing_record_id: number | null;
  attempts: number;
  max_attempts: number;
}

interface PublishingRecordRow {
  id: number;
  phase: string;
  status: string;
}

interface VideoFileCheckRow {
  id: number;
  reel_id: number;
  role: 'censored' | 'raw';
  storage_name: string;
  original_filename: string;
}

export interface RecoverySummary {
  ok: boolean;
  integrityPassed: boolean;
  recoveredJobsCount: number;
  clearedLocksCount: number;
  purgedTempFiles: number;
  purgedQuarantineFiles: number;
  missingFilesCount: number;
  error?: string | undefined;
}

export class RecoveryService {
  private readonly db: Database;
  private readonly storage: StorageManager;
  private readonly queue: JobQueue;
  private readonly notifications: NotificationService;

  constructor(db?: Database, storage?: StorageManager) {
    this.db = db ?? getDatabase();
    this.storage = storage ?? getStorageManager();
    this.queue = new JobQueue(this.db);
    this.notifications = new NotificationService(this.db);
  }

  /**
   * Run startup integrity check (PRAGMA quick_check).
   * If corrupted, automatically pause automation and notify admin.
   */
  public runIntegrityCheck(): boolean {
    try {
      const result = this.db.pragma('quick_check', { simple: true }) as string;
      if (result === 'ok') {
        logger.info('Database quick_check passed');
        return true;
      }

      logger.error({ result }, 'CRITICAL: Database quick_check failed!');
      this.pauseAutomation('Database quick_check failed: ' + result);
      this.notifications.create({
        severity: 'critical',
        type: 'database_corrupted',
        title: 'Database integrity check failed',
        body: `SQLite quick_check returned: ${result}. Automation has been automatically paused.`,
      });
      return false;
    } catch (err) {
      logger.error({ err }, 'Failed to execute PRAGMA quick_check');
      this.pauseAutomation('Failed to execute PRAGMA quick_check');
      return false;
    }
  }

  /**
   * Recover jobs with expired leases or from a previous process crash.
   */
  public recoverStaleLeases(): number {
    const txn = this.db.transaction(() => {
      const now = Date.now();
      const expiredJobs = this.db
        .prepare<[number], ExpiredJobRow>(`
          SELECT id, type, reel_id, destination_id, publishing_record_id, attempts, max_attempts
          FROM background_jobs
          WHERE state IN ('leased', 'running') AND lease_expires_at < ?
        `)
        .all(now);

      if (expiredJobs.length === 0) {
        return 0;
      }

      logger.warn({ count: expiredJobs.length }, 'Found jobs with expired leases during recovery');

      const affectedReelIds = new Set<number>();

      for (const job of expiredJobs) {
        if (job.reel_id) {
          affectedReelIds.add(job.reel_id);
        }

        // 1. Mark in-progress attempt as abandoned
        this.db
          .prepare<[number, string, string, number]>(`
            UPDATE publishing_attempts
            SET outcome = 'abandoned',
                finished_at = ?,
                error_code = ?,
                error_message = ?
            WHERE job_id = ? AND outcome IS NULL
          `)
          .run(now, 'WORKER_CRASHED', 'Worker crashed or lease expired', job.id);

        // 2. Check publishing record if present
        let record: PublishingRecordRow | undefined;
        if (job.publishing_record_id) {
          record = this.db
            .prepare<[number], PublishingRecordRow>(`
              SELECT id, phase, status
              FROM publishing_records
              WHERE id = ?
            `)
            .get(job.publishing_record_id);
        } else if (job.reel_id && job.destination_id) {
          record = this.db
            .prepare<[number, number], PublishingRecordRow>(`
              SELECT id, phase, status
              FROM publishing_records
              WHERE reel_id = ? AND destination_id = ?
            `)
            .get(job.reel_id, job.destination_id);
        }

        if (record) {
          if (record.phase === 'published') {
            // Already published remotely before crash! Mark job succeeded
            this.db
              .prepare<[number, number, number]>(`
                UPDATE background_jobs
                SET state = 'succeeded',
                    finished_at = ?,
                    lease_owner = NULL,
                    lease_expires_at = NULL,
                    updated_at = ?
                WHERE id = ?
              `)
              .run(now, now, job.id);

            this.db
              .prepare<[number, number]>(`
                UPDATE publishing_records
                SET status = 'published',
                    updated_at = ?
                WHERE id = ?
              `)
              .run(now, record.id);
          } else if (record.phase === 'publish_requested') {
            // Request was sent, outcome uncertain! (PRD 19.6 item 2)
            this.db
              .prepare<[string, string, number, number]>(`
                UPDATE background_jobs
                SET state = 'failed',
                    last_error_code = ?,
                    last_error_message = ?,
                    lease_owner = NULL,
                    lease_expires_at = NULL,
                    updated_at = ?
                WHERE id = ?
              `)
              .run(
                'UNCERTAIN_OUTCOME',
                'Worker died while publish request was in-flight; destination outcome is uncertain',
                now,
                job.id,
              );

            this.db
              .prepare<[number, number]>(`
                UPDATE publishing_records
                SET status = 'uncertain',
                    updated_at = ?
                WHERE id = ?
              `)
              .run(now, record.id);

            // Enqueue reconcile.destination job
            this.queue.enqueue({
              type: 'reconcile.destination',
              dedupeKey: `reconcile:${record.id}:${now}`,
              reelId: job.reel_id,
              destinationId: job.destination_id,
              publishingRecordId: record.id,
              priority: 50,
              createdBy: 'system',
            });
          } else {
            // Pre-publish phase: safe to re-queue and resume from checkpoint!
            this.db
              .prepare<[number, number]>(`
                UPDATE background_jobs
                SET state = 'queued',
                    lease_owner = NULL,
                    lease_expires_at = NULL,
                    updated_at = ?
                WHERE id = ?
              `)
              .run(now, job.id);

            this.db
              .prepare<[number, number]>(`
                UPDATE publishing_records
                SET status = 'queued',
                    updated_at = ?
                WHERE id = ?
              `)
              .run(now, record.id);
          }
        } else {
          // Job without publishing record (e.g. ai.generate, probe, cleanup)
          if (job.attempts < job.max_attempts) {
            this.db
              .prepare<[number, number]>(`
                UPDATE background_jobs
                SET state = 'queued',
                    lease_owner = NULL,
                    lease_expires_at = NULL,
                    updated_at = ?
                WHERE id = ?
              `)
              .run(now, job.id);
          } else {
            this.db
              .prepare<[number, string, string, number, number]>(`
                UPDATE background_jobs
                SET state = 'dead',
                    finished_at = ?,
                    last_error_code = ?,
                    last_error_message = ?,
                    lease_owner = NULL,
                    lease_expires_at = NULL,
                    updated_at = ?
                WHERE id = ?
              `)
              .run(now, 'EXHAUSTED', 'Exhausted maximum retry attempts after crash', now, job.id);
          }
        }
      }

      // Recompute status for affected reels
      for (const reelId of affectedReelIds) {
        recomputeAndSaveReelStatus(this.db, reelId);
      }

      return expiredJobs.length;
    });

    return txn.immediate();
  }

  /**
   * Release stale file locks whose job is no longer actively leased or running.
   */
  public clearStaleFileLocks(): number {
    const now = Date.now();
    const result = this.db
      .prepare<[number]>(`
        UPDATE video_files
        SET in_use_by_job_id = NULL,
            in_use_since = NULL,
            updated_at = ?
        WHERE in_use_by_job_id IS NOT NULL
          AND in_use_by_job_id NOT IN (
            SELECT id FROM background_jobs WHERE state IN ('leased', 'running')
          )
      `)
      .run(now);

    if (result.changes > 0) {
      logger.info({ cleared: result.changes }, 'Cleared stale file locks');
    }
    return result.changes;
  }

  /**
   * Purge orphan temp files older than 24 hours.
   */
  public purgeOldTempFiles(): number {
    return this.storage.cleanOldTempFiles(24 * 3600 * 1000);
  }

  /**
   * Purge expired quarantined files older than retention policy (default 7 days).
   */
  public purgeOldQuarantinedFiles(maxAgeMs = 7 * 24 * 3600 * 1000): number {
    return this.storage.cleanOldQuarantineFiles(maxAgeMs);
  }

  /**
   * Verify all active video files (state='present') exist on disk.
   * If missing, mark as missing and notify admin.
   */
  public verifyActiveFilesExist(): number {
    const presentFiles = this.db
      .prepare<[], VideoFileCheckRow>(`
        SELECT id, reel_id, role, storage_name, original_filename
        FROM video_files
        WHERE state = 'present'
      `)
      .all();

    let missingCount = 0;
    const now = Date.now();

    for (const file of presentFiles) {
      const exists = this.storage.fileExists(file.storage_name, file.role);
      if (!exists) {
        missingCount++;
        logger.error(
          { fileId: file.id, reelId: file.reel_id, name: file.storage_name },
          'CRITICAL: Active video file is missing from disk!',
        );

        this.db
          .prepare<[number, number]>(`
            UPDATE video_files
            SET state = 'missing',
                updated_at = ?
            WHERE id = ?
          `)
          .run(now, file.id);

        this.notifications.create({
          severity: 'critical',
          type: 'file_missing',
          title: `Video file missing from storage: ${file.original_filename}`,
          body: `File ${file.storage_name} (${file.role}) for Reel #${file.reel_id} was not found on disk.`,
          reelId: file.reel_id,
        });

        // Recompute reel state
        recomputeAndSaveReelStatus(this.db, file.reel_id);
      }
    }

    return missingCount;
  }

  /**
   * Perform complete startup recovery sweep (PRD 19.6 / NFR-001).
   */
  public performStartupRecovery(): RecoverySummary {
    logger.info('Starting crash and restart recovery sweep');

    // 1. Integrity check
    const integrityPassed = this.runIntegrityCheck();
    if (!integrityPassed) {
      return {
        ok: false,
        integrityPassed: false,
        recoveredJobsCount: 0,
        clearedLocksCount: 0,
        purgedTempFiles: 0,
        purgedQuarantineFiles: 0,
        missingFilesCount: 0,
        error: 'Database integrity check failed. Safe mode activated.',
      };
    }

    // 2. Recover stale leases
    const recoveredJobsCount = this.recoverStaleLeases();

    // 3. Clear stale file locks
    const clearedLocksCount = this.clearStaleFileLocks();

    // 4. Purge old temp files & expired quarantined files
    const purgedTempFiles = this.purgeOldTempFiles();
    const purgedQuarantineFiles = this.purgeOldQuarantinedFiles();

    // 5. Verify active files exist
    const missingFilesCount = this.verifyActiveFilesExist();

    logger.info(
      {
        recoveredJobsCount,
        clearedLocksCount,
        purgedTempFiles,
        purgedQuarantineFiles,
        missingFilesCount,
      },
      'Crash and restart recovery sweep completed',
    );

    return {
      ok: true,
      integrityPassed: true,
      recoveredJobsCount,
      clearedLocksCount,
      purgedTempFiles,
      purgedQuarantineFiles,
      missingFilesCount,
    };
  }

  private pauseAutomation(reason: string): void {
    const now = Date.now();
    this.db
      .prepare<[number, number]>(`
        INSERT INTO application_settings (key, value, is_secret, updated_at)
        VALUES ('automation_paused', 'true', 0, ?)
        ON CONFLICT(key) DO UPDATE SET value = 'true', updated_at = ?
      `)
      .run(now, now);
    logger.warn({ reason }, 'Automation paused due to recovery action');
  }
}
