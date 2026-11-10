import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getDatabase } from '../db/connection.js';
import { csrfProtect } from '../auth/csrf.js';
import { AuditService } from '../audit/AuditService.js';

interface AutomationStatusRow {
  value: string | null;
  updated_at: number;
}

export function registerAutomationRoutes(fastify: FastifyInstance): void {
  const db = getDatabase();
  const audit = new AuditService(db);

  // -------------------------------------------------------------------------
  // GET /api/v1/automation/status — get automation state
  // -------------------------------------------------------------------------
  fastify.get('/api/v1/automation/status', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.session) {
      return reply.status(401).send({
        code: 'UNAUTHORIZED',
        message: 'Authentication required',
        requestId: request.id,
      });
    }

    const row = db
      .prepare<[string], AutomationStatusRow>(`
        SELECT value, updated_at FROM application_settings WHERE key = ?
      `)
      .get('automation_paused');

    const paused = row?.value === 'true' || row?.value === '"true"';

    const counts = db
      .prepare<[], { queued: number; running: number; leased: number }>(`
        SELECT
          SUM(CASE WHEN state = 'queued' THEN 1 ELSE 0 END) as queued,
          SUM(CASE WHEN state = 'running' THEN 1 ELSE 0 END) as running,
          SUM(CASE WHEN state = 'leased' THEN 1 ELSE 0 END) as leased
        FROM background_jobs
      `)
      .get();

    return reply.send({
      paused,
      updatedAt: row?.updated_at ?? null,
      queuedJobs: counts?.queued ?? 0,
      runningJobs: counts?.running ?? 0,
      leasedJobs: counts?.leased ?? 0,
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/v1/automation/pause — globally pause automation
  // -------------------------------------------------------------------------
  fastify.post(
    '/api/v1/automation/pause',
    { preHandler: [csrfProtect] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.session) {
        return reply.status(401).send({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
          requestId: request.id,
        });
      }

      const now = Date.now();
      db.prepare<[number, number, number, number]>(`
        INSERT INTO application_settings (key, value, is_secret, updated_at, updated_by)
        VALUES ('automation_paused', 'true', 0, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = 'true', updated_at = ?, updated_by = ?
      `).run(now, request.session.adminId, now, request.session.adminId);

      audit.log({
        actorId: request.session.adminId,
        action: 'automation.pause',
        targetType: 'system',
        result: 'success',
      });

      return reply.send({ ok: true, paused: true });
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/v1/automation/resume — globally resume automation
  // -------------------------------------------------------------------------
  fastify.post(
    '/api/v1/automation/resume',
    { preHandler: [csrfProtect] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.session) {
        return reply.status(401).send({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
          requestId: request.id,
        });
      }

      const now = Date.now();
      db.prepare<[number, number, number, number]>(`
        INSERT INTO application_settings (key, value, is_secret, updated_at, updated_by)
        VALUES ('automation_paused', 'false', 0, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = 'false', updated_at = ?, updated_by = ?
      `).run(now, request.session.adminId, now, request.session.adminId);

      audit.log({
        actorId: request.session.adminId,
        action: 'automation.resume',
        targetType: 'system',
        result: 'success',
      });

      return reply.send({ ok: true, paused: false });
    },
  );
}
