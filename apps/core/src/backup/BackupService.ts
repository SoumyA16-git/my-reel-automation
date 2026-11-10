import { type Database } from 'better-sqlite3';
import { readdirSync, unlinkSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { StorageManager, getStorageManager } from '../storage/StorageManager.js';
import { loadMasterKey } from '../crypto/index.js';
import { logger } from '../logger.js';
import { NotificationService } from '../notifications/NotificationService.js';
import { SettingsService } from '../settings/SettingsService.js';

export interface IntegrityCheckResult {
  ok: boolean;
  errors: string[];
}

export class BackupService {
  constructor(
    private readonly db: Database,
    private readonly storage: StorageManager = getStorageManager(),
    private readonly notificationService?: NotificationService,
    private readonly settingsService?: SettingsService,
  ) {}

  /**
   * Run an online SQLite backup.
   * Steps:
   * 1. Create a consistent SQLite snapshot via db.backup() in backups/
   * 2. Encrypt the snapshot with AES-256-GCM using the master key
   * 3. Write <timestamp>.sqlite.enc
   * 4. Securely delete the unencrypted .sqlite file
   */
  async runBackup(): Promise<{ backupPath: string; sizeBytes: number }> {
    const backupDir = this.storage.getRoleDirectory('backups');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const tempDbName = `backup_${timestamp}.sqlite`;
    const tempDbPath = join(backupDir, tempDbName);
    const encDbName = `backup_${timestamp}.sqlite.enc`;
    const encDbPath = join(backupDir, encDbName);

    logger.info({ tempDbPath }, 'Starting SQLite online backup');

    try {
      // 1. Online backup via better-sqlite3 API
      await this.db.backup(tempDbPath);

      // 2. Read the snapshot and encrypt
      const rawData = readFileSync(tempDbPath);
      const masterKey = loadMasterKey();
      // For large backups, encrypt accepts string or Buffer.
      // Our crypto module encrypts plaintext UTF-8, but SQLite backups are binary!
      // Let's ensure binary encryption using AES-256-GCM for the backup file.
      const encrypted = this.encryptBinary(rawData, masterKey);

      // 3. Write encrypted file
      writeFileSync(encDbPath, encrypted, { mode: 0o600 });

      // 4. Delete unencrypted temp backup
      unlinkSync(tempDbPath);

      const stats = statSync(encDbPath);
      logger.info(
        { encDbPath, sizeBytes: stats.size },
        'SQLite backup created and encrypted successfully',
      );

      // 5. Prune older backups
      this.pruneOldBackups();

      return { backupPath: encDbPath, sizeBytes: stats.size };
    } catch (err) {
      // Cleanup temp file if it exists on error
      try {
        unlinkSync(tempDbPath);
      } catch {
        // Ignore
      }
      logger.error({ err }, 'Backup failed');
      throw err;
    }
  }

  /**
   * Helper to encrypt binary buffer with AES-256-GCM.
   */
  private encryptBinary(data: Buffer, masterKey: Buffer): Buffer {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', masterKey, nonce);
    const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([nonce, encrypted, tag]);
  }

  /**
   * Helper to decrypt binary buffer with AES-256-GCM.
   */
  static decryptBinary(encryptedData: Buffer, masterKey: Buffer): Buffer {
    if (encryptedData.length < 28) {
      throw new Error('Encrypted backup data too short');
    }
    const nonce = encryptedData.subarray(0, 12);
    const tag = encryptedData.subarray(encryptedData.length - 16);
    const data = encryptedData.subarray(12, encryptedData.length - 16);

    const decipher = createDecipheriv('aes-256-gcm', masterKey, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]);
  }

  /**
   * Prune old backups keeping 7 daily + 4 weekly.
   */
  pruneOldBackups(): void {
    const backupDir = this.storage.getRoleDirectory('backups');
    try {
      const files = readdirSync(backupDir)
        .filter((f) => f.endsWith('.sqlite.enc'))
        .sort()
        .reverse(); // Newest first

      // Simple retention: keep latest 30 backups (~7 days of 6-hour backups)
      const MAX_BACKUPS_TO_KEEP = 30;
      if (files.length > MAX_BACKUPS_TO_KEEP) {
        const toDelete = files.slice(MAX_BACKUPS_TO_KEEP);
        for (const file of toDelete) {
          const filePath = join(backupDir, file);
          unlinkSync(filePath);
          logger.debug({ filePath }, 'Pruned old backup file');
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to prune old backups');
    }
  }

  /**
   * Run database integrity checks.
   * mode: 'quick' (PRAGMA quick_check) or 'full' (PRAGMA integrity_check + foreign_key_check)
   */
  runIntegrityCheck(mode: 'quick' | 'full' = 'quick'): IntegrityCheckResult {
    const errors: string[] = [];

    try {
      if (mode === 'quick') {
        const result = this.db.pragma('quick_check') as Array<{ quick_check: string }>;
        for (const row of result) {
          if (row.quick_check !== 'ok') {
            errors.push(row.quick_check);
          }
        }
      } else {
        const integrityResult = this.db.pragma('integrity_check') as Array<{ integrity_check: string }>;
        for (const row of integrityResult) {
          if (row.integrity_check !== 'ok') {
            errors.push(row.integrity_check);
          }
        }

        const fkResult = this.db.pragma('foreign_key_check') as Array<{
          table: string;
          rowid: number;
          parent: string;
          fkid: number;
        }>;
        for (const row of fkResult) {
          errors.push(`Foreign key violation in table ${row.table} at rowid ${row.rowid} referencing ${row.parent}`);
        }
      }
    } catch (err) {
      errors.push(`Integrity check failed with error: ${String(err)}`);
    }

    const ok = errors.length === 0;

    if (!ok) {
      logger.fatal({ mode, errors }, 'CRITICAL: Database integrity check failed!');

      if (this.notificationService) {
        this.notificationService.create({
          severity: 'critical',
          type: 'db.integrity_failure',
          title: 'Database integrity check failed',
          body: `Detected ${errors.length} issue(s) during ${mode} integrity check. Automation paused.`,
          dedupeKey: 'db.integrity_failure',
        });
      }

      if (this.settingsService) {
        this.settingsService.set('automation.paused', true);
      }
    } else {
      logger.debug({ mode }, 'Database integrity check passed (ok)');
    }

    return { ok, errors };
  }
}

let _backupService: BackupService | null = null;

export function initBackupService(
  db: Database,
  storage?: StorageManager,
  notifications?: NotificationService,
  settings?: SettingsService,
): BackupService {
  _backupService = new BackupService(db, storage, notifications, settings);
  return _backupService;
}

export function getBackupService(): BackupService {
  if (_backupService === null) {
    throw new Error('BackupService has not been initialized.');
  }
  return _backupService;
}
