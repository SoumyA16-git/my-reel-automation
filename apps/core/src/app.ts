import fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { logger } from './logger.js';
import { type StorageManager } from './storage/StorageManager.js';
import { validateSession, COOKIE_NAME } from './auth/session.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerSystemRoutes } from './routes/system.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerReelRoutes } from './routes/reels.js';
import { registerMediaRoutes } from './routes/media.js';
import { registerSchedulerRoutes } from './routes/scheduler.js';
import { registerAutomationRoutes } from './routes/automation.js';
import { registerQueueRoutes } from './routes/queue.js';
import { registerDestinationRoutes } from './routes/destinations.js';
import { registerMetaAuthRoutes } from './routes/metaAuth.js';
import { registerEventRoutes } from './routes/events.js';

export interface BuildAppOptions {
  db: Database.Database;
  storage?: StorageManager;
  serveStatic?: boolean;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { db, serveStatic = true } = options;

  const app: FastifyInstance = fastify({
    loggerInstance: logger as any,
    disableRequestLogging: process.env['NODE_ENV'] === 'test',
    requestIdHeader: 'x-request-id',
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
  });

  await app.register(cors, {
    origin: true,
    credentials: true,
  });

  await app.register(cookie, {
    secret: process.env['SESSION_SECRET'] || 'development-session-secret-change-in-prod',
    parseOptions: {},
  });

  await app.register(multipart, {
    limits: {
      fileSize: 500 * 1024 * 1024, // 500 MB max
    },
  });

  // Global session validation hook
  app.addHook('onRequest', async (request) => {
    const token = request.cookies[COOKIE_NAME];
    if (token) {
      const session = validateSession(db, token);
      if (session) {
        request.session = session;
      }
    }
  });

  // Safe global error handler (SEC-011)
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const statusCode = error.statusCode ?? 500;
    const isClientError = statusCode < 500;

    logger.error(
      {
        err: error,
        requestId: request.id,
        url: request.url,
        method: request.method,
      },
      'Request error',
    );

    reply.status(statusCode).send({
      code: error.code ?? (isClientError ? 'CLIENT_ERROR' : 'INTERNAL_SERVER_ERROR'),
      message: isClientError ? error.message : 'An unexpected error occurred. Please contact administrator.',
      requestId: request.id,
    });
  });

  // Register all API routes
  registerAuthRoutes(app, db);
  registerSystemRoutes(app);
  registerSettingsRoutes(app);
  registerReelRoutes(app);
  registerMediaRoutes(app, db);
  registerSchedulerRoutes(app);
  registerAutomationRoutes(app);
  registerQueueRoutes(app);
  registerDestinationRoutes(app);
  registerMetaAuthRoutes(app);
  registerEventRoutes(app);

  // Static SPA Dashboard serving (production/development)
  const possiblePaths = [
    join(process.cwd(), 'apps', 'dashboard', 'dist'),
    join(process.cwd(), '..', 'dashboard', 'dist'),
  ];
  const dashboardDist = possiblePaths.find((p) => existsSync(p));

  if (serveStatic && dashboardDist) {
    await app.register(fastifyStatic, {
      root: dashboardDist,
      prefix: '/',
    });
  }

  // Not found handler for API and SPA client-side routing
  app.setNotFoundHandler((req, reply) => {
    if (req.raw.url && req.raw.url.startsWith('/api')) {
      return reply.status(404).send({
        code: 'NOT_FOUND',
        message: 'Endpoint not found',
        requestId: req.id,
      });
    }
    if (serveStatic && dashboardDist) {
      return reply.sendFile('index.html');
    }
    return reply.status(404).send({
      code: 'NOT_FOUND',
      message: 'Resource not found',
      requestId: req.id,
    });
  });

  return app;
}
