import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { createHmac, randomBytes } from 'node:crypto';
import { getDatabase } from '../db/connection.js';
import { csrfProtect } from '../auth/csrf.js';
import { MetaClient } from '../publishers/meta/MetaClient.js';
import { encrypt, decrypt } from '../crypto/index.js';
import { AuditService } from '../audit/AuditService.js';
import { logger } from '../logger.js';

const ManualConnectSchema = z.object({
  kind: z.enum(['instagram', 'facebook']),
  targetId: z.string().min(1),
  accessToken: z.string().min(10),
  displayName: z.string().min(1).default('Meta Asset'),
  label: z.string().min(1).optional(),
});

export function registerMetaAuthRoutes(fastify: FastifyInstance, metaClientOverride?: MetaClient): void {
  const db = getDatabase();
  const audit = new AuditService(db);
  const metaClient = metaClientOverride ?? new MetaClient();

  // Helper for generating HMAC state
  function generateStateToken(adminId: number): string {
    const secret = process.env['SESSION_SECRET'] ?? 'reelhub-meta-oauth-secret';
    const nonce = randomBytes(16).toString('hex');
    const timestamp = Date.now();
    const data = `${adminId}:${nonce}:${timestamp}`;
    const hmac = createHmac('sha256', secret).update(data).digest('hex');
    return `${data}:${hmac}`;
  }

  function verifyStateToken(state: string, expectedAdminId: number): boolean {
    const parts = state.split(':');
    if (parts.length !== 4) return false;
    const [adminIdStr, nonce, timestampStr, signature] = parts;
    if (!adminIdStr || !nonce || !timestampStr || !signature) return false;
    const adminId = parseInt(adminIdStr, 10);
    const timestamp = parseInt(timestampStr, 10);

    if (adminId !== expectedAdminId) return false;
    if (Date.now() - timestamp > 15 * 60 * 1000) return false; // 15 min expiry

    const secret = process.env['SESSION_SECRET'] ?? 'reelhub-meta-oauth-secret';
    const expected = createHmac('sha256', secret).update(`${adminId}:${nonce}:${timestamp}`).digest('hex');
    return expected === signature;
  }

  // -------------------------------------------------------------------------
  // GET /api/v1/accounts/meta/connect â€” Generate OAuth redirect URL
  // -------------------------------------------------------------------------
  fastify.get('/api/v1/accounts/meta/connect', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.session) {
      return reply.status(401).send({
        code: 'UNAUTHORIZED',
        message: 'Authentication required',
        requestId: request.id,
      });
    }

    const clientId = process.env['META_APP_ID'];
    const redirectUri = process.env['META_REDIRECT_URI'];

    if (!clientId || !redirectUri) {
      return reply.status(400).send({
        code: 'CONFIG_MISSING',
        message: 'META_APP_ID and META_REDIRECT_URI must be configured in environment',
        requestId: request.id,
      });
    }

    const state = generateStateToken(request.session.adminId);
    const scopes = [
      'instagram_basic',
      'instagram_content_publish',
      'pages_show_list',
      'pages_read_engagement',
    ].join(',');

    const authUrl = `https://www.facebook.com/v25.0/dialog/oauth?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scopes)}&state=${encodeURIComponent(state)}&response_type=code`;

    return reply.send({
      ok: true,
      authUrl,
      state,
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/accounts/meta/callback â€” OAuth code exchange & discovery
  // -------------------------------------------------------------------------
  fastify.get('/api/v1/accounts/meta/callback', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.session) {
      return reply.status(401).send({
        code: 'UNAUTHORIZED',
        message: 'Authentication required',
        requestId: request.id,
      });
    }

    const query = request.query as { code?: string; state?: string; error?: string; error_description?: string };

    if (query.error) {
      return reply.status(400).send({
        code: 'OAUTH_ERROR',
        message: query.error_description || query.error,
        requestId: request.id,
      });
    }

    if (!query.code || !query.state) {
      return reply.status(400).send({
        code: 'MISSING_PARAMS',
        message: 'Authorization code and state are required',
        requestId: request.id,
      });
    }

    if (!verifyStateToken(query.state, request.session.adminId)) {
      return reply.status(400).send({
        code: 'INVALID_STATE',
        message: 'Invalid or expired OAuth state parameter',
        requestId: request.id,
      });
    }

    const clientId = process.env['META_APP_ID']!;
    const clientSecret = process.env['META_APP_SECRET']!;
    const redirectUri = process.env['META_REDIRECT_URI']!;

    try {
      // 1. Exchange code for short-lived user token
      const shortLived = await metaClient.exchangeOAuthCode(clientId, clientSecret, redirectUri, query.code);

      // 2. Exchange for long-lived user token (60 days)
      const longLived = await metaClient.exchangeForLongLivedUserToken(
        clientId,
        clientSecret,
        shortLived.accessToken,
      );

      // 3. Query pages and linked Instagram accounts
      const pages = await metaClient.getAccountsAndPages(longLived.accessToken);

      const now = Date.now();
      const connectedItems: Array<{ type: string; id: string; name: string }> = [];

      const txn = db.transaction(() => {
        for (const page of pages) {
          const pageTokenEnc = encrypt(page.accessToken);
          const userTokenEnc = encrypt(longLived.accessToken);
          const expiresAt = now + longLived.expiresIn * 1000;

          // Upsert connected account for this Page
          const existingAcc = db
            .prepare<[string, string], { id: number }>(`
              SELECT id FROM connected_accounts WHERE provider = ? AND external_id = ?
            `)
            .get('meta', page.id);

          let accountId: number;
          if (existingAcc) {
            accountId = existingAcc.id;
            db.prepare<[string, string | null, Buffer, Buffer, number, number, number, number]>(`
              UPDATE connected_accounts
              SET display_name = ?,
                  external_id_2 = ?,
                  token_enc = ?,
                  token_2_enc = ?,
                  token_expires_at = ?,
                  status = 'active',
                  last_verified_at = ?,
                  updated_at = ?
              WHERE id = ?
            `).run(
              page.name,
              page.instagramBusinessAccount?.id ?? null,
              pageTokenEnc,
              userTokenEnc,
              expiresAt,
              now,
              now,
              accountId,
            );
          } else {
            const info = db
              .prepare<[string, string, string | null, Buffer, Buffer, number, number, number, number]>(`
                INSERT INTO connected_accounts (
                  provider, display_name, external_id, external_id_2, auth_method,
                  token_enc, token_2_enc, token_expires_at, status, last_verified_at,
                  created_at, updated_at
                ) VALUES ('meta', ?, ?, ?, 'oauth', ?, ?, ?, 'active', ?, ?, ?)
              `)
              .run(
                page.name,
                page.id,
                page.instagramBusinessAccount?.id ?? null,
                pageTokenEnc,
                userTokenEnc,
                expiresAt,
                now,
                now,
                now,
              );
            accountId = Number(info.lastInsertRowid);
          }

          // Upsert Facebook destination
          const existingFbDest = db
            .prepare<[string, string], { id: number }>(`
              SELECT id FROM publishing_destinations WHERE kind = ? AND target_id = ?
            `)
            .get('facebook', page.id);

          if (existingFbDest) {
            db.prepare<[string, number, number]>(`
              UPDATE publishing_destinations
              SET label = ?, enabled = 1, paused = 0, updated_at = ?
              WHERE id = ?
            `).run(`FB: ${page.name}`, now, existingFbDest.id);
          } else {
            db.prepare<[number, string, string, number, number]>(`
              INSERT INTO publishing_destinations (
                kind, account_id, label, target_id, video_role,
                enabled, paused, created_at, updated_at
              ) VALUES ('facebook', ?, ?, ?, 'censored', 1, 0, ?, ?)
            `).run(accountId, `FB: ${page.name}`, page.id, now, now);
          }
          connectedItems.push({ type: 'facebook', id: page.id, name: page.name });

          // If linked Instagram business account exists, upsert Instagram destination
          if (page.instagramBusinessAccount) {
            const igId = page.instagramBusinessAccount.id;
            const igName = page.instagramBusinessAccount.username ?? `IG: ${page.name}`;

            const existingIgDest = db
              .prepare<[string, string], { id: number }>(`
                SELECT id FROM publishing_destinations WHERE kind = ? AND target_id = ?
              `)
              .get('instagram', igId);

            if (existingIgDest) {
              db.prepare<[string, number, number]>(`
                UPDATE publishing_destinations
                SET label = ?, enabled = 1, paused = 0, updated_at = ?
                WHERE id = ?
              `).run(`IG: ${igName}`, now, existingIgDest.id);
            } else {
              db.prepare<[number, string, string, number, number]>(`
                INSERT INTO publishing_destinations (
                  kind, account_id, label, target_id, video_role,
                  enabled, paused, created_at, updated_at
                ) VALUES ('instagram', ?, ?, ?, 'censored', 1, 0, ?, ?)
              `).run(accountId, `IG: ${igName}`, igId, now, now);
            }
            connectedItems.push({ type: 'instagram', id: igId, name: igName });
          }
        }
      });

      txn.immediate();

      audit.log({
        actorId: request.session.adminId,
        action: 'account.connect_meta_oauth',
        targetType: 'connected_accounts',
        targetId: 'multiple',
        result: 'success',
      });

      return reply.send({
        ok: true,
        connected: connectedItems,
      });
    } catch (err: any) {
      logger.error({ err }, 'Meta OAuth callback exchange failed');
      return reply.status(500).send({
        code: 'OAUTH_EXCHANGE_FAILED',
        message: err instanceof Error ? err.message : String(err),
        requestId: request.id,
      });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/v1/accounts/meta/manual-connect â€” Direct token connect (for tests / manual setup)
  // -------------------------------------------------------------------------
  fastify.post(
    '/api/v1/accounts/meta/manual-connect',
    { preHandler: [csrfProtect] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.session) {
        return reply.status(401).send({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
          requestId: request.id,
        });
      }

      const parseResult = ManualConnectSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          code: 'VALIDATION_ERROR',
          message: 'Invalid input data',
          details: parseResult.error.format(),
          requestId: request.id,
        });
      }

      const { kind, targetId, accessToken, displayName, label } = parseResult.data;

      // Validate token health
      try {
        await metaClient.checkTokenHealth(accessToken);
      } catch (err: any) {
        return reply.status(400).send({
          code: 'TOKEN_INVALID',
          message: `Meta token verification failed: ${err.message}`,
          requestId: request.id,
        });
      }

      const now = Date.now();
      const tokenEnc = encrypt(accessToken);
      const destLabel = label ?? `${kind === 'instagram' ? 'IG' : 'FB'}: ${displayName}`;

      const txn = db.transaction(() => {
        // Upsert connected account
        const existingAcc = db
          .prepare<[string, string], { id: number }>(`
            SELECT id FROM connected_accounts WHERE provider = ? AND external_id = ?
          `)
          .get('meta', targetId);

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
              ) VALUES ('meta', ?, ?, 'manual_token', ?, 'active', ?, ?, ?)
            `)
            .run(displayName, targetId, tokenEnc, now, now, now);
          accountId = Number(info.lastInsertRowid);
        }

        // Upsert destination
        const existingDest = db
          .prepare<[string, string], { id: number }>(`
            SELECT id FROM publishing_destinations WHERE kind = ? AND target_id = ?
          `)
          .get(kind, targetId);

        let destId: number;
        if (existingDest) {
          destId = existingDest.id;
          db.prepare<[string, number, number]>(`
            UPDATE publishing_destinations
            SET label = ?, enabled = 1, paused = 0, updated_at = ?
            WHERE id = ?
          `).run(destLabel, now, destId);
        } else {
          const info = db
            .prepare<[string, number, string, string, number, number]>(`
              INSERT INTO publishing_destinations (
                kind, account_id, label, target_id, video_role,
                enabled, paused, created_at, updated_at
              ) VALUES (?, ?, ?, ?, 'censored', 1, 0, ?, ?)
            `)
            .run(kind, accountId, destLabel, targetId, now, now);
          destId = Number(info.lastInsertRowid);
        }

        return { accountId, destinationId: destId };
      });

      const ids = txn.immediate();

      audit.log({
        actorId: request.session.adminId,
        action: 'account.manual_connect_meta',
        targetType: 'connected_accounts',
        targetId: String(ids.accountId),
        result: 'success',
      });

      return reply.send({
        ok: true,
        ...ids,
      });
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/v1/accounts/meta/:id/verify â€” Token health check
  // -------------------------------------------------------------------------
  fastify.post(
    '/api/v1/accounts/meta/:id/verify',
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
      const accountId = parseInt(id, 10);

      const account = db
        .prepare<[number], { id: number; token_enc: Buffer | null }>(`
          SELECT id, token_enc FROM connected_accounts WHERE id = ? AND provider = 'meta'
        `)
        .get(accountId);

      if (!account || !account.token_enc) {
        return reply.status(404).send({
          code: 'NOT_FOUND',
          message: 'Meta connected account not found or has no token',
          requestId: request.id,
        });
      }

      let token: string;
      try {
        token = decrypt(account.token_enc);
      } catch {
        return reply.status(500).send({
          code: 'DECRYPT_FAILED',
          message: 'Failed to decrypt token',
          requestId: request.id,
        });
      }

      try {
        const health = await metaClient.checkTokenHealth(token);
        const now = Date.now();

        db.prepare<[number, number, number]>(`
          UPDATE connected_accounts
          SET status = 'active', last_verified_at = ?, updated_at = ?
          WHERE id = ?
        `).run(now, now, account.id);

        return reply.send({
          ok: true,
          status: 'active',
          id: health.id,
          name: health.name,
        });
      } catch (err: any) {
        const now = Date.now();
        db.prepare<[string, number, number]>(`
          UPDATE connected_accounts
          SET status = 'needs_auth', last_error = ?, updated_at = ?
          WHERE id = ?
        `).run(err.message, now, account.id);

        return reply.status(400).send({
          ok: false,
          status: 'needs_auth',
          error: err.message,
        });
      }
    },
  );
}

