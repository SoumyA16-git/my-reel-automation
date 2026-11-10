import { statSync, unlinkSync, existsSync } from 'node:fs';
import type { Database } from 'better-sqlite3';
import { getDatabase } from '../db/connection.js';
import { getStorageManager, type StorageManager } from './StorageManager.js';
import { NotificationService } from '../notifications/NotificationService.js';
import { logger } from '../logger.js';

export interface DeleteRawFileResult {
  ok: boolean;
  outcome: 'deleted' | 'refused' | 'failed';
  reason?: string | undefined;
  error?: string | undefined;
}

interface RawFileRow {
  id: number;
  reel_id: number;
  role: string;
  storage_name: string;
  size_bytes: number;
  sha256: string;
  state: string;
  in_use_by_job_id: number | null;
}

interface TelegramDestCheckRow {
  destination_id: number;
  record_status: string | null;
  message_id: number | null;
}

export class RawFileDeletionService {
  private readonly db: Database;
  private readonly storage: StorageManager;
  private readonly notifications: NotificationService;

  constructor(db?: Database, storage?: StorageManager) {
    this.db = db ?? getDatabase();
    this.storage = storage ?? getStorageManager();
    this.notifications = new NotificationService(this.db);
  }

  /**
   * Securely delete a raw video file after verified Telegram delivery (PRD Section 13 / FR-018).
   * Checks all 5 hard preconditions inside a transaction before unlinking.
   */
  public deleteRawFile(videoFileId: number, currentJobId?: number | null): DeleteRawFileResult {
    const now = Date.now();

    // 1. Fetch video file details
    const file = this.db
      .prepare<[number], RawFileRow>(`
        SELECT id, reel_id, role, storage_name, size_bytes, sha256, state, in_use_by_job_id
        FROM video_files
        WHERE id = ?
      `)
      .get(videoFileId);

    if (!file) {
      return { ok: false, outcome: 'refused', reason: 'file_not_found', error: `File #${videoFileId} not found` };
    }

    if (file.role !== 'raw') {
      return { ok: false, outcome: 'refused', reason: 'not_raw_role', error: `File role is ${file.role}, not raw` };
    }

    if (file.state === 'deleted') {
      return { ok: true, outcome: 'deleted', reason: 'already_deleted' };
    }

    // -----------------------------------------------------------------------
    // PRECONDITION 1 & 2:
    // Check that every enabled Telegram destination for this Reel has:
    // - Destination status = 'published'
    // - A telegram_messages delivery proof row
    // -----------------------------------------------------------------------
    const telegramDestinations = this.db
      .prepare<[number], TelegramDestCheckRow>(`
        SELECT
          d.id as destination_id,
          pr.status as record_status,
          tm.message_id
        FROM publishing_destinations d
        LEFT JOIN publishing_records pr ON pr.destination_id = d.id AND pr.reel_id = ?
        LEFT JOIN telegram_messages tm ON tm.publishing_record_id = pr.id
        WHERE d.kind = 'telegram' AND d.enabled = 1
      `)
      .all(file.reel_id);

    if (telegramDestinations.length === 0) {
      this.logRefusal(file, 'no_telegram_destination', 'No enabled Telegram destinations configured for Reel', currentJobId);
      return {
        ok: false,
        outcome: 'refused',
        reason: 'no_telegram_destination',
        error: 'No enabled Telegram destinations configured for this Reel',
      };
    }

    for (const dest of telegramDestinations) {
      if (dest.record_status !== 'published') {
        this.logRefusal(
          file,
          'telegram_not_published',
          `Telegram destination #${dest.destination_id} status is ${dest.record_status ?? 'none'}, not published`,
          currentJobId,
        );
        return {
          ok: false,
          outcome: 'refused',
          reason: 'telegram_not_published',
          error: `Telegram destination #${dest.destination_id} has not published yet`,
        };
      }

      if (!dest.message_id) {
        this.logRefusal(
          file,
          'missing_delivery_proof',
          `Missing telegram_messages proof row for destination #${dest.destination_id}`,
          currentJobId,
        );
        return {
          ok: false,
          outcome: 'refused',
          reason: 'missing_delivery_proof',
          error: `Telegram message ID proof missing for destination #${dest.destination_id}`,
        };
      }
    }

    // -----------------------------------------------------------------------
    // PRECONDITION 3:
    // No active job lease references the file (other than current deletion job)
    // -----------------------------------------------------------------------
    if (file.in_use_by_job_id !== null && file.in_use_by_job_id !== currentJobId) {
      // Check if that job is still active
      const activeJob = this.db
        .prepare<[number], { state: string }>(`
          SELECT state FROM background_jobs WHERE id = ? AND state IN ('leased', 'running')
        `)
        .get(file.in_use_by_job_id);

      if (activeJob) {
        this.logRefusal(
          file,
          'active_lease',
          `File is in use by active job #${file.in_use_by_job_id}`,
          currentJobId,
        );
        return {
          ok: false,
          outcome: 'refused',
          reason: 'active_lease',
          error: `File is currently locked by job #${file.in_use_by_job_id}`,
        };
      }
    }

    // -----------------------------------------------------------------------
    // PRECONDITION 4:
    // Path validation: path resolves strictly inside videos/raw/
    // -----------------------------------------------------------------------
    let resolvedPath: string;
    try {
      resolvedPath = this.storage.resolveStoragePath(file.storage_name, 'raw');
    } catch (err) {
      this.logRefusal(file, 'path_security_violation', String(err), currentJobId);
      return {
        ok: false,
        outcome: 'refused',
        reason: 'path_security_violation',
        error: `Security path validation failed: ${String(err)}`,
      };
    }

    // -----------------------------------------------------------------------
    // PRECONDITION 5:
    // Physical file exists and byte size matches
    // -----------------------------------------------------------------------
    if (!existsSync(resolvedPath)) {
      // File already missing from disk
      this.db
        .prepare<[number, number, number]>(`
          UPDATE video_files SET state = 'deleted', deleted_at = ?, updated_at = ? WHERE id = ?
        `)
        .run(now, now, file.id);

      this.logSuccess(file, currentJobId);
      return { ok: true, outcome: 'deleted', reason: 'file_was_already_absent' };
    }

    try {
      const stats = statSync(resolvedPath);
      if (stats.size !== file.size_bytes) {
        this.logRefusal(
          file,
          'size_mismatch',
          `Disk size (${stats.size}) does not match recorded size (${file.size_bytes})`,
          currentJobId,
        );
        return {
          ok: false,
          outcome: 'refused',
          reason: 'size_mismatch',
          error: 'Physical file size mismatch against database record',
        };
      }
    } catch (err) {
      return {
        ok: false,
        outcome: 'failed',
        reason: 'stat_failed',
        error: `Cannot stat file before deletion: ${String(err)}`,
      };
    }

    // -----------------------------------------------------------------------
    // EXECUTION: Unlink file and commit deletion in transaction
    // -----------------------------------------------------------------------
    try {
      unlinkSync(resolvedPath);
      logger.info({ fileId: file.id, path: resolvedPath }, 'Raw video file physically deleted');
    } catch (unlinkErr) {
      logger.error({ unlinkErr, fileId: file.id }, 'Failed to unlink raw video file');

      // Record deletion_failed state
      this.db
        .prepare<[number, number]>(`
          UPDATE video_files SET state = 'deletion_failed', updated_at = ? WHERE id = ?
        `)
        .run(now, file.id);

      this.db
        .prepare<[number, number, number, string, number, string, number | null, string, number]>(`
          INSERT INTO file_deletion_log (
            ts, video_file_id, reel_id, role, storage_name, size_bytes,
            sha256, reason, job_id, outcome, error, created_at
          ) VALUES (?, ?, ?, 'raw', ?, ?, ?, 'telegram_delivered', ?, 'failed', ?, ?)
        `)
        .run(
          now,
          file.id,
          file.reel_id,
          file.storage_name,
          file.size_bytes,
          file.sha256,
          currentJobId ?? null,
          String(unlinkErr),
          now,
        );

      this.notifications.create({
        severity: 'warning',
        type: 'deletion_failed',
        title: `Failed to delete raw video file: ${file.storage_name}`,
        body: `Unlink error: ${String(unlinkErr)}. Click "Retry cleanup" in Reel Manager.`,
        reelId: file.reel_id,
      });

      return {
        ok: false,
        outcome: 'failed',
        error: String(unlinkErr),
      };
    }

    // Unlink succeeded: persist in atomic transaction
    const txn = this.db.transaction(() => {
      this.db
        .prepare<[number, string, number, number]>(`
          UPDATE video_files
          SET state = 'deleted',
              deleted_at = ?,
              deletion_reason = ?,
              in_use_by_job_id = NULL,
              in_use_since = NULL,
              updated_at = ?
          WHERE id = ?
        `)
        .run(now, 'telegram_delivered', now, file.id);

      this.db
        .prepare<[number, number, number, string, number, string, number | null, number]>(`
          INSERT INTO file_deletion_log (
            ts, video_file_id, reel_id, role, storage_name, size_bytes,
            sha256, reason, job_id, outcome, created_at
          ) VALUES (?, ?, ?, 'raw', ?, ?, ?, 'telegram_delivered', ?, 'deleted', ?)
        `)
        .run(
          now,
          file.id,
          file.reel_id,
          file.storage_name,
          file.size_bytes,
          file.sha256,
          currentJobId ?? null,
          now,
        );

      this.notifications.create({
        severity: 'info',
        type: 'raw_deleted',
        title: `Raw video deleted: ${file.storage_name}`,
        body: `Raw video file for Reel #${file.reel_id} securely deleted after verified Telegram delivery.`,
        reelId: file.reel_id,
      });

      logger.info({ fileId: file.id, reelId: file.reel_id }, 'Raw video deletion logged and finalized');
    });

    txn.immediate();
    return { ok: true, outcome: 'deleted' };
  }

  private logRefusal(
    file: RawFileRow,
    reason: string,
    error: string,
    jobId?: number | null,
  ): void {
    const now = Date.now();
    logger.warn({ fileId: file.id, reelId: file.reel_id, reason, error }, 'Raw file deletion refused');

    try {
      this.db
        .prepare<[number, number, number, string, number, string, number | null, string, number]>(`
          INSERT INTO file_deletion_log (
            ts, video_file_id, reel_id, role, storage_name, size_bytes,
            sha256, reason, job_id, outcome, error, created_at
          ) VALUES (?, ?, ?, 'raw', ?, ?, ?, 'telegram_delivered', ?, 'refused', ?, ?)
        `)
        .run(
          now,
          file.id,
          file.reel_id,
          file.storage_name,
          file.size_bytes,
          file.sha256,
          jobId ?? null,
          error,
          now,
        );
    } catch (err) {
      logger.error({ err }, 'Failed to insert file_deletion_log refusal');
    }
  }

  private logSuccess(file: RawFileRow, jobId?: number | null): void {
    const now = Date.now();
    try {
      this.db
        .prepare<[number, number, number, string, number, string, number | null, number]>(`
          INSERT INTO file_deletion_log (
            ts, video_file_id, reel_id, role, storage_name, size_bytes,
            sha256, reason, job_id, outcome, created_at
          ) VALUES (?, ?, ?, 'raw', ?, ?, ?, 'telegram_delivered', ?, 'deleted', ?)
        `)
        .run(
          now,
          file.id,
          file.reel_id,
          file.storage_name,
          file.size_bytes,
          file.sha256,
          jobId ?? null,
          now,
        );
    } catch {
      // Ignore
    }
  }
}
