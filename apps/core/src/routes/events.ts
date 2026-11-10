import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getEventBus, type ReelHubEvent } from '../events/EventBus.js';
import { logger } from '../logger.js';

export function registerEventRoutes(fastify: FastifyInstance): void {
  const eventBus = getEventBus();

  // -------------------------------------------------------------------------
  // GET /api/v1/events â€” Server-Sent Events real-time stream
  // -------------------------------------------------------------------------
  fastify.get('/api/v1/events', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.session) {
      return reply.status(401).send({
        code: 'UNAUTHORIZED',
        message: 'Authentication required for real-time events stream',
        requestId: request.id,
      });
    }

    // Hijack Fastify reply to write raw SSE chunks
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('X-Accel-Buffering', 'no');
    reply.raw.flushHeaders();

    logger.debug({ adminId: request.session.adminId }, 'SSE client connected');

    // 1. Initial connect message
    const initialPayload = JSON.stringify({
      timestamp: Date.now(),
      adminId: request.session.adminId,
    });
    reply.raw.write(`event: connected\ndata: ${initialPayload}\n\n`);

    // 2. Event listener
    const onEvent = (hubEvent: ReelHubEvent) => {
      try {
        const dataStr = JSON.stringify(hubEvent.data);
        reply.raw.write(`event: ${hubEvent.event}\ndata: ${dataStr}\n\n`);
      } catch (err) {
        logger.error({ err }, 'Error writing SSE event to client');
      }
    };

    eventBus.on('event', onEvent);

    // 3. Keepalive ping every 15 seconds
    const pingTimer = setInterval(() => {
      try {
        reply.raw.write(`event: ping\ndata: {"timestamp":${Date.now()}}\n\n`);
      } catch {
        clearInterval(pingTimer);
      }
    }, 15_000);
    pingTimer.unref();

    // 4. Cleanup on disconnect
    request.raw.on('close', () => {
      clearInterval(pingTimer);
      eventBus.off('event', onEvent);
      logger.debug({ adminId: request.session?.adminId }, 'SSE client disconnected');
    });
  });
}

