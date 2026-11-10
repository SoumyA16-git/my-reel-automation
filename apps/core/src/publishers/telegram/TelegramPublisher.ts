import type { Database } from 'better-sqlite3';
import { getDatabase } from '../../db/connection.js';
import { getStorageManager, type StorageManager } from '../../storage/StorageManager.js';
import {
  TelegramClient,
  TelegramRateLimitError,
  TelegramAuthError,
  TelegramError,
} from './TelegramClient.js';
import { JobQueue, type JobRow } from '../../queue/JobQueue.js';
import { decrypt } from '../../crypto/index.js';
import { recomputeAndSaveReelStatus } from '../../reels/stateMachine.js';
import { NotificationService } from '../../notifications/NotificationService.js';
import { logger } from '../../logger.js';

export interface TelegramPublishResult {
  ok: boolean;
  status: 'published' | 'failed_retryable' | 'needs_action' | 'needs_auth' | 'uncertain';
  messageId?: number | undefined;
  error?: string | undefined;
  retryAfterSeconds?: number | undefined;
}

interface RecordDetailsRow {
  id: number;
  reel_id: number;
  destination_id: number;
  video_file_id: number;
  ai_content_id: number;
  status: string;
  phase: string;
  attempt_count: number;
}

interface DestinationRow {
  id: number;
  kind: string;
  account_id: number;
  label: string;
  target_id: string;
  video_role: string;
  config: string;
  enabled: number;
  paused: number;
}

interface AccountRow {
  id: number;
  provider: string;
  token_enc: Buffer | null;
  status: string;
}

interface VideoFileRow {
  id: number;
  role: string;
  storage_name: string;
  size_bytes: number;
  sha256: string;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  state: string;
}

interface AiContentRow {
  id: number;
  title: string;
  hashtags: string;
}

export class TelegramPublisher {
  private readonly db: Database;
  private readonly storage: StorageManager;
  private readonly queue: JobQueue;
  private readonly notifications: NotificationService;
  private readonly telegramClient: TelegramClient;

  constructor(db?: Database, storage?: StorageManager, telegramClient?: TelegramClient) {
    this.db = db ?? getDatabase();
    this.storage = storage ?? getStorageManager();
    this.queue = new JobQueue(this.db);
    this.notifications = new NotificationService(this.db);
    this.telegramClient = telegramClient ?? new TelegramClient();
  }

  /**
   * Execute Telegram publish job (PRD Section 12).
   */
  public async publish(job: JobRow, workerId: string): Promise<TelegramPublishResult> {
    const now = Date.now();

    // 1. Load publishing record
    let record: RecordDetailsRow | undefined;
    if (job.publishing_record_id) {
      record = this.db
        .prepare<[number], RecordDetailsRow>('SELECT * FROM publishing_records WHERE id = ?')
        .get(job.publishing_record_id);
    } else if (job.reel_id && job.destination_id) {
      record = this.db
        .prepare<[number, number], RecordDetailsRow>(
          'SELECT * FROM publishing_records WHERE reel_id = ? AND destination_id = ?',
        )
        .get(job.reel_id, job.destination_id);
    }

    if (!record) {
      throw new Error(`Publishing record not found for job #${job.id}`);
    }

    // 2. Load destination and connected account
    const destination = this.db
      .prepare<[number], DestinationRow>('SELECT * FROM publishing_destinations WHERE id = ?')
      .get(record.destination_id);

    if (!destination || destination.kind !== 'telegram') {
      throw new Error(`Invalid destination #${record.destination_id} for Telegram publisher`);
    }

    const account = this.db
      .prepare<[number], AccountRow>('SELECT * FROM connected_accounts WHERE id = ?')
      .get(destination.account_id);

    if (!account || !account.token_enc) {
      this.markNeedsAuth(destination.id, account?.id, 'Telegram bot token is missing or not configured');
      return { ok: false, status: 'needs_auth', error: 'Telegram bot token missing' };
    }

    // Decrypt bot token
    let botToken: string;
    try {
      botToken = decrypt(account.token_enc);
    } catch (err) {
      this.markNeedsAuth(destination.id, account.id, 'Failed to decrypt Telegram bot token');
      return { ok: false, status: 'needs_auth', error: 'Failed to decrypt bot token' };
    }

    // 3. Load raw video file and caption
    const rawFile = this.db
      .prepare<[number], VideoFileRow>('SELECT * FROM video_files WHERE id = ?')
      .get(record.video_file_id);

    if (!rawFile || rawFile.role !== 'raw' || rawFile.state !== 'present') {
      throw new Error(`Raw video file #${record.video_file_id} not available or not present`);
    }

    const filePath = this.storage.resolveStoragePath(rawFile.storage_name, 'raw');

    // Size limit check (PRD 12.2: Cloud Bot API max 50 MB)
    const MAX_CLOUD_BYTES = 50 * 1024 * 1024;
    if (rawFile.size_bytes > MAX_CLOUD_BYTES) {
      const msg = 'File exceeds Telegram limit (50 MB) — enable the local Bot API server';
      logger.error({ fileId: rawFile.id, size: rawFile.size_bytes }, msg);

      this.db
        .prepare<[string, number, number]>(`
          UPDATE publishing_records
          SET status = 'needs_action',
              last_error_code = 'SIZE_LIMIT_EXCEEDED',
              last_error_message = ?,
              updated_at = ?
          WHERE id = ?
        `)
        .run(msg, now, record.id);

      this.notifications.create({
        severity: 'warning',
        type: 'publish_failed',
        title: 'Telegram publish failed: file exceeds 50 MB limit',
        body: msg,
        reelId: record.reel_id,
        destinationId: destination.id,
      });

      this.queue.finalizeJob(job.id, workerId, 'failed', {
        code: 'SIZE_LIMIT_EXCEEDED',
        message: msg,
      });

      return { ok: false, status: 'needs_action', error: msg };
    }

    // Caption formatting
    const captionRow = this.db
      .prepare<[number], AiContentRow>('SELECT * FROM ai_content WHERE id = ?')
      .get(record.ai_content_id);

    let captionText = '';
    if (captionRow) {
      let hashtags: string[] = [];
      try {
        hashtags = JSON.parse(captionRow.hashtags) as string[];
      } catch {
        hashtags = [];
      }
      captionText = `${captionRow.title}\n\n${hashtags.join(' ')}`;
    }

    // 4. Create attempt row and acquire file lock
    const attemptNo = record.attempt_count + 1;
    const attemptInfo = this.db
      .prepare<[number, number, number, string, number, number, number]>(`
        INSERT INTO publishing_attempts (
          publishing_record_id, job_id, attempt_no, worker_id, started_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(record.id, job.id, attemptNo, workerId, now, now, now);

    const attemptId = Number(attemptInfo.lastInsertRowid);

    // Acquire file lock for raw file
    this.queue.acquireFileLock(job.id, rawFile.id);

    // Update phase to upload_started
    this.db
      .prepare<[number, number]>(`
        UPDATE publishing_records
        SET phase = 'upload_started',
            status = 'in_progress',
            attempt_count = attempt_count + 1,
            updated_at = ?
        WHERE id = ?
      `)
      .run(now, record.id);

    // 5. Send video via Telegram Bot API
    const startTime = Date.now();
    try {
      const res = await this.telegramClient.sendVideo(botToken, {
        chatId: destination.target_id,
        filePath,
        caption: captionText,
        duration: rawFile.duration_ms ? Math.round(rawFile.duration_ms / 1000) : undefined,
        width: rawFile.width ?? undefined,
        height: rawFile.height ?? undefined,
        supportsStreaming: true,
      });

      const durationMs = Date.now() - startTime;

      // 6. SUCCESS: Commit in ONE atomic transaction (PRD 12.3 / FR-015)
      const txn = this.db.transaction(() => {
        const finishTime = Date.now();

        // A. Insert telegram_messages delivery proof
        this.db
          .prepare<
            [
              number,
              string,
              number,
              number,
              string | null,
              string | null,
              number | null,
              number | null,
              string | null,
              number,
              string,
              string,
              number,
              number,
            ]
          >(`
            INSERT INTO telegram_messages (
              publishing_record_id, chat_id, message_id, message_date,
              file_id, file_unique_id, size_bytes, duration_s,
              caption_sent, delivered_at, verification_method, api_response,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `)
          .run(
            record.id,
            String(res.chat.id),
            res.message_id,
            res.date,
            res.video?.file_id ?? null,
            res.video?.file_unique_id ?? null,
            res.video?.file_size ?? null,
            res.video?.duration ?? null,
            captionText,
            finishTime,
            'api_response',
            JSON.stringify(res),
            finishTime,
            finishTime,
          );

        // B. Update publishing_records
        this.db
          .prepare<[string, number, number, number]>(`
            UPDATE publishing_records
            SET status = 'published',
                phase = 'published',
                remote_post_id = ?,
                published_at = ?,
                updated_at = ?
            WHERE id = ?
          `)
          .run(String(res.message_id), finishTime, finishTime, record.id);

        // C. Update publishing_attempts
        this.db
          .prepare<[number, number, number, number]>(`
            UPDATE publishing_attempts
            SET outcome = 'succeeded',
                phase_reached = 'published',
                finished_at = ?,
                duration_ms = ?,
                updated_at = ?
            WHERE id = ?
          `)
          .run(finishTime, durationMs, finishTime, attemptId);

        // D. Enqueue file.delete_raw job (priority 20)
        this.queue.enqueue({
          type: 'file.delete_raw',
          dedupeKey: `delete_raw:${rawFile.id}`,
          reelId: record.reel_id,
          payload: { videoFileId: rawFile.id },
          priority: 20,
          createdBy: 'system',
        });

        // E. Release file lock
        this.queue.releaseFileLock(job.id, rawFile.id);

        // F. Recompute aggregate Reel status
        recomputeAndSaveReelStatus(this.db, record.reel_id);

        // G. Notifications
        this.notifications.create({
          severity: 'success',
          type: 'publish_success',
          title: `Published to Telegram (${destination.label})`,
          body: `Reel #${record.reel_id} delivered successfully. Message ID: ${res.message_id}. Raw file deletion enqueued.`,
          reelId: record.reel_id,
          destinationId: destination.id,
        });
      });

      txn.immediate();

      // Finalize background job as succeeded
      this.queue.finalizeJob(job.id, workerId, 'succeeded');

      logger.info(
        { reelId: record.reel_id, messageId: res.message_id },
        'Telegram publish complete and raw deletion enqueued',
      );

      return {
        ok: true,
        status: 'published',
        messageId: res.message_id,
      };
    } catch (err: unknown) {
      const durationMs = Date.now() - startTime;

      if (err instanceof TelegramRateLimitError) {
        // 429 Rate limit: back off to window reset
        logger.warn({ retryAfter: err.retryAfterSeconds }, 'Telegram rate limit hit');
        this.recordAttemptError(attemptId, 'failed_retryable', 'RATE_LIMIT', err.message, durationMs);

        // Defer job
        const retryAfter = err.retryAfterSeconds ?? 60;
        const retryRunAt = Date.now() + retryAfter * 1000 + 5000;
        this.db
          .prepare<[number, number, number]>(`
            UPDATE background_jobs SET run_at = ?, updated_at = ? WHERE id = ?
          `)
          .run(retryRunAt, Date.now(), job.id);

        this.queue.releaseFileLock(job.id, rawFile.id);
        this.queue.finalizeJob(job.id, workerId, 'failed', { code: 'RATE_LIMIT', message: err.message });

        return { ok: false, status: 'failed_retryable', retryAfterSeconds: err.retryAfterSeconds, error: err.message };
      }

      if (err instanceof TelegramAuthError) {
        // Auth error: no auto-retry
        logger.error({ err }, 'Telegram authentication failed');
        this.recordAttemptError(attemptId, 'failed_terminal', 'AUTH_ERROR', err.message, durationMs);
        this.markNeedsAuth(destination.id, account.id, err.message);

        this.queue.releaseFileLock(job.id, rawFile.id);
        this.queue.finalizeJob(job.id, workerId, 'failed', { code: 'AUTH_ERROR', message: err.message });

        return { ok: false, status: 'needs_auth', error: err.message };
      }

      // Check if timeout or uncertain outcome occurred AFTER upload started
      const isTimeout =
        (err instanceof Error && err.name === 'AbortError') ||
        (err instanceof TelegramError && err.message.includes('timed out'));

      if (isTimeout) {
        // UNCERTAIN OUTCOME: Request sent, no response (PRD 12.4)
        logger.warn(
          { recordId: record.id, err },
          'Telegram send timed out: outcome is UNCERTAIN. Enqueueing reconcile job.',
        );

        this.db.transaction(() => {
          const timeoutNow = Date.now();
          this.db
            .prepare<[string, number, number]>(`
              UPDATE publishing_records
              SET status = 'uncertain',
                  phase = 'publish_requested',
                  last_error_code = 'UNCERTAIN',
                  last_error_message = ?,
                  updated_at = ?
              WHERE id = ?
            `)
            .run(String(err), timeoutNow, record.id);

          this.db
            .prepare<[string, number, number, number, number]>(`
              UPDATE publishing_attempts
              SET outcome = 'uncertain',
                  phase_reached = 'publish_requested',
                  error_code = 'UNCERTAIN',
                  error_message = ?,
                  finished_at = ?,
                  duration_ms = ?,
                  updated_at = ?
              WHERE id = ?
            `)
            .run(String(err), timeoutNow, durationMs, timeoutNow, attemptId);

          // Enqueue reconcile.destination
          this.queue.enqueue({
            type: 'reconcile.destination',
            dedupeKey: `reconcile:${record.id}:${timeoutNow}`,
            reelId: record.reel_id,
            destinationId: destination.id,
            publishingRecordId: record.id,
            priority: 50,
            createdBy: 'system',
          });

          // Raw file is strictly RETAINED!
          this.queue.releaseFileLock(job.id, rawFile.id);
          recomputeAndSaveReelStatus(this.db, record.reel_id);

          this.notifications.create({
            severity: 'warning',
            type: 'publish_uncertain',
            title: `Telegram delivery uncertain for Reel #${record.reel_id}`,
            body: 'Request timed out after upload; reconciliation job started to verify message presence.',
            reelId: record.reel_id,
            destinationId: destination.id,
          });
        }).immediate();

        this.queue.finalizeJob(job.id, workerId, 'failed', { code: 'UNCERTAIN', message: String(err) });
        return { ok: false, status: 'uncertain', error: String(err) };
      }

      // Other transient error
      logger.error({ err }, 'Telegram sendVideo failed');
      this.recordAttemptError(attemptId, 'failed_retryable', 'SEND_ERROR', String(err), durationMs);
      this.queue.releaseFileLock(job.id, rawFile.id);
      this.queue.finalizeJob(job.id, workerId, 'failed', { code: 'SEND_ERROR', message: String(err) });

      return { ok: false, status: 'failed_retryable', error: String(err) };
    }
  }

  private recordAttemptError(
    attemptId: number,
    outcome: string,
    code: string,
    message: string,
    durationMs: number,
  ): void {
    const now = Date.now();
    this.db
      .prepare<[string, string, string, number, number, number, number]>(`
        UPDATE publishing_attempts
        SET outcome = ?,
            error_code = ?,
            error_message = ?,
            finished_at = ?,
            duration_ms = ?,
            updated_at = ?
        WHERE id = ?
      `)
      .run(outcome, code, message, now, durationMs, now, attemptId);
  }

  private markNeedsAuth(destinationId: number, accountId?: number | undefined, error?: string): void {
    const now = Date.now();
    this.db
      .prepare<[string, number, number]>(`
        UPDATE publishing_destinations
        SET paused = 1,
            paused_reason = ?,
            updated_at = ?
        WHERE id = ?
      `)
      .run('Needs authentication: ' + (error ?? ''), now, destinationId);

    if (accountId) {
      this.db
        .prepare<[string, number, number]>(`
          UPDATE connected_accounts
          SET status = 'needs_auth',
              last_error = ?,
              updated_at = ?
          WHERE id = ?
        `)
        .run(error ?? 'Authentication failed', now, accountId);
    }
  }
}
