import { type Database } from 'better-sqlite3';
import { getEventBus } from '../events/EventBus.js';
import { logger } from '../logger.js';

export type NotificationSeverity = 'info' | 'success' | 'warning' | 'critical';

export interface CreateNotificationInput {
  severity: NotificationSeverity;
  type: string;
  title: string;
  body?: string | null;
  reelId?: number | null;
  destinationId?: number | null;
  dedupeKey?: string | null;
}

export class NotificationService {
  constructor(private readonly db: Database) {}

  /**
   * Create an in-dashboard notification.
   * If a dedupeKey is provided and an unread notification with that key already exists,
   * the new notification is suppressed (deduplicated).
   */
  create(input: CreateNotificationInput): number | null {
    const now = Date.now();

    try {
      const result = this.db
        .prepare<[number, string, string, string, string | null, number | null, number | null, string | null, number, number]>(`
          INSERT OR IGNORE INTO notifications (ts, severity, type, title, body, reel_id, destination_id, dedupe_key, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          now,
          input.severity,
          input.type,
          input.title,
          input.body ?? null,
          input.reelId ?? null,
          input.destinationId ?? null,
          input.dedupeKey ?? null,
          now,
          now,
        );

      if (result.changes === 0) {
        logger.debug({ dedupeKey: input.dedupeKey }, 'Notification suppressed by deduplication key');
        return null;
      }

      const id = result.lastInsertRowid as number;
      logger.info({ id, type: input.type, severity: input.severity }, 'Notification created');

      try {
        getEventBus().emitNotificationCreated({
          id,
          severity: input.severity,
          type: input.type,
          title: input.title,
          body: input.body ?? null,
          reelId: input.reelId ?? null,
          destinationId: input.destinationId ?? null,
          createdAt: now,
        });
      } catch {
        // Non-fatal if eventBus not available
      }

      return id;
    } catch (err) {
      logger.error({ err, type: input.type }, 'Failed to create notification');
      return null;
    }
  }

  /**
   * List recent notifications.
   */
  list(unreadOnly = false, limit = 50): Array<{
    id: number;
    ts: number;
    severity: NotificationSeverity;
    type: string;
    title: string;
    body: string | null;
    reelId: number | null;
    destinationId: number | null;
    readAt: number | null;
  }> {
    const sql = unreadOnly
      ? `SELECT id, ts, severity, type, title, body, reel_id as reelId, destination_id as destinationId, read_at as readAt
         FROM notifications WHERE read_at IS NULL ORDER BY ts DESC LIMIT ?`
      : `SELECT id, ts, severity, type, title, body, reel_id as reelId, destination_id as destinationId, read_at as readAt
         FROM notifications ORDER BY ts DESC LIMIT ?`;

    return this.db.prepare<[number]>(sql).all(limit) as Array<{
      id: number;
      ts: number;
      severity: NotificationSeverity;
      type: string;
      title: string;
      body: string | null;
      reelId: number | null;
      destinationId: number | null;
      readAt: number | null;
    }>;
  }

  /**
   * Mark a notification as read.
   */
  markAsRead(id: number): boolean {
    const now = Date.now();
    const result = this.db
      .prepare<[number, number, number]>(
        'UPDATE notifications SET read_at = ?, updated_at = ? WHERE id = ? AND read_at IS NULL',
      )
      .run(now, now, id);
    return result.changes > 0;
  }

  /**
   * Mark all unread notifications as read.
   */
  markAllAsRead(): number {
    const now = Date.now();
    const result = this.db
      .prepare<[number, number]>(
        'UPDATE notifications SET read_at = ?, updated_at = ? WHERE read_at IS NULL',
      )
      .run(now, now);
    return result.changes;
  }
}

let _notificationService: NotificationService | null = null;

export function initNotificationService(db: Database): NotificationService {
  _notificationService = new NotificationService(db);
  return _notificationService;
}

export function getNotificationService(): NotificationService {
  if (_notificationService === null) {
    throw new Error('NotificationService has not been initialized.');
  }
  return _notificationService;
}

