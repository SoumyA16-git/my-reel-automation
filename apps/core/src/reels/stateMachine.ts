import type { Database } from 'better-sqlite3';
import type { ReelStatus } from '@reelhub/shared';
import { logger } from '../logger.js';

interface PublishingRecordStatusRow {
  status: string;
}

interface VideoFileCheckRow {
  role: string;
  state: string;
  validation_state: string;
}

interface ScheduledJobCheckRow {
  status: string;
}

interface ReelCheckRow {
  id: number;
  status: ReelStatus;
  paused: number;
  approved_ai_content_id: number | null;
  deleted_at: number | null;
  completed_at: number | null;
}

/**
 * Computes the aggregate Reel status according to PRD 19.4 specification.
 */
export function deriveReelStatus(db: Database, reelId: number): ReelStatus {
  const reel = db
    .prepare<[number], ReelCheckRow>(`
      SELECT id, status, paused, approved_ai_content_id, deleted_at, completed_at
      FROM reels
      WHERE id = ?
    `)
    .get(reelId);

  if (!reel) {
    throw new Error(`Reel not found: ${reelId}`);
  }

  // Soft-deleted or cancelled stays cancelled
  if (reel.status === 'cancelled') {
    return 'cancelled';
  }

  // Admin paused
  if (reel.paused === 1) {
    return 'paused';
  }

  // Inspect publishing records
  const records = db
    .prepare<[number], PublishingRecordStatusRow>(`
      SELECT status
      FROM publishing_records
      WHERE reel_id = ?
    `)
    .all(reelId);

  if (records.length > 0) {
    const statuses = records.map((r) => r.status);

    const hasInFlight = statuses.some((s) =>
      ['queued', 'in_progress', 'processing_remote', 'verifying'].includes(s),
    );

    const allFinished = statuses.every((s) => ['published', 'skipped'].includes(s));
    const allPublished = statuses.every((s) => s === 'published');

    const publishedCount = statuses.filter((s) => s === 'published').length;
    const stuckCount = statuses.filter((s) =>
      ['failed_retryable', 'needs_auth', 'needs_action', 'uncertain', 'cancelled'].includes(s),
    );

    if (hasInFlight) {
      return 'publishing';
    }

    if (allFinished || allPublished) {
      return 'completed';
    }

    if (publishedCount > 0 && stuckCount.length > 0) {
      return 'partially_published';
    }

    if (publishedCount === 0 && stuckCount.length === records.length) {
      return 'failed';
    }
  }

  // No publishing records (or all pending): check scheduled_jobs
  const pendingSchedules = db
    .prepare<[number], ScheduledJobCheckRow>(`
      SELECT status
      FROM scheduled_jobs
      WHERE reel_id = ? AND status = 'pending'
    `)
    .all(reelId);

  if (pendingSchedules.length > 0) {
    return 'scheduled';
  }

  // Check upload and caption state
  const files = db
    .prepare<[number], VideoFileCheckRow>(`
      SELECT role, state, validation_state
      FROM video_files
      WHERE reel_id = ? AND state = 'present'
    `)
    .all(reelId);

  const hasCensored = files.some(
    (f) => f.role === 'censored' && (f.validation_state === 'valid' || f.validation_state === 'warning'),
  );
  const hasRaw = files.some(
    (f) => f.role === 'raw' && (f.validation_state === 'valid' || f.validation_state === 'warning'),
  );
  const hasApprovedCaption = reel.approved_ai_content_id !== null;

  if (hasCensored && hasRaw && hasApprovedCaption) {
    return 'ready';
  }

  if (hasCensored) {
    return 'waiting_for_ai';
  }

  return 'draft';
}

import { getEventBus } from '../events/EventBus.js';

/**
 * Derives and persists the new aggregate Reel status inside a transaction.
 */
export function recomputeAndSaveReelStatus(db: Database, reelId: number): ReelStatus {
  const txn = db.transaction(() => {
    const newStatus = deriveReelStatus(db, reelId);
    const now = Date.now();

    const isNewlyCompleted = newStatus === 'completed';

    db.prepare<[string, number, number, number, number]>(`
      UPDATE reels
      SET status = ?,
          completed_at = CASE WHEN ? = 1 AND completed_at IS NULL THEN ? ELSE completed_at END,
          updated_at = ?
        WHERE id = ?
    `).run(newStatus, isNewlyCompleted ? 1 : 0, now, now, reelId);

    logger.debug({ reelId, newStatus }, 'Recomputed reel status');
    return newStatus;
  });

  const finalStatus = txn.immediate();
  try {
    getEventBus().emitReelStatusChanged(reelId, finalStatus);
  } catch {
    // Non-fatal if event bus not initialized
  }
  return finalStatus;
}
