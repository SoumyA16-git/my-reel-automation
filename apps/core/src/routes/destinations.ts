import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { getDatabase } from '../db/connection.js';
import { csrfProtect } from '../auth/csrf.js';
import { TelegramClient } from '../publishers/telegram/TelegramClient.js';
import { TelegramReconciler } from '../publishers/telegram/TelegramReconciler.js';
import { RawFileDeletionService } from '../storage/RawFileDeletionService.js';
import { encrypt } from '../crypto/index.js';
import { AuditService } from '../audit/AuditService.js';

const ValidateTelegramSchema = z.object({
  botToken: z.string().min(10),
  chatId: z.string().min(1),
});

const ConnectTelegramSchema = z.object({
  botToken: z.string().min(10),
  chatId: z.string().min(1),
  displayName: z.string().min(1).default('Telegram Channel'),
  label: z.string().min(1).default('Telegram'),
});

const ResolveDeliverySchema = z.object({
  action: z.enum(['confirm_delivered', 'retry']),
  messageId: z.number().int().positive().optional(),
});

interface DestinationListRow {
  id: number;
  kind: string;
  account_id: number;
  label: string;
  target_id: string;
  video_role: string;
  config: string;
  enabled: number;
  paused: number;
  paused_reason: string | null;
  daily_cap: number | null;
  min_gap_seconds: number;
  created_at: number;
  updated_at: number;
}

export function registerDestinationRoutes(fastify: FastifyInstance): void {
  const db = getDatabase();
  const audit = new AuditService(db);
  const telegramClient = new TelegramClient();
  const reconciler = new TelegramReconciler(db, telegramClient);
  const deletionService = new RawFileDeletionService(db);

  // -------------------------------------------------------------------------
  // GET /api/v1/destinations — list configured publishing destinations
  // -------------------------------------------------------------------------
  fastify.get('/api/v1/destinations', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.session) {
      return reply.status(401).send({
        code: 'UNAUTHORIZED',
        message: 'Authentication required',
        requestId: request.id,
      });
    }

    const destinations = db
      .prepare<[], DestinationListRow>(`
        SELECT * FROM publishing_destinations ORDER BY id ASC
      `)
      .all();

    return reply.send({ destinations });
  });

  // -------------------------------------------------------------------------
  // POST /api/v1/destinations/:id/pause — toggle pause on destination
  // -------------------------------------------------------------------------
  fastify.post(
    '/api/v1/destinations/:id/pause',
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
      const destId = parseInt(id, 10);
      const body = request.body as { paused: boolean; reason?: string } | undefined;

      const isPaused = body?.paused === true ? 1 : 0;
      const reason = isPaused ? (body?.reason ?? 'Paused by admin') : null;
      const now = Date.now();

      db.prepare<[number, string | null, number, number]>(`
        UPDATE publishing_destinations
        SET paused = ?, paused_reason = ?, updated_at = ?
        WHERE id = ?
      `).run(isPaused, reason, now, destId);

      audit.log({
        actorId: request.session.adminId,
        action: isPaused ? 'destination.pause' : 'destination.resume',
        targetType: 'publishing_destinations',
        targetId: String(destId),
        result: 'success',
      });

      return reply.send({ ok: true, destinationId: destId, paused: Boolean(isPaused) });
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/v1/accounts/telegram/validate — check token, channel, admin rights
  // -------------------------------------------------------------------------
  fastify.post(
    '/api/v1/accounts/telegram/validate',
    { preHandler: [csrfProtect] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.session) {
        return reply.status(401).send({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
          requestId: request.id,
        });
      }

      const parseResult = ValidateTelegramSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          code: 'VALIDATION_ERROR',
          message: 'botToken and chatId are required',
          details: parseResult.error.format(),
          requestId: request.id,
        });
      }

      const result = await telegramClient.validateCredentials(
        parseResult.data.botToken,
        parseResult.data.chatId,
      );

      return reply.send(result);
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/v1/accounts/telegram/connect — save Telegram account & destination
  // -------------------------------------------------------------------------
  fastify.post(
    '/api/v1/accounts/telegram/connect',
    { preHandler: [csrfProtect] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.session) {
        return reply.status(401).send({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
          requestId: request.id,
        });
      }

      const parseResult = ConnectTelegramSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          code: 'VALIDATION_ERROR',
          message: 'Invalid input',
          details: parseResult.error.format(),
          requestId: request.id,
        });
      }

      const { botToken, chatId, displayName, label } = parseResult.data;

      // Validate first
      const val = await telegramClient.validateCredentials(botToken, chatId);
      if (!val.ok) {
        return reply.status(400).send({
          code: 'TELEGRAM_VALIDATION_FAILED',
          message: val.error ?? 'Validation failed',
          failedStep: val.failedStep,
          requestId: request.id,
        });
      }

      const now = Date.now();
      const tokenEnc = encrypt(botToken);

      // Save connected account and destination in transaction
      const txn = db.transaction(() => {
        // Upsert connected account
        const existingAcc = db
          .prepare<[string, string], { id: number }>(`
            SELECT id FROM connected_accounts WHERE provider = ? AND external_id = ?
          `)
          .get('telegram', String(val.botId ?? 'default'));

        let accountId: number;
        if (existingAcc) {
          accountId = existingAcc.id;
          db.prepare<[string, Buffer, number, number, number]>(`
            UPDATE connected_accounts
            SET display_name = ?, token_enc = ?, status = 'active', last_verified_at = ?, updated_at = ?
            WHERE id = ?
          `).run(displayName, tokenEnc, now, now, accountId);
        } else {
          const info = db
            .prepare<[string, string, Buffer, number, number, number]>(`
              INSERT INTO connected_accounts (
                provider, display_name, external_id, auth_method, token_enc,
                status, last_verified_at, created_at, updated_at
              ) VALUES ('telegram', ?, ?, 'bot_token', ?, 'active', ?, ?, ?)
            `)
            .run(displayName, String(val.botId ?? 'default'), tokenEnc, now, now, now);
          accountId = Number(info.lastInsertRowid);
        }

        // Upsert destination
        const existingDest = db
          .prepare<[string, string], { id: number }>(`
            SELECT id FROM publishing_destinations WHERE kind = ? AND target_id = ?
          `)
          .get('telegram', String(val.chatId ?? chatId));

        let destId: number;
        if (existingDest) {
          destId = existingDest.id;
          db.prepare<[string, number, number]>(`
            UPDATE publishing_destinations
            SET label = ?, enabled = 1, paused = 0, updated_at = ?
            WHERE id = ?
          `).run(label, now, destId);
        } else {
          const info = db
            .prepare<[number, string, string, number, number]>(`
              INSERT INTO publishing_destinations (
                kind, account_id, label, target_id, video_role,
                enabled, paused, created_at, updated_at
              ) VALUES ('telegram', ?, ?, ?, 'raw', 1, 0, ?, ?)
            `)
            .run(accountId, label, String(val.chatId ?? chatId), now, now);
          destId = Number(info.lastInsertRowid);
        }

        return { accountId, destinationId: destId };
      });

      const ids = txn.immediate();

      audit.log({
        actorId: request.session.adminId,
        action: 'account.connect_telegram',
        targetType: 'connected_accounts',
        targetId: String(ids.accountId),
        result: 'success',
      });

      return reply.send({ ok: true, ...ids });
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/v1/reels/:id/destinations/:d/resolve — admin decision for uncertain delivery
  // -------------------------------------------------------------------------
  fastify.post(
    '/api/v1/reels/:id/destinations/:d/resolve',
    { preHandler: [csrfProtect] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.session) {
        return reply.status(401).send({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
          requestId: request.id,
        });
      }

      const { id, d } = request.params as { id: string; d: string };
      const reelId = parseInt(id, 10);
      const destinationId = parseInt(d, 10);

      const parseResult = ResolveDeliverySchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          code: 'VALIDATION_ERROR',
          message: 'Invalid resolve action',
          details: parseResult.error.format(),
          requestId: request.id,
        });
      }

      const record = db
        .prepare<[number, number], { id: number }>(`
          SELECT id FROM publishing_records WHERE reel_id = ? AND destination_id = ?
        `)
        .get(reelId, destinationId);

      if (!record) {
        return reply.status(404).send({
          code: 'NOT_FOUND',
          message: 'Publishing record not found',
          requestId: request.id,
        });
      }

      try {
        reconciler.resolveDelivery(
          record.id,
          request.session.adminId,
          parseResult.data.action,
          parseResult.data.messageId,
        );

        audit.log({
          actorId: request.session.adminId,
          action: 'destination.resolve_uncertain',
          targetType: 'publishing_records',
          targetId: String(record.id),
          result: 'success',
        });

        return reply.send({ ok: true, action: parseResult.data.action });
      } catch (err) {
        return reply.status(400).send({
          code: 'RESOLVE_FAILED',
          message: err instanceof Error ? err.message : String(err),
          requestId: request.id,
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/v1/files/:id/retry-cleanup — manual retry for failed deletion
  // -------------------------------------------------------------------------
  fastify.post(
    '/api/v1/files/:id/retry-cleanup',
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
      const fileId = parseInt(id, 10);

      const result = deletionService.deleteRawFile(fileId);
      if (!result.ok) {
        return reply.status(400).send({
          code: 'CLEANUP_FAILED',
          message: result.error ?? 'Cleanup failed',
          outcome: result.outcome,
          reason: result.reason,
          requestId: request.id,
        });
      }

      return reply.send({ ok: true, outcome: result.outcome });
    },
  );
}
