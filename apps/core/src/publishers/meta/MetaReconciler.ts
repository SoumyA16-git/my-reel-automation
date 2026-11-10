import type { Database } from 'better-sqlite3';
import { getDatabase } from '../../db/connection.js';
import { MetaClient } from './MetaClient.js';
import { JobQueue, type JobRow } from '../../queue/JobQueue.js';
import { decrypt } from '../../crypto/index.js';
import { recomputeAndSaveReelStatus } from '../../reels/stateMachine.js';
import { NotificationService } from '../../notifications/NotificationService.js';
import { logger } from '../../logger.js';

export interface MetaReconcileResult {
  reconciled: boolean;
  outcome: 'published' | 'absent' | 'inconclusive';
  postId?: string | undefined;
  permalink?: string | undefined;
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
  remote_container_id: string | null;
  remote_post_id: string | null;
  remote_url: string | null;
  publish_requested_at: number | null;
  published_at: number | null;
}

interface DestinationRow {
  id: number;
  kind: string;
  account_id: number;
  target_id: string;
  label: string;
}

interface AccountRow {
  token_enc: Buffer | null;
}

interface AiContentRow {
  title: string;
}

export class MetaReconciler {
  private readonly db: Database;
  private readonly queue: JobQueue;
  private readonly notifications: NotificationService;
  private readonly metaClient: MetaClient;

  constructor(db?: Database, metaClient?: MetaClient) {
    this.db = db ?? getDatabase();
    this.queue = new JobQueue(this.db);
    this.notifications = new NotificationService(this.db);
    this.metaClient = metaClient ?? new MetaClient();
  }

  /**
   * Reconcile uncertain delivery for a Meta destination (PRD 10.5).
   */
  public async reconcile(job: JobRow, workerId: string): Promise<MetaReconcileResult> {
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

    // Terminal: already published
    if (record.status === 'published') {
      this.queue.finalizeJob(job.id, workerId, 'succeeded');
      return {
        reconciled: true,
        outcome: 'published',
        postId: record.remote_post_id ?? undefined,
        permalink: record.remote_url ?? undefined,
      };
    }

    // 2. Fetch destination & account
    const destination = this.db
      .prepare<[number], DestinationRow>('SELECT * FROM publishing_destinations WHERE id = ?')
      .get(record.destination_id);

    if (!destination || (destination.kind !== 'instagram' && destination.kind !== 'facebook')) {
      throw new Error(`Invalid destination #${record.destination_id} for Meta reconciler`);
    }

    const account = this.db
      .prepare<[number], AccountRow>('SELECT token_enc FROM connected_accounts WHERE id = ?')
      .get(destination.account_id);

    if (!account?.token_enc) {
      throw new Error('Meta access token not found');
    }

    const token = decrypt(account.token_enc);

    // 3. Reconcile based on platform
    if (destination.kind === 'instagram') {
      return await this.reconcileInstagram(record, destination, token, job, workerId, now);
    } else {
      return await this.reconcileFacebook(record, destination, token, job, workerId, now);
    }
  }

  // -------------------------------------------------------------------------
  // Instagram Reconciliation (PRD 10.5)
  // -------------------------------------------------------------------------
  private async reconcileInstagram(
    record: RecordRow,
    destination: DestinationRow,
    token: string,
    job: JobRow,
    workerId: string,
    now: number,
  ): Promise<MetaReconcileResult> {
    // A. Check if remote_post_id exists and is verifiable
    if (record.remote_post_id) {
      const permalink = await this.metaClient.getInstagramPermalink(record.remote_post_id, token);
      if (permalink) {
        return this.markPublished(
          record,
          record.remote_post_id,
          permalink,
          job,
          workerId,
          now,
          destination.label,
        );
      }
    }

    // B. Check recent media on account for matching caption
    const captionRow = this.db
      .prepare<[number], AiContentRow>('SELECT title FROM ai_content WHERE id = ?')
      .get(record.ai_content_id);

    const titlePrefix = captionRow?.title ? captionRow.title.trim().slice(0, 40) : '';

    if (titlePrefix) {
      const recentMedia = await this.metaClient.getRecentInstagramMedia(destination.target_id, token, 15);

      for (const item of recentMedia) {
        if (item.caption && item.caption.includes(titlePrefix)) {
          logger.info(
            { recordId: record.id, mediaId: item.id },
            'Instagram reconcile matched recent media by caption prefix',
          );
          const permalink = item.permalink ?? `https://www.instagram.com/reel/${item.id}`;
          return this.markPublished(record, item.id, permalink, job, workerId, now, destination.label);
        }
      }
    }

    // C. Check elapsed time since publish was requested
    const requestTime = record.publish_requested_at ?? now;
    const elapsedMs = now - requestTime;
    const RECONCILE_WINDOW_MS = 15 * 60 * 1000; // 15 minutes (PRD 10.5)

    if (elapsedMs >= RECONCILE_WINDOW_MS) {
      logger.info(
        { recordId: record.id, elapsedMs },
        'Instagram reconcile: Reconcile window expired and post not found; marking absent for safe retry',
      );

      this.db
        .prepare<[string, number, number]>(`
          UPDATE publishing_records
          SET status = 'failed_retryable',
              last_error_code = 'RECONCILED_ABSENT',
              last_error_message = ?,
              updated_at = ?
          WHERE id = ?
        `)
        .run('Post confirmed absent after reconciliation window; ready for retry', now, record.id);

      this.notifications.create({
        severity: 'info',
        type: 'publish_failed',
        title: `${destination.label}: Reconciliation completed (absent)`,
        body: 'Post was not found after publish timeout. The item is now safe to retry without creating duplicates.',
        reelId: record.reel_id,
        destinationId: destination.id,
      });

      this.queue.finalizeJob(job.id, workerId, 'succeeded');
      return { reconciled: true, outcome: 'absent' };
    }

    // D. Inconclusive: schedule another check
    logger.info({ recordId: record.id, elapsedMs }, 'Instagram reconcile: Inconclusive; will retry check');
    this.queue.finalizeJob(job.id, workerId, 'failed', {
      code: 'RECONCILE_INCONCLUSIVE',
      message: 'Instagram reconciliation inconclusive; within window',
    });

    return { reconciled: false, outcome: 'inconclusive' };
  }

  // -------------------------------------------------------------------------
  // Facebook Page Reel Reconciliation (PRD 10.5)
  // -------------------------------------------------------------------------
  private async reconcileFacebook(
    record: RecordRow,
    destination: DestinationRow,
    token: string,
    job: JobRow,
    workerId: string,
    now: number,
  ): Promise<MetaReconcileResult> {
    const videoId = record.remote_container_id;

    if (!videoId) {
      logger.warn({ recordId: record.id }, 'Facebook reconcile: No remote_container_id (video_id) found');
      this.queue.finalizeJob(job.id, workerId, 'failed', {
        code: 'NO_VIDEO_ID',
        message: 'No video ID recorded for Facebook reel',
      });
      return { reconciled: false, outcome: 'inconclusive' };
    }

    try {
      const statusRes = await this.metaClient.pollFacebookReelStatus(videoId, token, {
        maxWaitMs: 10_000,
        pollIntervalMs: 2000,
      });

      if (statusRes.publishingStatus === 'complete') {
        const permalink = statusRes.permalinkUrl ?? `https://www.facebook.com/reel/${videoId}`;
        return this.markPublished(record, videoId, permalink, job, workerId, now, destination.label);
      }
    } catch (err: any) {
      logger.warn({ err: err.message, recordId: record.id }, 'Facebook reconcile: Status poll did not report complete');
    }

    // If elapsed time > 15m and publishing not complete
    const requestTime = record.publish_requested_at ?? now;
    const elapsedMs = now - requestTime;
    const RECONCILE_WINDOW_MS = 15 * 60 * 1000;

    if (elapsedMs >= RECONCILE_WINDOW_MS) {
      this.db
        .prepare<[number, number]>(`
          UPDATE publishing_records
          SET status = 'failed_retryable',
              last_error_code = 'RECONCILED_ABSENT',
              last_error_message = 'Facebook Reel not published within window; safe to retry',
              updated_at = ?
          WHERE id = ?
        `)
        .run(now, record.id);

      this.queue.finalizeJob(job.id, workerId, 'succeeded');
      return { reconciled: true, outcome: 'absent' };
    }

    this.queue.finalizeJob(job.id, workerId, 'failed', {
      code: 'RECONCILE_INCONCLUSIVE',
      message: 'Facebook reconciliation inconclusive; within window',
    });

    return { reconciled: false, outcome: 'inconclusive' };
  }

  // -------------------------------------------------------------------------
  // Helper: Mark as Published in atomic transaction
  // -------------------------------------------------------------------------
  private markPublished(
    record: RecordRow,
    postId: string,
    permalink: string,
    job: JobRow,
    workerId: string,
    now: number,
    label: string,
  ): MetaReconcileResult {
    const txn = this.db.transaction(() => {
      this.db
        .prepare<[string, string, number, number, number]>(`
          UPDATE publishing_records
          SET status = 'published',
              phase = 'published',
              remote_post_id = ?,
              remote_url = ?,
              published_at = COALESCE(published_at, ?),
              updated_at = ?
          WHERE id = ?
        `)
        .run(postId, permalink, now, now, record.id);
    });
    txn();

    recomputeAndSaveReelStatus(this.db, record.reel_id);

    this.notifications.create({
      severity: 'info',
      type: 'publish_success',
      title: `${label}: Delivery confirmed via reconciliation`,
      body: `Post verified live: ${permalink}`,
      reelId: record.reel_id,
      destinationId: record.destination_id,
    });

    this.queue.finalizeJob(job.id, workerId, 'succeeded');

    return {
      reconciled: true,
      outcome: 'published',
      postId,
      permalink,
    };
  }

  // -------------------------------------------------------------------------
  // Admin manual resolution (PRD 10.5 / 12.4)
  // -------------------------------------------------------------------------
  public resolveDelivery(
    recordId: number,
    adminId: number,
    action: 'confirm_delivered' | 'retry',
    postId?: string,
    permalink?: string,
  ): boolean {
    const now = Date.now();

    const record = this.db
      .prepare<[number], RecordRow>(
        'SELECT * FROM publishing_records WHERE id = ?',
      )
      .get(recordId);

    if (!record) {
      throw new Error(`Record #${recordId} not found`);
    }

    if (action === 'confirm_delivered') {
      const finalPostId = postId ?? record.remote_post_id ?? record.remote_container_id ?? `manual-${now}`;
      const finalUrl = permalink ?? record.remote_url ?? `https://meta.com/post/${finalPostId}`;

      const txn = this.db.transaction(() => {
        this.db
          .prepare<[string, string, number, number, number]>(`
            UPDATE publishing_records
            SET status = 'published',
                phase = 'published',
                remote_post_id = ?,
                remote_url = ?,
                published_at = COALESCE(published_at, ?),
                updated_at = ?
            WHERE id = ?
          `)
          .run(finalPostId, finalUrl, now, now, record.id);
      });
      txn();

      recomputeAndSaveReelStatus(this.db, record.reel_id);
      return true;
    } else {
      // Retry: reset phase and status to allow clean restart
      this.db
        .prepare<[number, number]>(`
          UPDATE publishing_records
          SET status = 'failed_retryable',
              phase = 'none',
              last_error_code = 'ADMIN_RESET_RETRY',
              last_error_message = 'Admin requested retry after delivery verification',
              updated_at = ?
          WHERE id = ?
        `)
        .run(now, record.id);

      recomputeAndSaveReelStatus(this.db, record.reel_id);
      return true;
    }
  }
}
