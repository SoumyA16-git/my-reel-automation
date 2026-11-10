import { type Database } from 'better-sqlite3';
import { logger } from '../logger.js';

export type AuditResult = 'success' | 'denied' | 'error';

export interface AuditLogEntry {
  actorId?: number | null;
  ip?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  result: AuditResult;
}

export class AuditService {
  constructor(private readonly db: Database) {}

  /**
   * Record a security-critical action in the append-only audit log.
   * Any sensitive fields in `before` or `after` should already be masked or fingerprinted.
   */
  log(entry: AuditLogEntry): void {
    const now = Date.now();
    const beforeJson = entry.before ? JSON.stringify(entry.before) : null;
    const afterJson = entry.after ? JSON.stringify(entry.after) : null;

    try {
      this.db
        .prepare<[number, number | null, string | null, string, string | null, string | null, string | null, string | null, string, number]>(`
          INSERT INTO audit_logs (ts, actor_id, ip, action, target_type, target_id, before, after, result, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          now,
          entry.actorId ?? null,
          entry.ip ?? null,
          entry.action,
          entry.targetType ?? null,
          entry.targetId ?? null,
          beforeJson,
          afterJson,
          entry.result,
          now,
        );
    } catch (err) {
      logger.error({ err, action: entry.action }, 'Failed to write to audit_logs');
    }
  }

  /**
   * Query recent audit logs with pagination.
   */
  list(limit = 100, offset = 0): Array<{
    id: number;
    ts: number;
    actorId: number | null;
    ip: string | null;
    action: string;
    targetType: string | null;
    targetId: string | null;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
    result: AuditResult;
    createdAt: number;
  }> {
    const rows = this.db
      .prepare<[number, number]>(`
        SELECT id, ts, actor_id as actorId, ip, action, target_type as targetType,
               target_id as targetId, before, after, result, created_at as createdAt
        FROM audit_logs
        ORDER BY ts DESC
        LIMIT ? OFFSET ?
      `)
      .all(limit, offset) as Array<{
        id: number;
        ts: number;
        actorId: number | null;
        ip: string | null;
        action: string;
        targetType: string | null;
        targetId: string | null;
        before: string | null;
        after: string | null;
        result: AuditResult;
        createdAt: number;
      }>;

    return rows.map((r) => ({
      ...r,
      before: r.before ? (JSON.parse(r.before) as Record<string, unknown>) : null,
      after: r.after ? (JSON.parse(r.after) as Record<string, unknown>) : null,
    }));
  }
}

let _auditService: AuditService | null = null;

export function initAuditService(db: Database): AuditService {
  _auditService = new AuditService(db);
  return _auditService;
}

export function getAuditService(): AuditService {
  if (_auditService === null) {
    throw new Error('AuditService has not been initialized.');
  }
  return _auditService;
}

