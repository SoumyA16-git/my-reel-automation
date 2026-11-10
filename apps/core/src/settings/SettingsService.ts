import { type Database } from 'better-sqlite3';
import { DEFAULT_SETTINGS, type SettingValue } from '@reelhub/shared';
import { encrypt, decrypt, fingerprint } from '../crypto/index.js';
import { logger } from '../logger.js';

interface SettingRow {
  key: string;
  value: string | null;
  value_enc: Buffer | null;
  is_secret: number;
  updated_at: number;
}

export class SettingsService {
  constructor(private readonly db: Database) {}

  // -------------------------------------------------------------------------
  // Non-secret settings
  // -------------------------------------------------------------------------

  /**
   * Get a non-secret setting value.
   * Returns the value parsed from JSON, or the default if not set.
   */
  get(key: string): SettingValue | undefined {
    const row = this.db
      .prepare<[string]>('SELECT value, is_secret FROM application_settings WHERE key = ?')
      .get(key) as Pick<SettingRow, 'value' | 'is_secret'> | undefined;

    if (!row) {
      // Return default if exists
      return (DEFAULT_SETTINGS as Record<string, SettingValue>)[key];
    }

    if (row.is_secret) {
      logger.warn({ key }, 'Attempted to read secret setting with get(); use getSecret()');
      return undefined;
    }

    if (row.value === null) return undefined;
    try {
      return JSON.parse(row.value) as SettingValue;
    } catch {
      return row.value as SettingValue;
    }
  }

  /**
   * Set a non-secret setting value.
   */
  set(key: string, value: SettingValue, updatedBy?: number): void {
    const now = Date.now();
    const jsonValue = JSON.stringify(value);

    this.db
      .prepare<[string, string, number | null, number]>(
        `INSERT INTO application_settings (key, value, is_secret, updated_by, updated_at)
         VALUES (?, ?, 0, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           value_enc = NULL,
           is_secret = 0,
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`,
      )
      .run(key, jsonValue, updatedBy ?? null, now);
  }

  // -------------------------------------------------------------------------
  // Secret settings (encrypted)
  // -------------------------------------------------------------------------

  /**
   * Get and decrypt a secret setting.
   * Returns the plaintext string, or null if not set.
   */
  getSecret(key: string): string | null {
    const row = this.db
      .prepare<[string]>('SELECT value_enc, is_secret FROM application_settings WHERE key = ?')
      .get(key) as Pick<SettingRow, 'value_enc' | 'is_secret'> | undefined;

    if (!row || !row.value_enc) return null;

    if (!row.is_secret) {
      logger.warn({ key }, 'Attempted to read non-secret setting with getSecret()');
      return null;
    }

    try {
      return decrypt(row.value_enc);
    } catch (err) {
      logger.error({ err, key }, 'Failed to decrypt secret setting');
      return null;
    }
  }

  /**
   * Encrypt and store a secret setting.
   * @param plaintext The plaintext secret to store (never logged).
   */
  setSecret(key: string, plaintext: string, updatedBy?: number): void {
    const now = Date.now();
    const encryptedBlob = encrypt(plaintext);

    this.db
      .prepare<[string, Buffer, number | null, number]>(
        `INSERT INTO application_settings (key, value_enc, is_secret, updated_by, updated_at)
         VALUES (?, ?, 1, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = NULL,
           value_enc = excluded.value_enc,
           is_secret = 1,
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`,
      )
      .run(key, encryptedBlob, updatedBy ?? null, now);
  }

  /**
   * Get a fingerprint (last 4 hex chars of SHA-256) for a secret setting.
   * Safe to return in API responses — does not reveal the secret.
   */
  getFingerprint(key: string): string | null {
    const plaintext = this.getSecret(key);
    if (plaintext === null) return null;
    return fingerprint(plaintext);
  }

  // -------------------------------------------------------------------------
  // Seed defaults
  // -------------------------------------------------------------------------

  /**
   * Seed all default non-secret settings on first run.
   * Uses INSERT OR IGNORE so existing values are never overwritten.
   */
  seedDefaults(): void {
    const now = Date.now();

    const insertStmt = this.db.prepare<[string, string, number]>(
      `INSERT OR IGNORE INTO application_settings (key, value, is_secret, updated_at)
       VALUES (?, ?, 0, ?)`,
    );

    const seedAll = this.db.transaction(() => {
      for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        insertStmt.run(key, JSON.stringify(value), now);
      }
    });

    seedAll();
    logger.debug('Default settings seeded');
  }

  // -------------------------------------------------------------------------
  // List all (non-secret values only, fingerprints for secrets)
  // -------------------------------------------------------------------------

  listAll(): Array<{
    key: string;
    value: SettingValue | undefined;
    isSecret: boolean;
    fingerprint: string | null;
    updatedAt: number;
  }> {
    const rows = this.db
      .prepare<[]>('SELECT key, value, value_enc, is_secret, updated_at FROM application_settings')
      .all() as SettingRow[];

    return rows.map((row) => {
      if (row.is_secret) {
        let fp: string | null = null;
        if (row.value_enc) {
          try {
            const plaintext = decrypt(row.value_enc);
            fp = fingerprint(plaintext);
          } catch {
            fp = null;
          }
        }
        return {
          key: row.key,
          value: undefined,
          isSecret: true,
          fingerprint: fp,
          updatedAt: row.updated_at,
        };
      }

      let parsed: SettingValue | undefined;
      try {
        parsed = row.value !== null ? (JSON.parse(row.value) as SettingValue) : undefined;
      } catch {
        parsed = row.value as SettingValue;
      }

      return {
        key: row.key,
        value: parsed,
        isSecret: false,
        fingerprint: null,
        updatedAt: row.updated_at,
      };
    });
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _settingsService: SettingsService | null = null;

export function initSettingsService(db: Database): SettingsService {
  _settingsService = new SettingsService(db);
  return _settingsService;
}

export function getSettingsService(): SettingsService {
  if (_settingsService === null) {
    throw new Error('SettingsService has not been initialized.');
  }
  return _settingsService;
}

