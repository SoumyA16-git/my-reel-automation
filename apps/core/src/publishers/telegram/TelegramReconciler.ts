import type { Database } from 'better-sqlite3';
import { getDatabase } from '../../db/connection.js';
import { TelegramClient } from './TelegramClient.js';
import { JobQueue, type JobRow } from '../../queue/JobQueue.js';
import { decrypt } from '../../crypto/index.js';
import { recomputeAndSaveReelStatus } from '../../reels/stateMachine.js';
import { NotificationService } from '../../notifications/NotificationService.js';
import { logger } from '../../logger.js';

export interface ReconcileResult {
  reconciled: boolean;
  outcome: 'published' | 'absent' | 'inconclusive';
  messageId?: number | undefined;
  error?: string | undefined;
}

interface RecordRow {
  id: number;
  reel_id: number;
  destination_id: number;
  video_file_id: number;
  ai_content_id: number;
  status: string;
  phase: string;
}

interface DestinationRow {
  id: number;
  account_id: number;
  target_id: string;
  label: string;
}

interface AccountRow {
  token_enc: Buffer | null;
}

interface VideoFileRow {
  id: number;
  duration_ms: number | null;
  size_bytes: number;
}

interface AiContentRow {
  title: string;
}

interface AttemptRow {
  started_at: number;
}

export class TelegramReconciler {
  private readonly db: Database;
  private readonly queue: JobQueue;
  private readonly notifications: NotificationService;
  private readonly telegramClient: TelegramClient;

  constructor(db?: Database, telegramClient?: TelegramClient) {
    this.db = db ?? getDatabase();
    this.queue = new JobQueue(this.db);
    this.notifications = new NotificationService(this.db);
    this.telegramClient = telegramClient ?? new TelegramClient();
  }

  /**
   * Reconcile uncertain delivery for a Telegram destination (PRD 12.4).
   */
  public async reconcile(job: JobRow, workerId: string): Promise<ReconcileResult> {
    const now = Date.now();

    // 1. Fetch publishing record
    let record: RecordRow | undefined;
    if (job.publishing_record_id) {
      record = this.db
        .prepare<[number], RecordRow>('SELECT * FROM publishing_records WHERE id = ?')
        .get(job.publishing_record_id);
    } else if (job.reel_id && job.destination_id) {
      record = this.db
        .prepare<[number, number], RecordRow>(
          'SELECT * FROM publishing_records WHERE reel_id = ? AND destination_id = ?',
        )
        .get(job.reel_id, job.destination_id);
    }

    if (!record) {
      throw new Error(`Record not found for reconcile job #${job.id}`);
    }

    // 2. Fetch destination & account
    const destination = this.db
      .prepare<[number], DestinationRow>('SELECT * FROM publishing_destinations WHERE id = ?')
      .get(record.destination_id);

    if (!destination) {
      throw new Error(`Destination not found: ${record.destination_id}`);
    }

    const account = this.db
      .prepare<[number], AccountRow>('SELECT token_enc FROM connected_accounts WHERE id = ?')
      .get(destination.account_id);

    if (!account?.token_enc) {
      throw new Error('Telegram bot token not found');
    }

    const botToken = decrypt(account.token_enc);

    // 3. Fetch video file & caption info for matching
    const videoFile = this.db
      .prepare<[number], VideoFileRow>('SELECT id, duration_ms, size_bytes FROM video_files WHERE id = ?')
      .get(record.video_file_id);

    const caption = this.db
      .prepare<[number], AiContentRow>('SELECT title FROM ai_content WHERE id = ?')
      .get(record.ai_content_id);

    const latestAttempt = this.db
      .prepare<[number], AttemptRow>(`
        SELECT started_at FROM publishing_attempts
        WHERE publishing_record_id = ?
        ORDER BY attempt_no DESC LIMIT 1
      `)
      .get(record.id);

    const windowStartMs = (latestAttempt?.started_at ?? now) - 120_000; // 2 min buffer before attempt

    // 4. Query Telegram channel post updates
    const updates = await this.telegramClient.getChannelPostUpdates(botToken);
    logger.debug({ count: updates.length, destinationId: destination.id }, 'Fetched updates for reconcile');

    // Normalize target chat ID for comparison (can be numeric or @username)
    const targetChatStr = String(destination.target_id).toLowerCase();

    let matchedPost: (typeof updates)[0]['channel_post'] | undefined;

    for (const update of updates) {
      const post = update.channel_post;
      if (!post) continue;

      const postChatIdStr = String(post.chat.id);
      const postUsername = (post.chat as { username?: string }).username?.toLowerCase();

      const chatMatches =
        postChatIdStr === targetChatStr ||
        (postUsername && `@${postUsername}` === targetChatStr);

      if (!chatMatches) continue;

      const postTimeMs = post.date * 1000;
      if (postTimeMs < windowStartMs) continue;

      // Check matching criteria:
      // A. Duration matches expected video duration (within ±2s)
      const expectedDurationSec = videoFile?.duration_ms
        ? Math.round(videoFile.duration_ms / 1000)
        : null;
      const durationMatches =
        expectedDurationSec !== null &&
        post.video?.duration !== undefined &&
        Math.abs(post.video.duration - expectedDurationSec) <= 2;

      // B. Caption title substring match
      const captionMatches =
        Boolean(caption?.title && post.caption && post.caption.includes(caption.title));

      if (durationMatches || captionMatches) {
        matchedPost = post;
        break;
      }
    }

    if (matchedPost) {
      // MATCH FOUND: Treat as delivered! Commit in atomic transaction (PRD 12.4)
      logger.info(
        { messageId: matchedPost.message_id, reelId: record.reel_id },
        'Reconciliation verified Telegram delivery via channel_post update',
      );

      const finishTime = Date.now();
      const txn = this.db.transaction(() => {
        // Insert telegram_messages
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
            INSERT OR REPLACE INTO telegram_messages (
              publishing_record_id, chat_id, message_id, message_date,
              file_id, file_unique_id, size_bytes, duration_s,
              caption_sent, delivered_at, verification_method, api_response,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `)
          .run(
            record.id,
            String(matchedPost!.chat.id),
            matchedPost!.message_id,
            matchedPost!.date,
            matchedPost!.video?.file_id ?? null,
            matchedPost!.video?.file_unique_id ?? null,
            matchedPost!.video?.file_size ?? null,
            matchedPost!.video?.duration ?? null,
            matchedPost!.caption ?? null,
            finishTime,
            'channel_post_reconcile',
            JSON.stringify(matchedPost),
            finishTime,
            finishTime,
          );

        // Update publishing_records
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
          .run(String(matchedPost!.message_id), finishTime, finishTime, record.id);

        // Update latest attempt
        this.db
          .prepare<[number, number, number]>(`
            UPDATE publishing_attempts
            SET outcome = 'succeeded',
                phase_reached = 'published',
                finished_at = ?,
                updated_at = ?
            WHERE publishing_record_id = ? AND outcome = 'uncertain'
          `)
          .run(finishTime, finishTime, record.id);

        // Enqueue file.delete_raw job
        if (videoFile) {
          this.queue.enqueue({
            type: 'file.delete_raw',
            dedupeKey: `delete_raw:${videoFile.id}`,
            reelId: record.reel_id,
            payload: { videoFileId: videoFile.id },
            priority: 20,
            createdBy: 'system',
          });
        }

        recomputeAndSaveReelStatus(this.db, record.reel_id);

        this.notifications.create({
          severity: 'success',
          type: 'publish_success',
          title: `Reconciliation confirmed Telegram post for Reel #${record.reel_id}`,
          body: `Message ID ${matchedPost!.message_id} found in channel. Delivery verified; raw file deletion enqueued.`,
          reelId: record.reel_id,
          destinationId: destination.id,
        });
      });

      txn.immediate();
      this.queue.finalizeJob(job.id, workerId, 'succeeded');

      return {
        reconciled: true,
        outcome: 'published',
        messageId: matchedPost.message_id,
      };
    }

    // No match found
    // Check if reconcile window (15 min) has elapsed
    const reconcileWindowMs = 15 * 60 * 1000;
    const isWindowElapsed = now - (latestAttempt?.started_at ?? now) > reconcileWindowMs;

    if (isWindowElapsed) {
      // Inconclusive: mark needs_action and alert admin
      logger.warn(
        { recordId: record.id, reelId: record.reel_id },
        'Reconciliation inconclusive after 15 minutes; holding for admin manual decision',
      );

      this.db
        .prepare<[number, number]>(`
          UPDATE publishing_records
          SET status = 'needs_action',
              last_error_code = 'RECONCILE_INCONCLUSIVE',
              last_error_message = 'Automated check could not find message in channel. Please verify manually.',
              updated_at = ?
          WHERE id = ?
        `)
        .run(now, record.id);

      recomputeAndSaveReelStatus(this.db, record.reel_id);

      this.notifications.create({
        severity: 'warning',
        type: 'publish_needs_action',
        title: `Uncertain delivery for Reel #${record.reel_id} — manual verification needed`,
        body: 'Automated reconcile could not verify if video was posted to Telegram. Please check channel and confirm in dashboard.',
        reelId: record.reel_id,
        destinationId: destination.id,
      });

      this.queue.finalizeJob(job.id, workerId, 'failed', {
        code: 'RECONCILE_INCONCLUSIVE',
        message: 'Could not verify channel post automatically',
      });

      return { reconciled: false, outcome: 'inconclusive' };
    }

    // Reconcile window not yet elapsed: re-queue reconcile job with 2 min backoff
    this.queue.finalizeJob(job.id, workerId, 'failed', {
      code: 'RECONCILE_PENDING',
      message: 'No matching post yet; will re-check',
    });

    return { reconciled: false, outcome: 'inconclusive' };
  }

  /**
   * Admin manual resolution for uncertain delivery (PRD 12.4).
   * action: 'confirm_delivered' (with messageId/link) OR 'retry'
   */
  public resolveDelivery(
    recordId: number,
    adminId: number,
    action: 'confirm_delivered' | 'retry',
    messageId?: number | undefined,
  ): boolean {
    const now = Date.now();
    const record = this.db
      .prepare<[number], RecordRow>('SELECT * FROM publishing_records WHERE id = ?')
      .get(recordId);

    if (!record) throw new Error(`Publishing record #${recordId} not found`);

    if (action === 'confirm_delivered') {
      if (!messageId) {
        throw new Error('messageId is required to confirm delivered');
      }

      const txn = this.db.transaction(() => {
        // Insert telegram_messages
        this.db
          .prepare<[number, number, number, number, number]>(`
            INSERT OR REPLACE INTO telegram_messages (
              publishing_record_id, chat_id, message_id,
              delivered_at, verification_method,
              created_at, updated_at
            ) VALUES (?, 'manual_confirm', ?, ?, 'manual', ?, ?)
          `)
          .run(record.id, messageId, now, now, now);

        // Update record
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
          .run(String(messageId), now, now, record.id);

        // Enqueue raw file deletion!
        this.queue.enqueue({
          type: 'file.delete_raw',
          dedupeKey: `delete_raw:${record.video_file_id}`,
          reelId: record.reel_id,
          payload: { videoFileId: record.video_file_id },
          priority: 20,
          createdBy: 'admin',
        });

        recomputeAndSaveReelStatus(this.db, record.reel_id);
      });

      txn.immediate();
      return true;
    } else {
      // Retry: reset destination status to queued and enqueue a new publish.telegram job
      const txn = this.db.transaction(() => {
        this.db
          .prepare<[number, number]>(`
            UPDATE publishing_records
            SET status = 'queued',
                phase = 'none',
                updated_at = ?
            WHERE id = ?
          `)
          .run(now, record.id);

        this.queue.enqueue({
          type: 'publish.telegram',
          dedupeKey: `publish:${record.reel_id}:${record.destination_id}:${now}`,
          reelId: record.reel_id,
          destinationId: record.destination_id,
          publishingRecordId: record.id,
          priority: 50,
          createdBy: 'admin',
        });

        recomputeAndSaveReelStatus(this.db, record.reel_id);
      });

      txn.immediate();
      return true;
    }
  }
}
