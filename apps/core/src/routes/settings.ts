import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getSettingsService } from '../settings/SettingsService.js';
import { getAuditService } from '../audit/AuditService.js';
import { csrfProtect } from '../auth/csrf.js';

export function registerSettingsRoutes(fastify: FastifyInstance): void {
  const settings = getSettingsService();
  const audit = getAuditService();

  // -------------------------------------------------------------------------
  // GET /api/v1/settings — list settings (non-secret values + fingerprints)
  // -------------------------------------------------------------------------
  fastify.get('/api/v1/settings', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.session) {
      return reply.status(401).send({
        code: 'UNAUTHORIZED',
        message: 'Authentication required',
        requestId: request.id,
      });
    }

    const items = settings.listAll();
    return reply.send({ settings: items });
  });

  // -------------------------------------------------------------------------
  // PATCH /api/v1/settings — update settings (authenticated + CSRF)
  // -------------------------------------------------------------------------
  fastify.patch(
    '/api/v1/settings',
    { preHandler: [csrfProtect] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.session) {
        return reply.status(401).send({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
          requestId: request.id,
        });
      }

      const body = request.body as Record<
        string,
        { value?: unknown; isSecret?: boolean; secretPlaintext?: string }
      >;

      if (!body || typeof body !== 'object') {
        return reply.status(400).send({
          code: 'INVALID_REQUEST',
          message: 'Request body must be an object of setting updates',
          requestId: request.id,
        });
      }

      const adminId = request.session.adminId;

      for (const [key, payload] of Object.entries(body)) {
        if (payload.isSecret && typeof payload.secretPlaintext === 'string') {
          // Encrypt and save secret
          settings.setSecret(key, payload.secretPlaintext, adminId);
          audit.log({
            actorId: adminId,
            action: 'settings.update_secret',
            targetType: 'setting',
            targetId: key,
            result: 'success',
          });
        } else if (payload.value !== undefined) {
          // Non-secret setting
          settings.set(key, payload.value as string | number | boolean | Record<string, unknown>, adminId);
          audit.log({
            actorId: adminId,
            action: 'settings.update',
            targetType: 'setting',
            targetId: key,
            after: { value: payload.value },
            result: 'success',
          });
        }
      }

      return reply.send({ success: true });
    },
  );
}

