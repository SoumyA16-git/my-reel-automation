import type { Database } from 'better-sqlite3';
import { getDatabase } from '../db/connection.js';
import { logger } from '../logger.js';

export interface EnqueueJobOptions {
  type: string;
  dedupeKey?: string | null | undefined;
  reelId?: number | null | undefined;
  destinationId?: number | null | undefined;
  publishingRecordId?: number | null | undefined;
  payload?: Record<string, unknown> | undefined;
  priority?: number | undefined; // default 100 (lower runs first)
  runAt?: number | undefined; // UTC epoch ms (default Date.now())
  maxAttempts?: number | undefined; // default 5
  createdBy?: 'scheduler' | 'admin' | 'system' | undefined;
}

export interface JobRow {
  id: number;
  type: string;
  dedupe_key: string | null;
  reel_id: number | null;
  destination_id: number | null;
  publishing_record_id: number | null;
  payload: string;
  state: 'queued' | 'leased' | 'running' | 'succeeded' | 'failed' | 'dead' | 'cancelled';
  priority: number;
  run_at: number;
  attempts: number;
  max_attempts: number;
  lease_owner: string | null;
  lease_expires_at: number | null;
  heartbeat_at: number | null;
  started_at: number | null;
  finished_at: number | null;
  cancel_requested: number;
  last_error_code: string | null;
  last_error_message: string | null;
  created_by: 'scheduler' | 'admin' | 'system';
  created_at: number;
  updated_at: number;
}

export interface ListJobsOptions {
  state?: JobRow['state'] | undefined;
  type?: string | undefined;
  reelId?: number | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

/**
 * Exponential backoff with ±20% jitter.
 * Attempt 1: ~1m, Attempt 2: ~5m, Attempt 3: ~15m, Attempt 4: ~1h.
 */
export function computeBackoff(attempt: number): number {
  let baseMs: number;
  switch (attempt) {
    case 1:
      baseMs = 60_000; // 1 min
      break;
    case 2:
      baseMs = 300_000; // 5 min
      break;
    case 3:
      baseMs = 900_000; // 15 min
      break;
    default:
      baseMs = 3_600_000; // 1 hour
      break;
  }
  // Jitter ±20% (multiplier between 0.8 and 1.2)
  const jitter = 0.8 + Math.random() * 0.4;
  return Math.round(baseMs * jitter);
}

export class JobQueue {
  private readonly db: Database;

  constructor(db?: Database) {
    this.db = db ?? getDatabase();
  }

  /**
   * Enqueue a new background job.
   * If a unique dedupe_key conflict occurs with an active job, returns null.
   */
  public enqueue(options: EnqueueJobOptions): JobRow | null {
    const now = Date.now();
    const type = options.type;
    const dedupeKey = options.dedupeKey ?? null;
    const reelId = options.reelId ?? null;
    const destinationId = options.destinationId ?? null;
    const publishingRecordId = options.publishingRecordId ?? null;
    const payloadStr = JSON.stringify(options.payload ?? {});
    const priority = options.priority ?? 100;
    const runAt = options.runAt ?? now;
    const maxAttempts = options.maxAttempts ?? 5;
    const createdBy = options.createdBy ?? 'system';

    const insertStmt = this.db.prepare<
      [
        string,
        string | null,
        number | null,
        number | null,
        number | null,
        string,
        number,
        number,
        number,
        string,
        number,
        number,
      ]
    >(`
      INSERT INTO background_jobs (
        type, dedupe_key, reel_id, destination_id, publishing_record_id,
        payload, priority, run_at, max_attempts, created_by,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    try {
      const info = insertStmt.run(
        type,
        dedupeKey,
        reelId,
        destinationId,
        publishingRecordId,
        payloadStr,
        priority,
        runAt,
        maxAttempts,
        createdBy,
        now,
        now,
      );

      return this.getJobById(Number(info.lastInsertRowid));
    } catch (err: unknown) {
      const sqliteErr = err as { code?: string; message?: string };
      if (sqliteErr.code === 'SQLITE_CONSTRAINT' && dedupeKey) {
        logger.debug({ dedupeKey }, 'Job enqueue skipped: active job with dedupe_key exists');
        return null;
      }
      throw err;
    }
  }

  /**
   * Atomically claim the next eligible job using BEGIN IMMEDIATE.
   */
  public claimNextJob(
    workerId: string,
    supportedTypes?: string[] | undefined,
    leaseDurationMs = 120_000,
  ): JobRow | null {
    const claimTxn = this.db.transaction(() => {
      const now = Date.now();

      // Check global pause
      const pausedSetting = this.db
        .prepare<[string], { value: string | null }>(
          'SELECT value FROM application_settings WHERE key = ?',
        )
        .get('automation_paused');

      if (pausedSetting?.value === 'true' || pausedSetting?.value === '"true"') {
        // Automation is paused: refuse new claims
        return null;
      }

      // Build query to find the best candidate job
      // Criteria:
      // - state = 'queued' AND run_at <= now
      // - OR expired lease: state IN ('leased', 'running') AND lease_expires_at < now
      // - cancel_requested = 0
      // - destination enabled and not paused (if destination_id is not null)
      let typeFilter = '';
      const params: (number | string)[] = [now, now];

      if (supportedTypes && supportedTypes.length > 0) {
        const placeholders = supportedTypes.map(() => '?').join(',');
        typeFilter = `AND j.type IN (${placeholders})`;
        params.push(...supportedTypes);
      }

      const candidate = this.db
        .prepare<
          (number | string)[],
          { id: number }
        >(`
          SELECT j.id
          FROM background_jobs j
          LEFT JOIN publishing_destinations d ON j.destination_id = d.id
          WHERE (
            (j.state = 'queued' AND j.run_at <= ?)
            OR (j.state IN ('leased', 'running') AND j.lease_expires_at < ?)
          )
          AND j.cancel_requested = 0
          AND (j.destination_id IS NULL OR (d.enabled = 1 AND d.paused = 0))
          ${typeFilter}
          ORDER BY j.priority ASC, j.run_at ASC, j.id ASC
          LIMIT 1
        `)
        .get(...params);

      if (!candidate) {
        return null;
      }

      const leaseExpiresAt = now + leaseDurationMs;
      const updateResult = this.db
        .prepare<
          [string, number, number, number, number, number]
        >(`
          UPDATE background_jobs
          SET state = 'leased',
              lease_owner = ?,
              lease_expires_at = ?,
              heartbeat_at = ?,
              attempts = attempts + 1,
              updated_at = ?
          WHERE id = ?
            AND (
              state = 'queued'
              OR (state IN ('leased', 'running') AND lease_expires_at < ?)
            )
        `)
        .run(workerId, leaseExpiresAt, now, now, candidate.id, now);

      if (updateResult.changes !== 1) {
        return null;
      }

      return this.getJobById(candidate.id);
    });

    return claimTxn.immediate();
  }

  /**
   * Worker marks job as running.
   */
  public startJob(jobId: number, workerId: string): boolean {
    const now = Date.now();
    const result = this.db
      .prepare<[number, number, number, number, string]>(`
        UPDATE background_jobs
        SET state = 'running',
            started_at = ?,
            heartbeat_at = ?,
            updated_at = ?
        WHERE id = ? AND lease_owner = ? AND state = 'leased'
      `)
      .run(now, now, now, jobId, workerId);

    return result.changes === 1;
  }

  /**
   * Heartbeat to extend worker lease. Returns false if lease lost (fenced).
   */
  public heartbeat(jobId: number, workerId: string, extendMs = 60_000): boolean {
    const now = Date.now();
    const newExpiresAt = now + extendMs;
    const result = this.db
      .prepare<[number, number, number, number, string]>(`
        UPDATE background_jobs
        SET lease_expires_at = ?,
            heartbeat_at = ?,
            updated_at = ?
        WHERE id = ? AND lease_owner = ? AND state IN ('leased', 'running')
      `)
      .run(newExpiresAt, now, now, jobId, workerId);

    return result.changes === 1;
  }

  /**
   * Checkpoint payload update. Fenced by lease_owner and active state.
   */
  public checkpoint(
    jobId: number,
    workerId: string,
    payloadUpdates: Record<string, unknown>,
  ): boolean {
    const txn = this.db.transaction(() => {
      const now = Date.now();
      const row = this.db
        .prepare<[number, string], { payload: string }>(`
          SELECT payload
          FROM background_jobs
          WHERE id = ? AND lease_owner = ? AND state IN ('leased', 'running')
        `)
        .get(jobId, workerId);

      if (!row) {
        return false;
      }

      let current: Record<string, unknown> = {};
      try {
        current = JSON.parse(row.payload) as Record<string, unknown>;
      } catch {
        current = {};
      }

      const merged = JSON.stringify({ ...current, ...payloadUpdates });
      const result = this.db
        .prepare<[string, number, number, number, string]>(`
          UPDATE background_jobs
          SET payload = ?,
              heartbeat_at = ?,
              updated_at = ?
          WHERE id = ? AND lease_owner = ? AND state IN ('leased', 'running')
        `)
        .run(merged, now, now, jobId, workerId);

      return result.changes === 1;
    });

    return txn.immediate();
  }

  /**
   * Finalize a job (succeeded, failed, or cancelled).
   * Releases lease and clears any video_files locks in the same transaction.
   */
  public finalizeJob(
    jobId: number,
    workerId: string,
    outcome: 'succeeded' | 'failed' | 'cancelled',
    errorDetails?: { code?: string; message?: string } | undefined,
  ): boolean {
    const txn = this.db.transaction(() => {
      const now = Date.now();
      const job = this.db
        .prepare<[number, string], { id: number; attempts: number; max_attempts: number }>(`
          SELECT id, attempts, max_attempts
          FROM background_jobs
          WHERE id = ? AND lease_owner = ? AND state IN ('leased', 'running')
        `)
        .get(jobId, workerId);

      if (!job) {
        // Fenced: worker lost lease or job already finished
        logger.warn({ jobId, workerId }, 'Worker tried to finalize fenced job');
        return false;
      }

      if (outcome === 'succeeded') {
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
          .run(now, now, jobId);
      } else if (outcome === 'failed') {
        const isRetryable = job.attempts < job.max_attempts;
        const errCode = errorDetails?.code ?? 'ERROR';
        const errMsg = errorDetails?.message ?? 'Job failed';

        if (isRetryable) {
          const delayMs = computeBackoff(job.attempts);
          const nextRunAt = now + delayMs;
          this.db
            .prepare<[number, string, string, number, number]>(`
              UPDATE background_jobs
              SET state = 'queued',
                  run_at = ?,
                  last_error_code = ?,
                  last_error_message = ?,
                  lease_owner = NULL,
                  lease_expires_at = NULL,
                  updated_at = ?
              WHERE id = ?
            `)
            .run(nextRunAt, errCode, errMsg, now, jobId);
        } else {
          // Exhausted max attempts: park as dead
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
            .run(now, errCode, errMsg, now, jobId);
        }
      } else if (outcome === 'cancelled') {
        this.db
          .prepare<[number, number, number]>(`
            UPDATE background_jobs
            SET state = 'cancelled',
                finished_at = ?,
                lease_owner = NULL,
                lease_expires_at = NULL,
                updated_at = ?
            WHERE id = ?
          `)
          .run(now, now, jobId);
      }

      // Release any video file locks held by this job
      this.db
        .prepare<[number, number]>(`
          UPDATE video_files
          SET in_use_by_job_id = NULL,
              in_use_since = NULL,
              updated_at = ?
          WHERE in_use_by_job_id = ?
        `)
        .run(now, jobId);

      return true;
    });

    return txn.immediate();
  }

  /**
   * Acquire a file lock for a background job.
   */
  public acquireFileLock(jobId: number, fileId: number): boolean {
    const now = Date.now();
    const result = this.db
      .prepare<[number, number, number, number, number]>(`
        UPDATE video_files
        SET in_use_by_job_id = ?,
            in_use_since = ?,
            updated_at = ?
        WHERE id = ? AND (in_use_by_job_id IS NULL OR in_use_by_job_id = ?)
      `)
      .run(jobId, now, now, fileId, jobId);

    return result.changes === 1;
  }

  /**
   * Release file lock.
   */
  public releaseFileLock(jobId: number, fileId?: number | undefined): void {
    const now = Date.now();
    if (fileId !== undefined) {
      this.db
        .prepare<[number, number, number]>(`
          UPDATE video_files
          SET in_use_by_job_id = NULL,
              in_use_since = NULL,
              updated_at = ?
          WHERE in_use_by_job_id = ? AND id = ?
        `)
        .run(now, jobId, fileId);
    } else {
      this.db
        .prepare<[number, number]>(`
          UPDATE video_files
          SET in_use_by_job_id = NULL,
              in_use_since = NULL,
              updated_at = ?
          WHERE in_use_by_job_id = ?
        `)
        .run(now, jobId);
    }
  }

  /**
   * Check if cancel was requested on this job.
   */
  public isCancelRequested(jobId: number): boolean {
    const row = this.db
      .prepare<[number], { cancel_requested: number }>(`
        SELECT cancel_requested FROM background_jobs WHERE id = ?
      `)
      .get(jobId);
    return row?.cancel_requested === 1;
  }

  /**
   * Request cancellation for a job.
   * If queued, cancels immediately. If leased/running, sets cancel_requested flag.
   */
  public requestCancel(jobId: number): boolean {
    const txn = this.db.transaction(() => {
      const now = Date.now();
      const result = this.db
        .prepare<[number, number, number]>(`
          UPDATE background_jobs
          SET cancel_requested = 1,
              state = CASE WHEN state = 'queued' THEN 'cancelled' ELSE state END,
              finished_at = CASE WHEN state = 'queued' THEN ? ELSE finished_at END,
              lease_owner = CASE WHEN state = 'queued' THEN NULL ELSE lease_owner END,
              lease_expires_at = CASE WHEN state = 'queued' THEN NULL ELSE lease_expires_at END,
              updated_at = ?
          WHERE id = ? AND state IN ('queued', 'leased', 'running')
        `)
        .run(now, now, jobId);

      return result.changes === 1;
    });

    return txn.immediate();
  }

  /**
   * Manual retry for a dead, failed, or cancelled job.
   */
  public manualRetry(jobId: number): boolean {
    const now = Date.now();
    const result = this.db
      .prepare<[number, number, number]>(`
        UPDATE background_jobs
        SET state = 'queued',
            run_at = ?,
            attempts = 0,
            lease_owner = NULL,
            lease_expires_at = NULL,
            last_error_code = NULL,
            last_error_message = NULL,
            cancel_requested = 0,
            updated_at = ?
        WHERE id = ? AND state IN ('failed', 'dead', 'cancelled')
      `)
      .run(now, now, jobId);

    return result.changes === 1;
  }

  /**
   * Retrieve a job by its ID.
   */
  public getJobById(jobId: number): JobRow | null {
    const row = this.db
      .prepare<[number], JobRow>(`
        SELECT * FROM background_jobs WHERE id = ?
      `)
      .get(jobId);

    return row ?? null;
  }

  /**
   * List jobs with filters and pagination.
   */
  public listJobs(options: ListJobsOptions = {}): { jobs: JobRow[]; total: number } {
    const conditions: string[] = [];
    const params: (number | string)[] = [];

    if (options.state) {
      conditions.push('state = ?');
      params.push(options.state);
    }
    if (options.type) {
      conditions.push('type = ?');
      params.push(options.type);
    }
    if (options.reelId !== undefined) {
      conditions.push('reel_id = ?');
      params.push(options.reelId);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRow = this.db
      .prepare<(number | string)[], { count: number }>(`
        SELECT COUNT(*) as count FROM background_jobs ${whereClause}
      `)
      .get(...params);

    const limit = options.limit ?? 20;
    const offset = options.offset ?? 0;
    const queryParams = [...params, limit, offset];

    const jobs = this.db
      .prepare<(number | string)[], JobRow>(`
        SELECT * FROM background_jobs
        ${whereClause}
        ORDER BY id DESC
        LIMIT ? OFFSET ?
      `)
      .all(...queryParams);

    return {
      jobs,
      total: countRow?.count ?? 0,
    };
  }
}
