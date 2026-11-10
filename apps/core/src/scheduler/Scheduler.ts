import type { Database } from 'better-sqlite3';
import { getDatabase } from '../db/connection.js';
import { JobQueue } from '../queue/JobQueue.js';
import { recomputeAndSaveReelStatus } from '../reels/stateMachine.js';
import { NotificationService } from '../notifications/NotificationService.js';
import { logger } from '../logger.js';

export interface ScheduleSlotRow {
  id: number;
  label: string;
  local_time: string; // HH:MM
  weekday_mask: number; // 0..127
  timezone: string;
  capacity: number;
  enabled: number;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

export interface CreateSlotInput {
  label: string;
  localTime: string;
  weekdayMask?: number | undefined;
  timezone?: string | undefined;
  capacity?: number | undefined;
  enabled?: boolean | undefined;
  sortOrder?: number | undefined;
}

export interface UpdateSlotInput {
  label?: string | undefined;
  localTime?: string | undefined;
  weekdayMask?: number | undefined;
  timezone?: string | undefined;
  capacity?: number | undefined;
  enabled?: boolean | undefined;
  sortOrder?: number | undefined;
}

export interface ScheduledJobRow {
  id: number;
  reel_id: number;
  destination_id: number | null;
  slot_id: number | null;
  scheduled_for: number;
  source: 'slot' | 'custom' | 'auto' | 'publish_now';
  status: 'pending' | 'paused' | 'promoted' | 'missed' | 'cancelled';
  promoted_at: number | null;
  missed_action: string | null;
  created_at: number;
  updated_at: number;
}

export interface PublishingDestinationRow {
  id: number;
  kind: 'instagram' | 'facebook' | 'telegram';
  account_id: number;
  label: string;
  target_id: string;
  video_role: 'censored' | 'raw';
  config: string;
  enabled: number;
  paused: number;
  daily_cap: number | null;
  min_gap_seconds: number;
}

export interface ScheduleReelOptions {
  scheduledFor?: number | undefined;
  slotId?: number | undefined;
  destinationIds?: number[] | undefined;
  source?: 'slot' | 'custom' | 'auto' | 'publish_now' | undefined;
}

/**
 * Given a local slot time "HH:MM", weekday mask, and timezone,
 * computes the next matching UTC epoch timestamp strictly after fromMs.
 */
export function getNextSlotInstant(
  slot: { local_time: string; weekday_mask: number; timezone: string },
  fromMs: number,
): number {
  const [targetHourStr, targetMinuteStr] = slot.local_time.split(':');
  const targetHour = parseInt(targetHourStr ?? '0', 10);
  const targetMinute = parseInt(targetMinuteStr ?? '0', 10);

  // Search forward up to 14 days
  const baseDate = new Date(fromMs);

  for (let dayOffset = 0; dayOffset <= 14; dayOffset++) {
    // Determine the calendar date in target timezone
    const checkDate = new Date(fromMs + dayOffset * 86_400_000);
    const tzDateStr = checkDate.toLocaleDateString('en-US', {
      timeZone: slot.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    // tzDateStr is "MM/DD/YYYY"
    const [monthStr, dayStr, yearStr] = tzDateStr.split('/');
    const year = parseInt(yearStr ?? '2026', 10);
    const month = parseInt(monthStr ?? '1', 10) - 1;
    const day = parseInt(dayStr ?? '1', 10);

    // Approximate UTC candidate
    // Compute timezone offset by comparing UTC representation with timezone representation
    const guessUtc = new Date(Date.UTC(year, month, day, targetHour, targetMinute, 0, 0));

    // Formatter to check parts in target timezone
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: slot.timezone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hour12: false,
    });

    const parts = formatter.formatToParts(guessUtc);
    const partMap: Record<string, string> = {};
    for (const p of parts) {
      partMap[p.type] = p.value;
    }

    const localH = parseInt(partMap['hour'] ?? '0', 10);
    const localM = parseInt(partMap['minute'] ?? '0', 10);

    // Offset difference in minutes
    const diffMinutes = (targetHour - localH) * 60 + (targetMinute - localM);
    const exactInstant = guessUtc.getTime() + diffMinutes * 60_000;

    // Check weekday in target timezone
    const dayOfWeekFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: slot.timezone,
      weekday: 'narrow',
    });
    // In JS 0=Sunday, 1=Monday ... 6=Saturday
    const weekdayIdx = new Date(exactInstant).getDay();
    const isDayAllowed = (slot.weekday_mask & (1 << weekdayIdx)) !== 0;

    if (isDayAllowed && exactInstant > fromMs) {
      return exactInstant;
    }
  }

  // Fallback: 24h later
  return fromMs + 86_400_000;
}

export class Scheduler {
  private readonly db: Database;
  private readonly queue: JobQueue;
  private readonly notifications: NotificationService;
  private timer: NodeJS.Timeout | null = null;
  private isTicking = false;

  constructor(db?: Database) {
    this.db = db ?? getDatabase();
    this.queue = new JobQueue(this.db);
    this.notifications = new NotificationService(this.db);
  }

  // -------------------------------------------------------------------------
  // Schedule Slots Management
  // -------------------------------------------------------------------------

  public getSlots(): ScheduleSlotRow[] {
    return this.db
      .prepare<[], ScheduleSlotRow>(`
        SELECT * FROM schedule_slots ORDER BY sort_order ASC, local_time ASC
      `)
      .all();
  }

  public getSlotById(id: number): ScheduleSlotRow | null {
    const row = this.db
      .prepare<[number], ScheduleSlotRow>(`
        SELECT * FROM schedule_slots WHERE id = ?
      `)
      .get(id);
    return row ?? null;
  }

  public createSlot(input: CreateSlotInput): ScheduleSlotRow {
    const now = Date.now();
    const weekdayMask = input.weekdayMask ?? 127;
    const timezone = input.timezone ?? 'Asia/Kolkata';
    const capacity = input.capacity ?? 1;
    const enabled = input.enabled === false ? 0 : 1;
    const sortOrder = input.sortOrder ?? 0;

    const info = this.db
      .prepare<[string, string, number, string, number, number, number, number, number]>(`
        INSERT INTO schedule_slots (
          label, local_time, weekday_mask, timezone, capacity,
          enabled, sort_order, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.label,
        input.localTime,
        weekdayMask,
        timezone,
        capacity,
        enabled,
        sortOrder,
        now,
        now,
      );

    const slot = this.getSlotById(Number(info.lastInsertRowid));
    if (!slot) throw new Error('Failed to retrieve newly created slot');
    return slot;
  }

  public updateSlot(id: number, input: UpdateSlotInput): ScheduleSlotRow {
    const existing = this.getSlotById(id);
    if (!existing) throw new Error(`Slot not found: ${id}`);

    const now = Date.now();
    const label = input.label ?? existing.label;
    const localTime = input.localTime ?? existing.local_time;
    const weekdayMask = input.weekdayMask ?? existing.weekday_mask;
    const timezone = input.timezone ?? existing.timezone;
    const capacity = input.capacity ?? existing.capacity;
    const enabled = input.enabled !== undefined ? (input.enabled ? 1 : 0) : existing.enabled;
    const sortOrder = input.sortOrder ?? existing.sort_order;

    this.db
      .prepare<[string, string, number, string, number, number, number, number, number]>(`
        UPDATE schedule_slots
        SET label = ?, local_time = ?, weekday_mask = ?, timezone = ?,
            capacity = ?, enabled = ?, sort_order = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(label, localTime, weekdayMask, timezone, capacity, enabled, sortOrder, now, id);

    const updated = this.getSlotById(id);
    if (!updated) throw new Error(`Failed to retrieve updated slot: ${id}`);
    return updated;
  }

  public deleteSlot(id: number): void {
    // Note: deleting a slot sets slot_id = NULL on scheduled_jobs (ON DELETE SET NULL)
    this.db.prepare<[number]>('DELETE FROM schedule_slots WHERE id = ?').run(id);
  }

  // -------------------------------------------------------------------------
  // Reel Scheduling & Conflict Detection
  // -------------------------------------------------------------------------

  /**
   * Schedule a Reel for a specific instant or slot.
   */
  public scheduleReel(reelId: number, options: ScheduleReelOptions): ScheduledJobRow[] {
    const txn = this.db.transaction(() => {
      const now = Date.now();

      // Verify reel exists and has approved caption
      const reel = this.db
        .prepare<[number], { id: number; approved_ai_content_id: number | null; status: string }>(`
          SELECT id, approved_ai_content_id, status FROM reels WHERE id = ?
        `)
        .get(reelId);

      if (!reel) {
        throw new Error(`Reel #${reelId} not found`);
      }
      if (!reel.approved_ai_content_id) {
        throw new Error(`Cannot schedule Reel #${reelId}: no approved caption`);
      }

      // Determine scheduled instant
      let scheduledFor: number;
      let slotId: number | null = options.slotId ?? null;
      const source = options.source ?? (slotId ? 'slot' : 'custom');

      if (slotId) {
        const slot = this.getSlotById(slotId);
        if (!slot) throw new Error(`Slot #${slotId} not found`);
        if (!slot.enabled) throw new Error(`Slot #${slotId} is disabled`);
        scheduledFor = getNextSlotInstant(slot, now);
      } else if (options.scheduledFor) {
        if (options.scheduledFor <= now) {
          throw new Error('Scheduled time must be in the future');
        }
        scheduledFor = options.scheduledFor;
      } else {
        throw new Error('Either slotId or scheduledFor timestamp must be provided');
      }

      // Determine destinations
      let destinations: PublishingDestinationRow[];
      if (options.destinationIds && options.destinationIds.length > 0) {
        const placeholders = options.destinationIds.map(() => '?').join(',');
        destinations = this.db
          .prepare<number[], PublishingDestinationRow>(`
            SELECT * FROM publishing_destinations WHERE id IN (${placeholders}) AND enabled = 1
          `)
          .all(...options.destinationIds);
      } else {
        destinations = this.db
          .prepare<[], PublishingDestinationRow>(`
            SELECT * FROM publishing_destinations WHERE enabled = 1
          `)
          .all();
      }

      if (destinations.length === 0) {
        throw new Error('No enabled publishing destinations available to schedule');
      }

      // Conflict check (min_gap_seconds per destination)
      for (const dest of destinations) {
        const gapMs = dest.min_gap_seconds * 1000;
        const conflict = this.db
          .prepare<[number, number, number, number], { id: number; scheduled_for: number }>(`
            SELECT id, scheduled_for
            FROM scheduled_jobs
            WHERE (destination_id = ? OR destination_id IS NULL)
              AND status = 'pending'
              AND reel_id != ?
              AND scheduled_for BETWEEN ? AND ?
            LIMIT 1
          `)
          .get(dest.id, reelId, scheduledFor - gapMs, scheduledFor + gapMs);

        if (conflict) {
          logger.warn(
            { destinationId: dest.id, conflictScheduledFor: conflict.scheduled_for, scheduledFor },
            'Scheduling conflict detected: destination has another job within min_gap_seconds',
          );
        }
      }

      // Cancel any existing pending schedules for this reel
      this.db
        .prepare<[number, number]>(`
          UPDATE scheduled_jobs
          SET status = 'cancelled', updated_at = ?
          WHERE reel_id = ? AND status = 'pending'
        `)
        .run(now, reelId);

      // Create scheduled job row
      // We create one scheduled_jobs row with destination_id = NULL if all destinations share the time,
      // or one per destination if custom per-destination override was used.
      const createdRows: ScheduledJobRow[] = [];

      if (options.destinationIds && options.destinationIds.length > 0) {
        for (const dest of destinations) {
          const info = this.db
            .prepare<[number, number, number | null, number, string, number, number]>(`
              INSERT INTO scheduled_jobs (
                reel_id, destination_id, slot_id, scheduled_for, source,
                created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?)
            `)
            .run(reelId, dest.id, slotId, scheduledFor, source, now, now);

          const row = this.db
            .prepare<[number], ScheduledJobRow>('SELECT * FROM scheduled_jobs WHERE id = ?')
            .get(Number(info.lastInsertRowid));
          if (row) createdRows.push(row);
        }
      } else {
        const info = this.db
          .prepare<[number, number | null, number, string, number, number]>(`
            INSERT INTO scheduled_jobs (
              reel_id, slot_id, scheduled_for, source,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?)
          `)
          .run(reelId, slotId, scheduledFor, source, now, now);

        const row = this.db
          .prepare<[number], ScheduledJobRow>('SELECT * FROM scheduled_jobs WHERE id = ?')
          .get(Number(info.lastInsertRowid));
        if (row) createdRows.push(row);
      }

      // Update reel aggregate status
      recomputeAndSaveReelStatus(this.db, reelId);

      return createdRows;
    });

    return txn.immediate();
  }

  /**
   * Cancel scheduling for a Reel.
   */
  public unscheduleReel(reelId: number): void {
    const txn = this.db.transaction(() => {
      const now = Date.now();
      this.db
        .prepare<[number, number]>(`
          UPDATE scheduled_jobs
          SET status = 'cancelled', updated_at = ?
          WHERE reel_id = ? AND status IN ('pending', 'paused')
        `)
        .run(now, reelId);

      recomputeAndSaveReelStatus(this.db, reelId);
    });

    txn.immediate();
  }

  // -------------------------------------------------------------------------
  // Auto-Assign Ready Reels
  // -------------------------------------------------------------------------

  /**
   * Auto-assign ready Reels to earliest available slots.
   */
  public autoAssignReadyReels(): number {
    const txn = this.db.transaction(() => {
      const now = Date.now();

      // Find ready reels without pending scheduled jobs
      const readyReels = this.db
        .prepare<[], { id: number; priority: number }>(`
          SELECT r.id, r.priority
          FROM reels r
          WHERE r.status = 'ready'
            AND r.deleted_at IS NULL
            AND r.id NOT IN (
              SELECT reel_id FROM scheduled_jobs WHERE status = 'pending'
            )
          ORDER BY r.priority DESC, r.created_at ASC
        `)
        .all();

      if (readyReels.length === 0) return 0;

      const enabledSlots = this.db
        .prepare<[], ScheduleSlotRow>(`
          SELECT * FROM schedule_slots WHERE enabled = 1 ORDER BY sort_order ASC, local_time ASC
        `)
        .all();

      if (enabledSlots.length === 0) return 0;

      let assignedCount = 0;
      let searchInstant = now;

      for (const reel of readyReels) {
        // Find next slot instant with remaining capacity
        let assigned = false;

        for (let attempt = 0; attempt < 28; attempt++) {
          // Find earliest next instant across all enabled slots
          let bestInstant = Infinity;
          let bestSlot: ScheduleSlotRow | null = null;

          for (const slot of enabledSlots) {
            const nextInst = getNextSlotInstant(slot, searchInstant);
            if (nextInst < bestInstant) {
              bestInstant = nextInst;
              bestSlot = slot;
            }
          }

          if (!bestSlot || bestInstant === Infinity) break;

          // Check occupied count at this instant
          const occupiedCountRow = this.db
            .prepare<[number, number], { count: number }>(`
              SELECT COUNT(*) as count
              FROM scheduled_jobs
              WHERE slot_id = ? AND scheduled_for = ? AND status = 'pending'
            `)
            .get(bestSlot.id, bestInstant);

          const occupied = occupiedCountRow?.count ?? 0;

          if (occupied < bestSlot.capacity) {
            // Assign to this slot
            this.db
              .prepare<[number, number, number, number, number]>(`
                INSERT INTO scheduled_jobs (
                  reel_id, slot_id, scheduled_for, source, status, created_at, updated_at
                ) VALUES (?, ?, ?, 'auto', 'pending', ?, ?)
              `)
              .run(reel.id, bestSlot.id, bestInstant, now, now);

            recomputeAndSaveReelStatus(this.db, reel.id);
            assignedCount++;
            assigned = true;
            searchInstant = bestInstant;
            break;
          } else {
            // Capacity full at this instant, push searchInstant slightly forward
            searchInstant = bestInstant + 1000;
          }
        }

        if (!assigned) {
          logger.warn({ reelId: reel.id }, 'Could not find free slot for auto-assign');
        }
      }

      return assignedCount;
    });

    return txn.immediate();
  }

  // -------------------------------------------------------------------------
  // Publish-Now
  // -------------------------------------------------------------------------

  /**
   * Immediate publishing intent: creates scheduled_jobs with scheduled_for=now and promotes immediately.
   */
  public publishNow(reelId: number, destinationIds?: number[] | undefined): void {
    const txn = this.db.transaction(() => {
      const now = Date.now();

      const reel = this.db
        .prepare<[number], { id: number; approved_ai_content_id: number | null }>(`
          SELECT id, approved_ai_content_id FROM reels WHERE id = ?
        `)
        .get(reelId);

      if (!reel) throw new Error(`Reel #${reelId} not found`);
      if (!reel.approved_ai_content_id) throw new Error(`Reel #${reelId} has no approved caption`);

      // Cancel existing pending schedules
      this.db
        .prepare<[number, number]>(`
          UPDATE scheduled_jobs SET status = 'cancelled', updated_at = ?
          WHERE reel_id = ? AND status = 'pending'
        `)
        .run(now, reelId);

      // Insert publish_now schedule
      const info = this.db
        .prepare<[number, number, number, number]>(`
          INSERT INTO scheduled_jobs (
            reel_id, scheduled_for, source, status, created_at, updated_at
          ) VALUES (?, ?, 'publish_now', 'pending', ?, ?)
        `)
        .run(reelId, now, now, now);

      const scheduledJobId = Number(info.lastInsertRowid);

      // Promote immediately
      this.promoteScheduledJob(scheduledJobId, 10, destinationIds);
    });

    txn.immediate();
  }

  // -------------------------------------------------------------------------
  // Promotion: scheduled_jobs -> publishing_records + background_jobs
  // -------------------------------------------------------------------------

  public promoteScheduledJob(
    scheduledJobId: number,
    priority = 100,
    targetDestinationIds?: number[] | undefined,
  ): boolean {
    const txn = this.db.transaction(() => {
      const now = Date.now();
      const sched = this.db
        .prepare<[number], ScheduledJobRow>('SELECT * FROM scheduled_jobs WHERE id = ?')
        .get(scheduledJobId);

      if (!sched || sched.status !== 'pending') return false;

      const reel = this.db
        .prepare<[number], { id: number; approved_ai_content_id: number | null }>(`
          SELECT id, approved_ai_content_id FROM reels WHERE id = ?
        `)
        .get(sched.reel_id);

      if (!reel || !reel.approved_ai_content_id) {
        logger.error({ scheduledJobId, reelId: sched.reel_id }, 'Cannot promote: missing approved caption');
        this.db
          .prepare<[number, number]>(`
            UPDATE scheduled_jobs SET status = 'cancelled', updated_at = ? WHERE id = ?
          `)
          .run(now, scheduledJobId);
        return false;
      }

      // Get target destinations
      let destinations: PublishingDestinationRow[];
      if (sched.destination_id) {
        destinations = this.db
          .prepare<[number], PublishingDestinationRow>(`
            SELECT * FROM publishing_destinations WHERE id = ?
          `)
          .all(sched.destination_id);
      } else if (targetDestinationIds && targetDestinationIds.length > 0) {
        const placeholders = targetDestinationIds.map(() => '?').join(',');
        destinations = this.db
          .prepare<number[], PublishingDestinationRow>(`
            SELECT * FROM publishing_destinations WHERE id IN (${placeholders}) AND enabled = 1
          `)
          .all(...targetDestinationIds);
      } else {
        destinations = this.db
          .prepare<[], PublishingDestinationRow>(`
            SELECT * FROM publishing_destinations WHERE enabled = 1
          `)
          .all();
      }

      if (destinations.length === 0) {
        logger.warn({ scheduledJobId }, 'No active destinations to promote scheduled job');
        return false;
      }

      // For each destination, find appropriate video file and create record + job
      for (const dest of destinations) {
        if (dest.paused === 1) {
          logger.info({ destinationId: dest.id }, 'Destination is paused; skipping promotion');
          continue;
        }

        // Daily cap check (PRD 9.3)
        if (dest.daily_cap !== null && dest.daily_cap > 0) {
          const publishedLast24h = this.db
            .prepare<[number, number], { count: number }>(`
              SELECT COUNT(*) as count
              FROM publishing_records
              WHERE destination_id = ? AND published_at >= ?
            `)
            .get(dest.id, now - 86_400_000);

          if ((publishedLast24h?.count ?? 0) >= dest.daily_cap) {
            logger.warn(
              { destinationId: dest.id, dailyCap: dest.daily_cap },
              'Destination daily cap reached; deferring job',
            );
            continue;
          }
        }

        // Find required video file by role
        const videoFile = this.db
          .prepare<[number, string], { id: number }>(`
            SELECT id FROM video_files
            WHERE reel_id = ? AND role = ? AND state = 'present'
          `)
          .get(sched.reel_id, dest.video_role);

        if (!videoFile) {
          logger.error(
            { reelId: sched.reel_id, role: dest.video_role },
            'Cannot promote: required video file not found',
          );
          continue;
        }

        const idempotencyKey = `pub:${sched.reel_id}:${dest.id}:${sched.scheduled_for}`;
        const dedupeKey = `publish:${sched.reel_id}:${dest.id}:${sched.scheduled_for}`;

        // Find or create publishing_record
        let record = this.db
          .prepare<[number, number], { id: number; status: string }>(`
            SELECT id, status FROM publishing_records
            WHERE reel_id = ? AND destination_id = ?
          `)
          .get(sched.reel_id, dest.id);

        if (!record) {
          const recInfo = this.db
            .prepare<[number, number, number, number, string, number, number]>(`
              INSERT INTO publishing_records (
                reel_id, destination_id, video_file_id, ai_content_id,
                status, idempotency_key, created_at, updated_at
              ) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)
            `)
            .run(
              sched.reel_id,
              dest.id,
              videoFile.id,
              reel.approved_ai_content_id,
              idempotencyKey,
              now,
              now,
            );

          record = { id: Number(recInfo.lastInsertRowid), status: 'queued' };
        } else if (record.status !== 'published') {
          this.db
            .prepare<[number, number]>(`
              UPDATE publishing_records SET status = 'queued', updated_at = ? WHERE id = ?
            `)
            .run(now, record.id);
        }

        // If destination already terminal (published), don't recreate job
        if (record.status === 'published') {
          continue;
        }

        // Enqueue background job with unique dedupe key
        const jobType = `publish.${dest.kind}`;

        this.queue.enqueue({
          type: jobType,
          dedupeKey,
          reelId: sched.reel_id,
          destinationId: dest.id,
          publishingRecordId: record.id,
          payload: {
            reelId: sched.reel_id,
            destinationId: dest.id,
            publishingRecordId: record.id,
          },
          priority,
          runAt: now,
          createdBy: 'scheduler',
        });
      }

      // Mark scheduled job as promoted
      this.db
        .prepare<[number, number, number]>(`
          UPDATE scheduled_jobs
          SET status = 'promoted', promoted_at = ?, updated_at = ?
          WHERE id = ?
        `)
        .run(now, now, scheduledJobId);

      // Recompute reel status
      recomputeAndSaveReelStatus(this.db, sched.reel_id);

      return true;
    });

    return txn.immediate();
  }

  // -------------------------------------------------------------------------
  // Scheduler Tick Loop (runs every 15s)
  // -------------------------------------------------------------------------

  /**
   * Single scheduler tick: checks global pause, handles due and missed jobs.
   */
  public tick(): void {
    if (this.isTicking) return;
    this.isTicking = true;

    try {
      // 1. Check global pause
      const pausedSetting = this.db
        .prepare<[string], { value: string | null }>(
          'SELECT value FROM application_settings WHERE key = ?',
        )
        .get('automation_paused');

      if (pausedSetting?.value === 'true' || pausedSetting?.value === '"true"') {
        return;
      }

      const now = Date.now();

      // 2. Query due scheduled jobs
      const dueJobs = this.db
        .prepare<[number], ScheduledJobRow>(`
          SELECT * FROM scheduled_jobs
          WHERE status = 'pending' AND scheduled_for <= ?
          ORDER BY scheduled_for ASC
        `)
        .all(now);

      for (const job of dueJobs) {
        const latenessMs = now - job.scheduled_for;

        // Missed-schedule check: > 2 hours (PRD 9.5 / FR-012)
        if (latenessMs > 2 * 3600 * 1000) {
          logger.warn(
            { jobId: job.id, reelId: job.reel_id, latenessMs },
            'Scheduled job is older than 2 hours; applying missed policy',
          );

          // Get missed policy setting (default 'move_next')
          const policySetting = this.db
            .prepare<[string], { value: string | null }>(
              'SELECT value FROM application_settings WHERE key = ?',
            )
            .get('missed_policy');

          const policy = policySetting?.value?.replace(/"/g, '') ?? 'move_next';

          if (policy === 'move_next') {
            this.db
              .prepare<[string, number, number]>(`
                UPDATE scheduled_jobs
                SET status = 'missed', missed_action = ?, updated_at = ?
                WHERE id = ?
              `)
              .run('moved_next', now, job.id);

            this.notifications.create({
              severity: 'warning',
              type: 'schedule_missed',
              title: `Scheduled publish missed for Reel #${job.reel_id}`,
              body: `Job was overdue by ${Math.round(latenessMs / 60000)} minutes. Moved to next available slot.`,
              reelId: job.reel_id,
            });

            // Reschedule to next slot instant
            if (job.slot_id) {
              const slot = this.getSlotById(job.slot_id);
              if (slot) {
                const nextInstant = getNextSlotInstant(slot, now);
                this.db
                  .prepare<[number, number, number, number, number]>(`
                    INSERT INTO scheduled_jobs (
                      reel_id, slot_id, scheduled_for, source, status, created_at, updated_at
                    ) VALUES (?, ?, ?, 'slot', 'pending', ?, ?)
                  `)
                  .run(job.reel_id, slot.id, nextInstant, now, now);
              }
            }
          } else {
            // Held for admin
            this.db
              .prepare<[string, number, number]>(`
                UPDATE scheduled_jobs
                SET status = 'missed', missed_action = ?, updated_at = ?
                WHERE id = ?
              `)
              .run('held_for_admin', now, job.id);

            this.notifications.create({
              severity: 'warning',
              type: 'schedule_missed',
              title: `Scheduled publish missed for Reel #${job.reel_id}`,
              body: `Job was overdue by ${Math.round(latenessMs / 60000)} minutes. Held for manual admin action.`,
              reelId: job.reel_id,
            });
          }

          recomputeAndSaveReelStatus(this.db, job.reel_id);
        } else {
          // <= 2 hours: promote immediately
          this.promoteScheduledJob(job.id);
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error during scheduler tick');
    } finally {
      this.isTicking = false;
    }
  }

  /**
   * Start scheduler background loop (15s tick).
   */
  public start(intervalMs = 15_000): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.tick(), intervalMs);
    logger.info({ intervalMs }, 'Scheduler tick loop started');
  }

  /**
   * Stop scheduler loop.
   */
  public stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info('Scheduler tick loop stopped');
    }
  }
}
