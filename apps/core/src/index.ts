import { join } from 'node:path';
import { logger } from './logger.js';
import { initStorageManager } from './storage/StorageManager.js';
import { openDatabase, closeDatabase } from './db/connection.js';
import { runMigrations } from './db/migrate.js';
import { initSettingsService } from './settings/SettingsService.js';
import { initAuditService } from './audit/AuditService.js';
import { initNotificationService } from './notifications/NotificationService.js';
import { initBackupService, getBackupService } from './backup/BackupService.js';
import { initGeminiService } from './ai/gemini.js';
import { initReelService } from './reels/ReelService.js';
import { hasAdminUsers, getOrCreateBootstrapToken } from './auth/bootstrap.js';
import { getScheduler } from './routes/scheduler.js';
import { RecoveryService } from './queue/RecoveryService.js';
import { buildApp } from './app.js';

async function bootstrap() {
  logger.info('Starting ReelHub Core service...');

  // 1. Storage setup
  const storageRoot = process.env['STORAGE_ROOT'] || (process.platform === 'win32' ? './data' : '/data');
  const storage = initStorageManager(storageRoot);
  storage.ensureDirectories();

  // 2. Database connection & migrations
  const dbDir = storage.getRoleDirectory('db');
  const dbPath = join(dbDir, 'reelhub.sqlite');
  const db = openDatabase(dbPath);
  runMigrations(db);

  // 3. Core services
  const settings = initSettingsService(db);
  settings.seedDefaults();

  const audit = initAuditService(db);
  const notifications = initNotificationService(db);
  const backups = initBackupService(db, storage, notifications, settings);
  initGeminiService(db);
  initReelService(db, storage);

  // 4. Startup crash recovery sweep (PRD 19.6 / NFR-001)
  const recovery = new RecoveryService(db, storage);
  const recoverySummary = recovery.performStartupRecovery();
  if (!recoverySummary.ok) {
    logger.warn({ error: recoverySummary.error }, 'Startup recovery encountered issues; safe mode active');
  }

  // 5. Bootstrap token check
  if (!hasAdminUsers(db)) {
    getOrCreateBootstrapToken();
  }

  // 6. Fastify server setup
  const app = await buildApp({ db, storage, serveStatic: true });

  // 7. Scheduler tick loop (15s tick)
  const scheduler = getScheduler();
  scheduler.start(15_000);

  // 8. Background timers (M1 simple intervals; promoted to SQLite queue in M3)
  const BACKUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
  const backupTimer = setInterval(async () => {
    try {
      logger.info('Scheduled 6-hour backup started');
      await getBackupService().runBackup();
    } catch (err) {
      logger.error({ err }, 'Scheduled backup failed');
    }
  }, BACKUP_INTERVAL_MS);
  backupTimer.unref();

  const INTEGRITY_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
  const integrityTimer = setInterval(() => {
    try {
      getBackupService().runIntegrityCheck('quick');
    } catch (err) {
      logger.error({ err }, 'Daily integrity check error');
    }
  }, INTEGRITY_INTERVAL_MS);
  integrityTimer.unref();

  // 8. Start server
  const port = parseInt(process.env['APP_PORT'] ?? '3000', 10);
  const host = process.env['HOST'] ?? '0.0.0.0';

  await app.listen({ port, host });
  logger.info({ port, host }, `ReelHub Core listening on http://${host}:${port}`);

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received; closing ReelHub Core...');
    scheduler.stop();
    clearInterval(backupTimer);
    clearInterval(integrityTimer);
    try {
      await app.close();
      closeDatabase();
      logger.info('ReelHub Core stopped gracefully.');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

bootstrap().catch((err) => {
  logger.fatal({ err }, 'Fatal error during startup');
  process.exit(1);
});

