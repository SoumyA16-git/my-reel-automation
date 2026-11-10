import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { type Database } from 'better-sqlite3';
import { BootstrapRequestSchema, LoginRequestSchema } from '@reelhub/shared';
import {
  hasAdminUsers,
  verifyBootstrapToken,
  bootstrapAdmin,
} from '../auth/bootstrap.js';
import {
  createSession,
  validateSession,
  revokeSession,
  COOKIE_NAME,
  COOKIE_OPTIONS,
  type ValidatedSession,
} from '../auth/session.js';
import { verifyPassword } from '../auth/password.js';
import {
  isIpRateLimited,
  recordIpFailure,
  resetIpFailures,
  isAccountLocked,
  recordAccountFailure,
  resetAccountFailures,
  getLockoutRemainingMs,
} from '../auth/rateLimit.js';
import { generateCsrfToken } from '../auth/csrf.js';
import { getAuditService } from '../audit/AuditService.js';
import { logger } from '../logger.js';

declare module 'fastify' {
  interface FastifyRequest {
    session?: ValidatedSession;
  }
}

export function registerAuthRoutes(fastify: FastifyInstance, db: Database): void {
  const audit = getAuditService();

  // -------------------------------------------------------------------------
  // POST /api/v1/auth/bootstrap
  // -------------------------------------------------------------------------
  fastify.post('/api/v1/auth/bootstrap', async (request: FastifyRequest, reply: FastifyReply) => {
    if (hasAdminUsers(db)) {
      return reply.status(400).send({
        code: 'BOOTSTRAP_ALREADY_COMPLETED',
        message: 'Admin account has already been initialized',
        requestId: request.id,
      });
    }

    const parseResult = BootstrapRequestSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        code: 'VALIDATION_ERROR',
        message: 'Invalid request body',
        details: parseResult.error.format(),
        requestId: request.id,
      });
    }

    const { setupToken, username, password } = parseResult.data;

    if (!verifyBootstrapToken(setupToken)) {
      audit.log({
        action: 'auth.bootstrap',
        ip: request.ip,
        result: 'denied',
      });
      return reply.status(401).send({
        code: 'INVALID_SETUP_TOKEN',
        message: 'Invalid setup token provided',
        requestId: request.id,
      });
    }

    try {
      const adminId = await bootstrapAdmin(db, username, password);
      const sessionResult = createSession(db, {
        adminId,
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });

      audit.log({
        actorId: adminId,
        action: 'auth.bootstrap',
        ip: request.ip,
        result: 'success',
      });

      reply.setCookie(COOKIE_NAME, sessionResult.token, {
        ...COOKIE_OPTIONS,
        expires: new Date(sessionResult.expiresAt),
      });

      const csrfToken = generateCsrfToken(sessionResult.csrfSecret);

      return reply.status(201).send({
        success: true,
        csrfToken,
        session: {
          adminId,
          username,
          expiresAt: sessionResult.expiresAt,
        },
      });
    } catch (err) {
      logger.error({ err }, 'Bootstrap failed');
      return reply.status(500).send({
        code: 'INTERNAL_ERROR',
        message: 'Failed to complete bootstrap',
        requestId: request.id,
      });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/v1/auth/login
  // -------------------------------------------------------------------------
  fastify.post('/api/v1/auth/login', async (request: FastifyRequest, reply: FastifyReply) => {
    const ip = request.ip;

    if (isIpRateLimited(ip)) {
      audit.log({
        action: 'auth.login',
        ip,
        result: 'denied',
      });
      return reply.status(429).send({
        code: 'RATE_LIMITED',
        message: 'Too many failed login attempts from this IP. Please try again later.',
        requestId: request.id,
      });
    }

    const parseResult = LoginRequestSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        code: 'VALIDATION_ERROR',
        message: 'Invalid request body',
        details: parseResult.error.format(),
        requestId: request.id,
      });
    }

    const { username, password } = parseResult.data;

    if (isAccountLocked(db, username)) {
      const remainingMs = getLockoutRemainingMs(db, username);
      const remainingMinutes = Math.ceil(remainingMs / 60000);
      audit.log({
        action: 'auth.login',
        ip,
        targetType: 'account',
        targetId: username,
        result: 'denied',
      });
      return reply.status(429).send({
        code: 'ACCOUNT_LOCKED',
        message: `Account is temporarily locked. Try again in ${remainingMinutes} minute(s).`,
        requestId: request.id,
      });
    }

    const user = db
      .prepare<[string]>('SELECT id, username, password_hash FROM admin_users WHERE username = ? COLLATE NOCASE')
      .get(username) as { id: number; username: string; password_hash: string } | undefined;

    if (!user) {
      recordIpFailure(ip);
      audit.log({
        action: 'auth.login',
        ip,
        targetType: 'account',
        targetId: username,
        result: 'denied',
      });
      return reply.status(401).send({
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid username or password',
        requestId: request.id,
      });
    }

    const isMatch = await verifyPassword(user.password_hash, password);
    if (!isMatch) {
      recordIpFailure(ip);
      recordAccountFailure(db, username);
      audit.log({
        actorId: user.id,
        action: 'auth.login',
        ip,
        targetType: 'account',
        targetId: username,
        result: 'denied',
      });
      return reply.status(401).send({
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid username or password',
        requestId: request.id,
      });
    }

    // Success
    resetIpFailures(ip);
    resetAccountFailures(db, user.id);

    const sessionResult = createSession(db, {
      adminId: user.id,
      ip,
      userAgent: request.headers['user-agent'] ?? null,
    });

    reply.setCookie(COOKIE_NAME, sessionResult.token, {
      ...COOKIE_OPTIONS,
      expires: new Date(sessionResult.expiresAt),
    });

    const csrfToken = generateCsrfToken(sessionResult.csrfSecret);

    audit.log({
      actorId: user.id,
      action: 'auth.login',
      ip,
      result: 'success',
    });

    return reply.send({
      success: true,
      csrfToken,
      session: {
        adminId: user.id,
        username: user.username,
        expiresAt: sessionResult.expiresAt,
      },
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/v1/auth/logout
  // -------------------------------------------------------------------------
  fastify.post('/api/v1/auth/logout', async (request: FastifyRequest, reply: FastifyReply) => {
    const token = request.cookies[COOKIE_NAME];
    if (token) {
      revokeSession(db, token);
    }

    reply.clearCookie(COOKIE_NAME, {
      ...COOKIE_OPTIONS,
    });

    if (request.session) {
      audit.log({
        actorId: request.session.adminId,
        action: 'auth.logout',
        ip: request.ip,
        result: 'success',
      });
    }

    return reply.send({ success: true });
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/auth/session
  // -------------------------------------------------------------------------
  fastify.get('/api/v1/auth/session', async (request: FastifyRequest, reply: FastifyReply) => {
    const token = request.cookies[COOKIE_NAME];
    if (!token) {
      return reply.status(401).send({
        code: 'UNAUTHORIZED',
        message: 'No active session',
        requestId: request.id,
      });
    }

    const session = validateSession(db, token);
    if (!session) {
      reply.clearCookie(COOKIE_NAME, COOKIE_OPTIONS);
      return reply.status(401).send({
        code: 'SESSION_EXPIRED',
        message: 'Session expired or invalidated',
        requestId: request.id,
      });
    }

    const csrfToken = generateCsrfToken(session.csrfSecret);

    return reply.send({
      session: {
        adminId: session.adminId,
        username: session.username,
        expiresAt: session.expiresAt,
        lastSeenAt: session.lastSeenAt,
      },
      csrfToken,
    });
  });
}

