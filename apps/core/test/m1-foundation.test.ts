import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { rmSync, mkdirSync, existsSync } from 'node:fs';
import { openDatabase, closeDatabase } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrate.js';
import { hashPassword, verifyPassword } from '../src/auth/password.js';
import {
  createSession,
  validateSession,
  revokeSession,
} from '../src/auth/session.js';
import { generateCsrfToken, validateCsrfToken } from '../src/auth/csrf.js';
import {
  recordAccountFailure,
  isAccountLocked,
  resetAccountFailures,
} from '../src/auth/rateLimit.js';
import {
  encrypt,
  decrypt,
  fingerprint,
  loadMasterKey,
} from '../src/crypto/index.js';
import { StorageManager } from '../src/storage/StorageManager.js';
import { SettingsService } from '../src/settings/SettingsService.js';
import { AuditService } from '../src/audit/AuditService.js';
import { NotificationService } from '../src/notifications/NotificationService.js';
import { BackupService } from '../src/backup/BackupService.js';

const TEST_DIR = join(process.cwd(), 'temp_test_m1');
const TEST_STORAGE = join(TEST_DIR, 'storage');
const TEST_DB_PATH = join(TEST_STORAGE, 'db', 'test_reelhub.sqlite');

describe('M1 Foundation Integration Tests', () => {
  let db: ReturnType<typeof openDatabase>;
  let storage: StorageManager;
  let settings: SettingsService;
  let audit: AuditService;
  let notifications: NotificationService;
  let backups: BackupService;

  before(() => {
    // Set test env
    process.env['MASTER_KEY'] = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    process.env['NODE_ENV'] = 'test';

    // Prepare clean test dir
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
    mkdirSync(join(TEST_STORAGE, 'db'), { recursive: true });

    storage = new StorageManager(TEST_STORAGE);
    storage.ensureDirectories();

    db = openDatabase(TEST_DB_PATH);
    runMigrations(db);

    settings = new SettingsService(db);
    settings.seedDefaults();

    audit = new AuditService(db);
    notifications = new NotificationService(db);
    backups = new BackupService(db, storage, notifications, settings);
  });

  after(() => {
    closeDatabase();
    try {
      rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it('SEC-001: Argon2id hashes and verifies passwords correctly', async () => {
    const password = 'SuperSecretMasterPassword123!';
    const hash = await hashPassword(password);
    assert.ok(hash.startsWith('$argon2id$'), 'Hash must be Argon2id format');
    const isValid = await verifyPassword(hash, password);
    assert.strictEqual(isValid, true, 'Valid password must verify');
    const isInvalid = await verifyPassword(hash, 'WrongPassword123!');
    assert.strictEqual(isInvalid, false, 'Invalid password must be rejected');
  });

  it('SEC-002: Session lifecycle and CSRF protection', () => {
    // Create admin user for foreign key constraint
    const now = Date.now();
    const adminResult = db
      .prepare('INSERT INTO admin_users (username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('testadmin', 'dummyhash', now, now);
    const adminId = adminResult.lastInsertRowid as number;

    // Create session
    const sessionRes = createSession(db, { adminId, ip: '127.0.0.1' });
    assert.ok(sessionRes.token.length >= 64, 'Token must be at least 256 bits hex');

    // Validate session
    const valid = validateSession(db, sessionRes.token);
    assert.ok(valid !== null, 'Session must be valid');
    assert.strictEqual(valid?.adminId, adminId);
    assert.strictEqual(valid?.username, 'testadmin');

    // CSRF verification
    const csrfToken = generateCsrfToken(valid!.csrfSecret);
    assert.strictEqual(validateCsrfToken(valid!.csrfSecret, csrfToken), true, 'Valid CSRF token must pass');
    assert.strictEqual(validateCsrfToken(valid!.csrfSecret, 'tampered.token'), false, 'Tampered token must fail');

    // Revoke session
    const revoked = revokeSession(db, sessionRes.token);
    assert.strictEqual(revoked, true);
    const afterRevoke = validateSession(db, sessionRes.token);
    assert.strictEqual(afterRevoke, null, 'Revoked session must not validate');
  });

  it('SEC-003: Progressive account lockout after 5 failed attempts', () => {
    const username = 'lockoutuser';
    const now = Date.now();
    const res = db
      .prepare('INSERT INTO admin_users (username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(username, 'hash', now, now);
    const userId = res.lastInsertRowid as number;

    assert.strictEqual(isAccountLocked(db, username), false);

    // Fail 4 times
    for (let i = 0; i < 4; i++) {
      recordAccountFailure(db, username);
      assert.strictEqual(isAccountLocked(db, username), false);
    }

    // 5th failure -> locked
    recordAccountFailure(db, username);
    assert.strictEqual(isAccountLocked(db, username), true, 'Account must be locked on 5th failure');

    // Reset
    resetAccountFailures(db, userId);
    assert.strictEqual(isAccountLocked(db, username), false, 'Account must be unlocked after reset');
  });

  it('SEC-004: AES-256-GCM encryption at rest and secret fingerprinting', () => {
    const secret = 'telegram-bot-token-12345:ABCDEF';
    const encrypted = encrypt(secret);
    assert.notStrictEqual(encrypted.toString('utf-8'), secret);

    const decrypted = decrypt(encrypted);
    assert.strictEqual(decrypted, secret, 'Decrypted secret must match original');

    const fp = fingerprint(secret);
    assert.strictEqual(fp.length, 4, 'Fingerprint must be 4 characters');

    // Test settings encrypted storage
    settings.setSecret('telegram.bot_token', secret);
    const storedSecret = settings.getSecret('telegram.bot_token');
    assert.strictEqual(storedSecret, secret);
    const storedFp = settings.getFingerprint('telegram.bot_token');
    assert.strictEqual(storedFp, fp);
  });

  it('SEC-005: Path traversal protection via StorageManager', () => {
    // Valid simple UUID filename
    const validPath = storage.resolveStoragePath('123e4567-e89b-12d3-a456-426614174000.mp4', 'censored');
    assert.ok(validPath.includes('videos'), 'Must resolve under videos/censored');

    // Traversal attempts must throw
    assert.throws(() => storage.resolveStoragePath('../../../etc/passwd', 'raw'), /traversal|Invalid/);
    assert.throws(() => storage.resolveStoragePath('foo/bar.mp4', 'censored'), /traversal|Invalid/);
    assert.throws(() => storage.resolveStoragePath('..\\windows\\system32', 'temp'), /traversal|Invalid/);
    assert.throws(() => storage.resolveStoragePath('.hidden_file', 'temp'), /traversal|Invalid/);
  });

  it('SEC-007: Append-only audit_logs trigger immutability', () => {
    audit.log({
      action: 'test.action',
      result: 'success',
    });

    const logs = audit.list(1);
    assert.strictEqual(logs.length, 1);
    const logId = logs[0]!.id;

    // UPDATE on audit_logs must be rejected by trigger
    assert.throws(() => {
      db.prepare('UPDATE audit_logs SET action = ? WHERE id = ?').run('hacked', logId);
    }, /audit_logs is append-only/);

    // DELETE on audit_logs must be rejected by trigger
    assert.throws(() => {
      db.prepare('DELETE FROM audit_logs WHERE id = ?').run(logId);
    }, /audit_logs is append-only/);
  });

  it('FR-028 / NFR-014: Online SQLite backup, encryption and integrity check', async () => {
    // Run integrity check
    const checkResult = backups.runIntegrityCheck('quick');
    assert.strictEqual(checkResult.ok, true, 'Database must pass quick_check');

    // Run online backup
    const backupRes = await backups.runBackup();
    assert.ok(backupRes.backupPath.endsWith('.sqlite.enc'), 'Backup must be encrypted (.enc)');
    assert.ok(backupRes.sizeBytes > 0, 'Backup size must be > 0');
    assert.ok(existsSync(backupRes.backupPath), 'Encrypted backup file must exist on disk');

    // Verify the unencrypted file does NOT exist
    const unencPath = backupRes.backupPath.replace('.enc', '');
    assert.strictEqual(existsSync(unencPath), false, 'Unencrypted backup must be deleted after encryption');
  });

  it('Notifications deduplication works as specified', () => {
    const id1 = notifications.create({
      severity: 'warning',
      type: 'test.alert',
      title: 'Alert Title',
      dedupeKey: 'unique_alert_key',
    });
    assert.ok(id1 !== null, 'First notification must be created');

    // Duplicate while unread must be ignored
    const id2 = notifications.create({
      severity: 'warning',
      type: 'test.alert',
      title: 'Alert Title',
      dedupeKey: 'unique_alert_key',
    });
    assert.strictEqual(id2, null, 'Duplicate unread notification must be ignored');

    // Mark as read
    notifications.markAsRead(id1!);

    // Now another notification with same dedupeKey is allowed
    const id3 = notifications.create({
      severity: 'warning',
      type: 'test.alert',
      title: 'Alert Title',
      dedupeKey: 'unique_alert_key',
    });
    assert.ok(id3 !== null, 'New notification allowed once previous is marked read');
  });
});

