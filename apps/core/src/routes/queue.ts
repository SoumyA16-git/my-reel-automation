import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { JobQueue } from '../queue/JobQueue.js';
import { csrfProtect } from '../auth/csrf.js';
import { AuditService } from '../audit/AuditService.js';
import { getDatabase } from '../db/connection.js';

const ListJobsSchema = z.object({
  state: z
    .enum(['queued', 'leased', 'running', 'succeeded', 'failed', 'dead', 'cancelled'])
    .optional(),
  type: z.string().optional(),
  reelId: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export function registerQueueRoutes(fastify: FastifyInstance): void {
  const db = getDatabase();
  const queue = new JobQueue(db);
  const audit = new AuditService(db);

  // -------------------------------------------------------------------------
  // GET /api/v1/queue/jobs — list background jobs
  // -------------------------------------------------------------------------
  fastify.get('/api/v1/queue/jobs', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.session) {
      return reply.status(401).send({
        code: 'UNAUTHORIZED',
        message: 'Authentication required',
        requestId: request.id,
      });
    }

    const parseResult = ListJobsSchema.safeParse(request.query);
    if (!parseResult.success) {
      return reply.status(400).send({
        code: 'VALIDATION_ERROR',
        message: 'Invalid query parameters',
        details: parseResult.error.format(),
        requestId: request.id,
      });
    }

    const result = queue.listJobs({
      state: parseResult.data.state,
      type: parseResult.data.type,
      reelId: parseResult.data.reelId,
      limit: parseResult.data.limit,
      offset: parseResult.data.offset,
    });

    return reply.send(result);
  });

  // -------------------------------------------------------------------------
  // POST /api/v1/queue/jobs/:id/retry — manual retry
  // -------------------------------------------------------------------------
  fastify.post(
    '/api/v1/queue/jobs/:id/retry',
    { preHandler: [csrfProtect] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.session) {
        return reply.status(401).send({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
          requestId: request.id,
        });
      }

      const { id } = request.params as { id: string };
      const jobId = parseInt(id, 10);

      const success = queue.manualRetry(jobId);
      if (!success) {
        return reply.status(400).send({
          code: 'RETRY_FAILED',
          message: 'Job cannot be retried (must be in failed, dead, or cancelled state)',
          requestId: request.id,
        });
      }

      audit.log({
        actorId: request.session.adminId,
        action: 'job.retry',
        targetType: 'background_jobs',
        targetId: String(jobId),
        result: 'success',
      });

      return reply.send({ ok: true, message: `Job #${jobId} re-queued` });
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/v1/queue/jobs/:id/cancel — cancel job
  // -------------------------------------------------------------------------
  fastify.post(
    '/api/v1/queue/jobs/:id/cancel',
    { preHandler: [csrfProtect] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.session) {
        return reply.status(401).send({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
          requestId: request.id,
        });
      }

      const { id } = request.params as { id: string };
      const jobId = parseInt(id, 10);

      const success = queue.requestCancel(jobId);
      if (!success) {
        return reply.status(400).send({
          code: 'CANCEL_FAILED',
          message: 'Job cannot be cancelled (must be in queued, leased, or running state)',
          requestId: request.id,
        });
      }

      audit.log({
        actorId: request.session.adminId,
        action: 'job.cancel',
        targetType: 'background_jobs',
        targetId: String(jobId),
        result: 'success',
      });

      return reply.send({ ok: true, message: `Job #${jobId} cancellation requested` });
    },
  );
}

