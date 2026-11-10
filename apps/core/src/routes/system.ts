import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { isDbWritable, isWalMode } from '../db/connection.js';
import { getStorageManager } from '../storage/StorageManager.js';
import { getBackupService } from '../backup/BackupService.js';
import { csrfProtect } from '../auth/csrf.js';

export function registerSystemRoutes(fastify: FastifyInstance): void {
  const storage = getStorageManager();

  // -------------------------------------------------------------------------
  // GET /api/v1/system/health — unauthenticated health check
  // -------------------------------------------------------------------------
  fastify.get('/api/v1/system/health', async (_request: FastifyRequest, reply: FastifyReply) => {
    const dbWritable = isDbWritable();
    const walMode = isWalMode();
    const rootExists = storage.rootExists();
    const freeBytes = await storage.getFreeBytes();

    const isHealthy = dbWritable && walMode && rootExists;

    return reply.status(isHealthy ? 200 : 503).send({
      status: isHealthy ? 'ok' : 'degraded',
      db: {
        writable: dbWritable,
        wal_mode: walMode,
      },
      scheduler: {
        last_heartbeat_at: null, // Initialized in M3
      },
      storage: {
        root_exists: rootExists,
        free_bytes: freeBytes,
      },
      version: '0.1.0',
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/system/storage — storage breakdown (authenticated)
  // -------------------------------------------------------------------------
  fastify.get('/api/v1/system/storage', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.session) {
      return reply.status(401).send({
        code: 'UNAUTHORIZED',
        message: 'Authentication required',
        requestId: request.id,
      });
    }

    const freeBytes = await storage.getFreeBytes();
    return reply.send({
      rootExists: storage.rootExists(),
      freeBytes,
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/v1/system/backups — manual backup trigger (authenticated + CSRF)
  // -------------------------------------------------------------------------
  fastify.post(
    '/api/v1/system/backups',
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
        const backupService = getBackupService();
        const result = await backupService.runBackup();
        return reply.status(201).send({
          success: true,
          backupPath: result.backupPath,
          sizeBytes: result.sizeBytes,
        });
      } catch (err) {
        return reply.status(500).send({
          code: 'BACKUP_FAILED',
          message: 'Failed to create backup',
          requestId: request.id,
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/v1/system/integrity — manual integrity check (authenticated + CSRF)
  // -------------------------------------------------------------------------
  fastify.post(
    '/api/v1/system/integrity',
    { preHandler: [csrfProtect] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.session) {
        return reply.status(401).send({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
          requestId: request.id,
        });
      }

      const body = (request.body ?? {}) as { mode?: 'quick' | 'full' };
      const mode = body.mode === 'full' ? 'full' : 'quick';

      const backupService = getBackupService();
      const result = backupService.runIntegrityCheck(mode);

      return reply.send({
        ok: result.ok,
        mode,
        errors: result.errors,
      });
    },
  );
}

