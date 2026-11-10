import type { Database } from 'better-sqlite3';
import { getDatabase } from '../../db/connection.js';
import { getStorageManager, type StorageManager } from '../../storage/StorageManager.js';
import {
  MetaClient,
  MetaAuthError,
  MetaRateLimitError,
  MetaProcessingError,
  MetaNetworkError,
  MetaTimeoutError,
  MetaError,
} from './MetaClient.js';
import { JobQueue, type JobRow } from '../../queue/JobQueue.js';
import { decrypt } from '../../crypto/index.js';
import { recomputeAndSaveReelStatus } from '../../reels/stateMachine.js';
import { NotificationService } from '../../notifications/NotificationService.js';
import { logger } from '../../logger.js';

export interface MetaPublishResult {
  ok: boolean;
  status: 'published' | 'failed_retryable' | 'needs_action' | 'needs_auth' | 'uncertain';
  postId?: string | undefined;
  permalink?: string | undefined;
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
  remote_container_id: string | null;
  remote_post_id: string | null;
  publish_requested_at: number | null;
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
  token_2_enc: Buffer | null;
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

export class MetaPublisher {
  private readonly db: Database;
  private readonly storage: StorageManager;
  private readonly queue: JobQueue;
  private readonly notifications: NotificationService;
  private readonly metaClient: MetaClient;

  constructor(
    db?: Database,
    storage?: StorageManager,
    metaClient?: MetaClient,
  ) {
    this.db = db ?? getDatabase();
    try {
      this.storage = storage ?? getStorageManager();
    } catch {
      this.storage = storage as any;
    }
    this.queue = new JobQueue(this.db);
    this.notifications = new NotificationService(this.db);
    this.metaClient = metaClient ?? new MetaClient();
  }

  /**
   * Execute Instagram or Facebook publish job (PRD Section 10).
   * Checkpointed at every external step to prevent duplicates.
   */
  public async publish(job: JobRow, workerId: string): Promise<MetaPublishResult> {
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

    // Terminal state invariant: if already published, refuse new work
    if (record.status === 'published') {
      logger.info({ recordId: record.id }, 'Destination is already published; skipping work');
      this.queue.finalizeJob(job.id, workerId, 'succeeded');
      return { ok: true, status: 'published', postId: record.remote_post_id ?? undefined };
    }

    // 2. Load destination and connected account
    const destination = this.db
      .prepare<[number], DestinationRow>('SELECT * FROM publishing_destinations WHERE id = ?')
      .get(record.destination_id);

    if (!destination || (destination.kind !== 'instagram' && destination.kind !== 'facebook')) {
      throw new Error(`Invalid destination #${record.destination_id} for Meta publisher`);
    }

    if (destination.paused === 1) {
      logger.warn({ destinationId: destination.id }, 'Destination is paused; skipping job');
      return { ok: false, status: 'failed_retryable', error: 'Destination is paused' };
    }

    const account = this.db
      .prepare<[number], AccountRow>('SELECT * FROM connected_accounts WHERE id = ?')
      .get(destination.account_id);

    if (!account || !account.token_enc) {
      this.markNeedsAuth(destination.id, account?.id, 'Meta access token is missing or not configured');
      return { ok: false, status: 'needs_auth', error: 'Meta access token missing' };
    }

    // Decrypt access token
    let token: string;
    try {
      token = decrypt(account.token_enc);
    } catch {
      this.markNeedsAuth(destination.id, account.id, 'Failed to decrypt Meta access token');
      return { ok: false, status: 'needs_auth', error: 'Failed to decrypt access token' };
    }

    // 3. Load censored video file and validate presence
    const videoFile = this.db
      .prepare<[number], VideoFileRow>('SELECT * FROM video_files WHERE id = ?')
      .get(record.video_file_id);

    if (!videoFile || videoFile.role !== 'censored' || videoFile.state !== 'present') {
      throw new Error(`Censored video file #${record.video_file_id} not available or not present`);
    }

    const filePath = this.storage.resolveStoragePath(videoFile.storage_name, 'censored');

    // 4. Platform Pre-flight Checks (PRD 10.7)
    if (destination.kind === 'instagram') {
      // Instagram limit: 300 MB
      const MAX_IG_BYTES = 300 * 1024 * 1024;
      if (videoFile.size_bytes > MAX_IG_BYTES) {
        const msg = 'File exceeds Instagram limit (300 MB) â€” not publishable to Instagram';
        logger.error({ fileId: videoFile.id, size: videoFile.size_bytes }, msg);

        this.db
          .prepare<[string, number, number]>(`
            UPDATE publishing_records
            SET status = 'needs_action',
                last_error_code = 'OVERSIZE_FOR_INSTAGRAM',
                last_error_message = ?,
                updated_at = ?
            WHERE id = ?
          `)
          .run(msg, now, record.id);

        this.notifications.create({
          severity: 'warning',
          type: 'publish_failed',
          title: 'Instagram publish rejected: file exceeds 300 MB limit',
          body: msg,
          reelId: record.reel_id,
          destinationId: destination.id,
        });

        this.queue.finalizeJob(job.id, workerId, 'failed', {
          code: 'OVERSIZE_FOR_INSTAGRAM',
          message: msg,
        });

        return { ok: false, status: 'needs_action', error: msg };
      }

      // Duration check: 3s to 15m
      if (videoFile.duration_ms !== null) {
        if (videoFile.duration_ms < 3000 || videoFile.duration_ms > 900_000) {
          const msg = `Instagram Reels require duration between 3 seconds and 15 minutes (got ${videoFile.duration_ms}ms)`;
          logger.error({ fileId: videoFile.id, duration: videoFile.duration_ms }, msg);

          this.db
            .prepare<[string, number, number]>(`
              UPDATE publishing_records
              SET status = 'needs_action',
                  last_error_code = 'DURATION_OUT_OF_RANGE',
                  last_error_message = ?,
                  updated_at = ?
              WHERE id = ?
            `)
            .run(msg, now, record.id);

          this.notifications.create({
            severity: 'warning',
            type: 'publish_failed',
            title: 'Instagram publish rejected: duration out of range',
            body: msg,
            reelId: record.reel_id,
            destinationId: destination.id,
          });

          this.queue.finalizeJob(job.id, workerId, 'failed', {
            code: 'DURATION_OUT_OF_RANGE',
            message: msg,
          });

          return { ok: false, status: 'needs_action', error: msg };
        }
      }
    } else if (destination.kind === 'facebook') {
      // Facebook Reels minimum resolution: 540p
      if (videoFile.width !== null && videoFile.height !== null) {
        if (videoFile.width < 540 || videoFile.height < 540) {
          const msg = `Facebook Reels require at least 540p resolution (got ${videoFile.width}x${videoFile.height})`;
          logger.error({ fileId: videoFile.id, width: videoFile.width, height: videoFile.height }, msg);

          this.db
            .prepare<[string, number, number]>(`
              UPDATE publishing_records
              SET status = 'needs_action',
                  last_error_code = 'LOW_RESOLUTION_FOR_FACEBOOK',
                  last_error_message = ?,
                  updated_at = ?
              WHERE id = ?
            `)
            .run(msg, now, record.id);

          this.notifications.create({
            severity: 'warning',
            type: 'publish_failed',
            title: 'Facebook publish rejected: resolution below 540p',
            body: msg,
            reelId: record.reel_id,
            destinationId: destination.id,
          });

          this.queue.finalizeJob(job.id, workerId, 'failed', {
            code: 'LOW_RESOLUTION_FOR_FACEBOOK',
            message: msg,
          });

          return { ok: false, status: 'needs_action', error: msg };
        }
      }
    }

    // 5. Pre-publish Token Health Check (PRD 10.6)
    try {
      await this.metaClient.checkTokenHealth(token);
    } catch (err) {
      if (err instanceof MetaAuthError) {
        this.markNeedsAuth(destination.id, account.id, err.message, record.id);
        this.queue.finalizeJob(job.id, workerId, 'failed', {
          code: 'TOKEN_INVALID',
          message: err.message,
        });
        return { ok: false, status: 'needs_auth', error: err.message };
      }
      logger.warn({ err }, 'Pre-publish token health check encountered non-fatal error; continuing');
    }

    // 6. Caption formatting
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

    // 7. Track attempt & lock file
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
    this.queue.acquireFileLock(job.id, videoFile.id);

    // Update status to in_progress
    this.db
      .prepare<[number, number]>(`
        UPDATE publishing_records
        SET status = 'in_progress',
            attempt_count = attempt_count + 1,
            updated_at = ?
        WHERE id = ?
      `)
      .run(now, record.id);

    const startTime = Date.now();

    // 8. Execute Flow based on platform with checkpoints
    try {
      if (destination.kind === 'instagram') {
        return await this.publishInstagram(
          record,
          destination,
          token,
          filePath,
          videoFile.size_bytes,
          captionText,
          job,
          workerId,
          attemptId,
          startTime,
        );
      } else {
        return await this.publishFacebook(
          record,
          destination,
          token,
          filePath,
          videoFile.size_bytes,
          captionText,
          captionRow?.title,
          job,
          workerId,
          attemptId,
          startTime,
        );
      }
    } catch (err: any) {
      return this.handlePublishError(err, record, destination, account, job, workerId, attemptId, startTime);
    }
  }

  // -------------------------------------------------------------------------
  // Instagram Execution with Checkpoints (PRD 10.3 / 10.5)
  // -------------------------------------------------------------------------
  private async publishInstagram(
    record: RecordDetailsRow,
    destination: DestinationRow,
    token: string,
    filePath: string,
    fileSize: number,
    captionText: string,
    job: JobRow,
    workerId: string,
    attemptId: number,
    startTime: number,
  ): Promise<MetaPublishResult> {
    let containerId = record.remote_container_id;

    // Phase 1: Container Creation
    if (!containerId || record.phase === 'none') {
      logger.info({ recordId: record.id }, 'Instagram: Creating media container');
      const container = await this.metaClient.createInstagramContainer(destination.target_id, token, {
        caption: captionText,
        shareToFeed: true,
      });
      containerId = container.containerId;

      const updated = Date.now();
      this.db
        .prepare<[string, number, number]>(`
          UPDATE publishing_records
          SET phase = 'container_created',
              remote_container_id = ?,
              updated_at = ?
          WHERE id = ?
        `)
        .run(containerId, updated, record.id);

      record.phase = 'container_created';
      record.remote_container_id = containerId;
    } else {
      logger.info({ recordId: record.id, containerId }, 'Instagram: Resuming from checkpoint container_created');
    }

    // Phase 2: Resumable Upload
    if (record.phase === 'container_created' || record.phase === 'upload_started') {
      logger.info({ recordId: record.id, containerId }, 'Instagram: Uploading video bytes');
      const uploadUri = `${this.metaClient.ruploadBaseUrl}/ig-api-upload/v25.0/${containerId}`;

      // Check if resume offset is needed
      let offset = 0;
      if (record.phase === 'upload_started') {
        try {
          offset = await this.metaClient.getUploadOffset(uploadUri, token, fileSize);
          logger.info({ recordId: record.id, offset }, 'Instagram: Resuming upload from offset');
        } catch {
          offset = 0;
        }
      }

      await this.metaClient.uploadBytes(uploadUri, token, filePath, fileSize, offset);

      const updated = Date.now();
      this.db
        .prepare<[number, number]>(`
          UPDATE publishing_records
          SET phase = 'upload_complete',
              updated_at = ?
          WHERE id = ?
        `)
        .run(updated, record.id);

      record.phase = 'upload_complete';
    } else {
      logger.info({ recordId: record.id }, 'Instagram: Bytes already uploaded; skipping upload step');
    }

    // Phase 3: Status Polling
    logger.info({ recordId: record.id, containerId }, 'Instagram: Polling container processing status');
    await this.metaClient.pollInstagramContainerStatus(containerId, token);

    // Phase 4: Publish Requested Checkpoint
    const requestedAt = Date.now();
    this.db
      .prepare<[number, number, number]>(`
        UPDATE publishing_records
        SET phase = 'publish_requested',
            publish_requested_at = ?,
            updated_at = ?
        WHERE id = ?
      `)
      .run(requestedAt, requestedAt, record.id);

    record.phase = 'publish_requested';
    record.publish_requested_at = requestedAt;

    // Send publish request
    logger.info({ recordId: record.id, containerId }, 'Instagram: Sending media_publish request');
    const { mediaId } = await this.metaClient.publishInstagramContainer(destination.target_id, containerId, token);

    // Capture permalink
    const permalink = (await this.metaClient.getInstagramPermalink(mediaId, token)) ?? `https://www.instagram.com/reel/${mediaId}`;

    const finishTime = Date.now();
    const durationMs = finishTime - startTime;

    // Phase 5: Commit Success in ONE Transaction (FR-017)
    const txn = this.db.transaction(() => {
      this.db
        .prepare<[string, string | null, number, number, number]>(`
          UPDATE publishing_records
          SET status = 'published',
              phase = 'published',
              remote_post_id = ?,
              remote_url = ?,
              published_at = ?,
              updated_at = ?
          WHERE id = ?
        `)
        .run(mediaId, permalink, finishTime, finishTime, record.id);

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
    });
    txn();

    // Release file lock
    this.queue.releaseFileLock(job.id, record.video_file_id);

    // Recompute reel status
    recomputeAndSaveReelStatus(this.db, record.reel_id);

    // Finalize queue job
    this.queue.finalizeJob(job.id, workerId, 'succeeded');

    logger.info({ recordId: record.id, mediaId, permalink }, 'Instagram Reel published successfully');

    return {
      ok: true,
      status: 'published',
      postId: mediaId,
      permalink,
    };
  }

  // -------------------------------------------------------------------------
  // Facebook Page Reel Execution with Checkpoints (PRD 10.4 / 10.5)
  // -------------------------------------------------------------------------
  private async publishFacebook(
    record: RecordDetailsRow,
    destination: DestinationRow,
    token: string,
    filePath: string,
    fileSize: number,
    captionText: string,
    title: string | undefined,
    job: JobRow,
    workerId: string,
    attemptId: number,
    startTime: number,
  ): Promise<MetaPublishResult> {
    let videoId = record.remote_container_id;

    // Phase 1: Start Session
    if (!videoId || record.phase === 'none') {
      logger.info({ recordId: record.id }, 'Facebook: Starting video reel session');
      const session = await this.metaClient.startFacebookReelSession(destination.target_id, token);
      videoId = session.videoId;

      const updated = Date.now();
      this.db
        .prepare<[string, number, number]>(`
          UPDATE publishing_records
          SET phase = 'container_created',
              remote_container_id = ?,
              updated_at = ?
          WHERE id = ?
        `)
        .run(videoId, updated, record.id);

      record.phase = 'container_created';
      record.remote_container_id = videoId;
    } else {
      logger.info({ recordId: record.id, videoId }, 'Facebook: Resuming from checkpoint container_created');
    }

    // Phase 2: Resumable Upload
    if (record.phase === 'container_created' || record.phase === 'upload_started') {
      logger.info({ recordId: record.id, videoId }, 'Facebook: Uploading video bytes');
      const uploadUrl = `${this.metaClient.ruploadBaseUrl}/video-upload/v25.0/${videoId}`;

      let offset = 0;
      if (record.phase === 'upload_started') {
        try {
          offset = await this.metaClient.getUploadOffset(uploadUrl, token, fileSize);
          logger.info({ recordId: record.id, offset }, 'Facebook: Resuming upload from offset');
        } catch {
          offset = 0;
        }
      }

      await this.metaClient.uploadBytes(uploadUrl, token, filePath, fileSize, offset);

      const updated = Date.now();
      this.db
        .prepare<[number, number]>(`
          UPDATE publishing_records
          SET phase = 'upload_complete',
              updated_at = ?
          WHERE id = ?
        `)
        .run(updated, record.id);

      record.phase = 'upload_complete';
    } else {
      logger.info({ recordId: record.id }, 'Facebook: Bytes already uploaded; skipping upload step');
    }

    // Phase 3: Finish Session / Publish Request
    const requestedAt = Date.now();
    this.db
      .prepare<[number, number, number]>(`
        UPDATE publishing_records
        SET phase = 'publish_requested',
            publish_requested_at = ?,
            updated_at = ?
        WHERE id = ?
      `)
      .run(requestedAt, requestedAt, record.id);

    record.phase = 'publish_requested';
    record.publish_requested_at = requestedAt;

    logger.info({ recordId: record.id, videoId }, 'Facebook: Sending finish/publish request');
    await this.metaClient.finishFacebookReelSession(destination.target_id, token, {
      videoId,
      description: captionText,
      title,
    });

    // Phase 4: Verify Live Status
    logger.info({ recordId: record.id, videoId }, 'Facebook: Polling status for publishing_phase completion');
    const statusRes = await this.metaClient.pollFacebookReelStatus(videoId, token);
    const permalink = statusRes.permalinkUrl ?? `https://www.facebook.com/reel/${videoId}`;

    const finishTime = Date.now();
    const durationMs = finishTime - startTime;

    // Phase 5: Commit Success in ONE Transaction (FR-017)
    const txn = this.db.transaction(() => {
      this.db
        .prepare<[string, string | null, number, number, number]>(`
          UPDATE publishing_records
          SET status = 'published',
              phase = 'published',
              remote_post_id = ?,
              remote_url = ?,
              published_at = ?,
              updated_at = ?
          WHERE id = ?
        `)
        .run(videoId, permalink, finishTime, finishTime, record.id);

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
    });
    txn();

    // Release file lock
    this.queue.releaseFileLock(job.id, record.video_file_id);

    // Recompute reel status
    recomputeAndSaveReelStatus(this.db, record.reel_id);

    // Finalize queue job
    this.queue.finalizeJob(job.id, workerId, 'succeeded');

    logger.info({ recordId: record.id, videoId, permalink }, 'Facebook Reel published and verified live');

    return {
      ok: true,
      status: 'published',
      postId: videoId,
      permalink,
    };
  }

  // -------------------------------------------------------------------------
  // Error Classification & Handling (PRD 10.5 / 10.8)
  // -------------------------------------------------------------------------
  private handlePublishError(
    err: any,
    record: RecordDetailsRow,
    destination: DestinationRow,
    account: AccountRow,
    job: JobRow,
    workerId: string,
    attemptId: number,
    startTime: number,
  ): MetaPublishResult {
    const now = Date.now();
    const durationMs = now - startTime;
    this.queue.releaseFileLock(job.id, record.video_file_id);

    // UNCERTAIN DELIVERY (PRD 10.5):
    // If request was in phase publish_requested and network died/timed out
    const isNetworkAbort =
      err instanceof MetaNetworkError ||
      err instanceof MetaTimeoutError ||
      err?.name === 'AbortError' ||
      err?.code === 'ECONNRESET' ||
      err?.code === 'ETIMEDOUT';

    if (record.phase === 'publish_requested' && isNetworkAbort) {
      logger.warn(
        { recordId: record.id, destinationId: destination.id, err: err.message },
        'Meta publish request sent but response aborted/timed out; setting status UNCERTAIN',
      );

      this.db
        .prepare<[string, number, number]>(`
          UPDATE publishing_records
          SET status = 'uncertain',
              last_error_code = 'UNCERTAIN_DELIVERY',
              last_error_message = ?,
              updated_at = ?
          WHERE id = ?
        `)
        .run(err.message, now, record.id);

      this.db
        .prepare<[string, number, number, number, number]>(`
          UPDATE publishing_attempts
          SET outcome = 'uncertain',
              error_class = 'UncertainDelivery',
              error_message = ?,
              finished_at = ?,
              duration_ms = ?,
              updated_at = ?
          WHERE id = ?
        `)
        .run(err.message, now, durationMs, now, attemptId);

      // Enqueue reconcile job with high priority
      this.queue.enqueue({
        type: 'reconcile.destination',
        dedupeKey: `reconcile:${record.id}:${now}`,
        reelId: record.reel_id,
        destinationId: destination.id,
        publishingRecordId: record.id,
        payload: {
          reelId: record.reel_id,
          destinationId: destination.id,
          publishingRecordId: record.id,
        },
        priority: 10,
        runAt: now + 30_000, // check in 30 seconds
        createdBy: 'system',
      });

      this.notifications.create({
        severity: 'warning',
        type: 'publish_failed',
        title: `${destination.label}: Uncertain delivery detected`,
        body: `Publish request was dispatched to ${destination.kind} but connection timed out. Automated reconciliation job enqueued.`,
        reelId: record.reel_id,
        destinationId: destination.id,
      });

      recomputeAndSaveReelStatus(this.db, record.reel_id);

      this.queue.finalizeJob(job.id, workerId, 'failed', {
        code: 'UNCERTAIN_DELIVERY',
        message: err.message,
      });

      return { ok: false, status: 'uncertain', error: err.message };
    }

    // AUTH ERROR (PRD 10.6 / 10.8):
    if (err instanceof MetaAuthError) {
      this.markNeedsAuth(destination.id, account.id, err.message, record.id);

      this.db
        .prepare<[string, number, number, number, number]>(`
          UPDATE publishing_attempts
          SET outcome = 'failed_terminal',
              error_class = 'AuthError',
              error_code = 'AUTH_FAILED',
              error_message = ?,
              finished_at = ?,
              duration_ms = ?,
              updated_at = ?
          WHERE id = ?
        `)
        .run(err.message, now, durationMs, now, attemptId);

      recomputeAndSaveReelStatus(this.db, record.reel_id);

      this.queue.finalizeJob(job.id, workerId, 'failed', {
        code: 'AUTH_FAILED',
        message: err.message,
      });

      return { ok: false, status: 'needs_auth', error: err.message };
    }

    // RATE LIMIT ERROR (PRD 10.8):
    if (err instanceof MetaRateLimitError) {
      const retryAfter = err.retryAfterSeconds ?? 300;
      logger.warn({ destinationId: destination.id, retryAfter }, 'Meta rate limit hit; deferring retry');

      this.db
        .prepare<[string, number, number]>(`
          UPDATE publishing_records
          SET status = 'failed_retryable',
              last_error_code = 'RATE_LIMIT_EXCEEDED',
              last_error_message = ?,
              updated_at = ?
          WHERE id = ?
        `)
        .run(err.message, now, record.id);

      this.db
        .prepare<[string, number, number, number, number]>(`
          UPDATE publishing_attempts
          SET outcome = 'failed_retryable',
              error_class = 'RateLimit',
              error_code = 'RATE_LIMIT_EXCEEDED',
              error_message = ?,
              finished_at = ?,
              duration_ms = ?,
              updated_at = ?
          WHERE id = ?
        `)
        .run(err.message, now, durationMs, now, attemptId);

      recomputeAndSaveReelStatus(this.db, record.reel_id);

      this.queue.finalizeJob(job.id, workerId, 'failed', {
        code: 'RATE_LIMIT_EXCEEDED',
        message: err.message,
      });

      return { ok: false, status: 'failed_retryable', error: err.message, retryAfterSeconds: retryAfter };
    }

    // GENERAL RETRYABLE ERROR:
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error({ err, recordId: record.id }, 'Meta publish failed with retryable error');

    this.db
      .prepare<[string, number, number]>(`
        UPDATE publishing_records
        SET status = 'failed_retryable',
            last_error_code = 'PUBLISH_FAILED',
            last_error_message = ?,
            updated_at = ?
        WHERE id = ?
      `)
      .run(errMsg, now, record.id);

    this.db
      .prepare<[string, number, number, number, number]>(`
        UPDATE publishing_attempts
        SET outcome = 'failed_retryable',
            error_class = 'PublishError',
            error_code = 'PUBLISH_FAILED',
            error_message = ?,
            finished_at = ?,
            duration_ms = ?,
            updated_at = ?
          WHERE id = ?
      `)
      .run(errMsg, now, durationMs, now, attemptId);

    recomputeAndSaveReelStatus(this.db, record.reel_id);

    this.queue.finalizeJob(job.id, workerId, 'failed', {
      code: 'PUBLISH_FAILED',
      message: errMsg,
    });

    return { ok: false, status: 'failed_retryable', error: errMsg };
  }

  /**
   * Transition destination and account to needs_auth and raise notification (PRD 10.6).
   */
  private markNeedsAuth(destinationId: number, accountId: number | undefined, reason: string, recordId?: number): void {
    const now = Date.now();

    this.db
      .prepare<[string, number, number]>(`
        UPDATE publishing_destinations
        SET paused = 1,
            paused_reason = ?,
            updated_at = ?
        WHERE id = ?
      `)
      .run(`Needs authentication: ${reason}`, now, destinationId);

    if (accountId) {
      this.db
        .prepare<[string, number, number]>(`
          UPDATE connected_accounts
          SET status = 'needs_auth',
              last_error = ?,
              updated_at = ?
          WHERE id = ?
        `)
        .run(reason, now, accountId);
    }

    if (recordId) {
      this.db
        .prepare<[string, number, number]>(`
          UPDATE publishing_records
          SET status = 'needs_auth',
              last_error_code = 'AUTH_FAILED',
              last_error_message = ?,
              updated_at = ?
          WHERE id = ?
        `)
        .run(reason, now, recordId);
    }

    this.notifications.create({
      severity: 'critical',
      type: 'account_expired',
      title: 'Meta authentication required',
      body: reason,
      destinationId,
    });
  }
}
