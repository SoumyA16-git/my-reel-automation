import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { Scheduler } from '../scheduler/Scheduler.js';
import { csrfProtect } from '../auth/csrf.js';

const CreateSlotSchema = z.object({
  label: z.string().min(1).max(50),
  localTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Local time must be in HH:MM format (24-hour)'),
  weekdayMask: z.number().int().min(0).max(127).optional(),
  timezone: z.string().optional(),
  capacity: z.number().int().positive().optional(),
  enabled: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

const UpdateSlotSchema = CreateSlotSchema.partial();

const ScheduleReelSchema = z.object({
  scheduledFor: z.number().int().positive().optional(),
  slotId: z.number().int().positive().optional(),
  destinationIds: z.array(z.number().int().positive()).optional(),
  source: z.enum(['slot', 'custom', 'auto', 'publish_now']).optional(),
});

let _scheduler: Scheduler | null = null;

export function getScheduler(): Scheduler {
  if (!_scheduler) {
    _scheduler = new Scheduler();
  }
  return _scheduler;
}

export function registerSchedulerRoutes(fastify: FastifyInstance): void {
  const scheduler = getScheduler();

  // -------------------------------------------------------------------------
  // GET /api/v1/schedule/slots — list schedule slots
  // -------------------------------------------------------------------------
  fastify.get('/api/v1/schedule/slots', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.session) {
      return reply.status(401).send({
        code: 'UNAUTHORIZED',
        message: 'Authentication required',
        requestId: request.id,
      });
    }

    const slots = scheduler.getSlots();
    return reply.send({ slots });
  });

  // -------------------------------------------------------------------------
  // POST /api/v1/schedule/slots — create schedule slot
  // -------------------------------------------------------------------------
  fastify.post(
    '/api/v1/schedule/slots',
    { preHandler: [csrfProtect] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.session) {
        return reply.status(401).send({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
          requestId: request.id,
        });
      }

      const parseResult = CreateSlotSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          code: 'VALIDATION_ERROR',
          message: 'Invalid slot data',
          details: parseResult.error.format(),
          requestId: request.id,
        });
      }

      try {
        const slot = scheduler.createSlot(parseResult.data);
        return reply.status(201).send({ slot });
      } catch (err) {
        return reply.status(400).send({
          code: 'CREATE_SLOT_FAILED',
          message: err instanceof Error ? err.message : String(err),
          requestId: request.id,
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // PATCH /api/v1/schedule/slots/:id — update slot
  // -------------------------------------------------------------------------
  fastify.patch(
    '/api/v1/schedule/slots/:id',
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
      const slotId = parseInt(id, 10);

      const parseResult = UpdateSlotSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          code: 'VALIDATION_ERROR',
          message: 'Invalid slot update',
          details: parseResult.error.format(),
          requestId: request.id,
        });
      }

      try {
        const slot = scheduler.updateSlot(slotId, parseResult.data);
        return reply.send({ slot });
      } catch (err) {
        return reply.status(400).send({
          code: 'UPDATE_SLOT_FAILED',
          message: err instanceof Error ? err.message : String(err),
          requestId: request.id,
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /api/v1/schedule/slots/:id — delete slot
  // -------------------------------------------------------------------------
  fastify.delete(
    '/api/v1/schedule/slots/:id',
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
      const slotId = parseInt(id, 10);

      try {
        scheduler.deleteSlot(slotId);
        return reply.send({ ok: true });
      } catch (err) {
        return reply.status(400).send({
          code: 'DELETE_SLOT_FAILED',
          message: err instanceof Error ? err.message : String(err),
          requestId: request.id,
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // PUT /api/v1/reels/:id/schedule — schedule Reel
  // -------------------------------------------------------------------------
  fastify.put(
    '/api/v1/reels/:id/schedule',
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
      const reelId = parseInt(id, 10);

      const parseResult = ScheduleReelSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          code: 'VALIDATION_ERROR',
          message: 'Invalid schedule options',
          details: parseResult.error.format(),
          requestId: request.id,
        });
      }

      try {
        const scheduledJobs = scheduler.scheduleReel(reelId, parseResult.data);
        return reply.send({ scheduledJobs });
      } catch (err) {
        return reply.status(400).send({
          code: 'SCHEDULE_FAILED',
          message: err instanceof Error ? err.message : String(err),
          requestId: request.id,
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /api/v1/reels/:id/schedule — unschedule Reel
  // -------------------------------------------------------------------------
  fastify.delete(
    '/api/v1/reels/:id/schedule',
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
      const reelId = parseInt(id, 10);

      try {
        scheduler.unscheduleReel(reelId);
        return reply.send({ ok: true });
      } catch (err) {
        return reply.status(400).send({
          code: 'UNSCHEDULE_FAILED',
          message: err instanceof Error ? err.message : String(err),
          requestId: request.id,
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/v1/reels/:id/publish-now — publish Reel immediately
  // -------------------------------------------------------------------------
  fastify.post(
    '/api/v1/reels/:id/publish-now',
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
      const reelId = parseInt(id, 10);
      const body = request.body as { destinationIds?: number[] } | undefined;

      try {
        scheduler.publishNow(reelId, body?.destinationIds);
        return reply.send({ ok: true, message: `Reel #${reelId} queued for immediate publish` });
      } catch (err) {
        return reply.status(400).send({
          code: 'PUBLISH_NOW_FAILED',
          message: err instanceof Error ? err.message : String(err),
          requestId: request.id,
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/v1/schedule/auto-assign — auto-assign ready reels to free slots
  // -------------------------------------------------------------------------
  fastify.post(
    '/api/v1/schedule/auto-assign',
    { preHandler: [csrfProtect] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.session) {
        return reply.status(401).send({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
          requestId: request.id,
        });
      }

      try {
        const assignedCount = scheduler.autoAssignReadyReels();
        return reply.send({ assignedCount });
      } catch (err) {
        return reply.status(400).send({
          code: 'AUTO_ASSIGN_FAILED',
          message: err instanceof Error ? err.message : String(err),
          requestId: request.id,
        });
      }
    },
  );
}

