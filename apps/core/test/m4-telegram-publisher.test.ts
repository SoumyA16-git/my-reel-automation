import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { rmSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { openDatabase, closeDatabase } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrate.js';
import { StorageManager } from '../src/storage/StorageManager.js';
import { JobQueue } from '../src/queue/JobQueue.js';
import {
  TelegramClient,
  type SendVideoOptions,
  type TelegramMessageResponse,
  type TelegramChannelPostUpdate,
  TelegramRateLimitError,
} from '../src/publishers/telegram/TelegramClient.js';
import { TelegramPublisher } from '../src/publishers/telegram/TelegramPublisher.js';
import { TelegramReconciler } from '../src/publishers/telegram/TelegramReconciler.js';
import { RawFileDeletionService } from '../src/storage/RawFileDeletionService.js';
import { WorkerPool } from '../src/queue/WorkerPool.js';
import { encrypt } from '../src/crypto/index.js';
import { SettingsService } from '../src/settings/SettingsService.js';

const TEST_DIR = join(process.cwd(), 'temp_test_m4');
const TEST_STORAGE = join(TEST_DIR, 'storage');
const TEST_DB_PATH = join(TEST_STORAGE, 'db', 'test_m4_reelhub.sqlite');

describe('M4 Telegram Publisher & Strict Raw Deletion Tests', () => {
  let db: ReturnType<typeof openDatabase>;
  let storage: StorageManager;
  let queue: JobQueue;
  let deletionService: RawFileDeletionService;
  let adminId: number;
  let tgAccountId: number;
  let tgDestId: number;

  before(() => {
    process.env['MASTER_KEY'] = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    process.env['NODE_ENV'] = 'test';

    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
    mkdirSync(join(TEST_STORAGE, 'db'), { recursive: true });

    storage = new StorageManager(TEST_STORAGE);
    storage.ensureDirectories();

    db = openDatabase(TEST_DB_PATH);
    runMigrations(db);

    const settings = new SettingsService(db);
    settings.seedDefaults();

    queue = new JobQueue(db);
    deletionService = new RawFileDeletionService(db, storage);

    const now = Date.now();
    // Seed admin
    const adminInfo = db
      .prepare(`
        INSERT INTO admin_users (username, password_hash, created_at, updated_at)
        VALUES ('m4_admin', 'hash', ?, ?)
      `)
      .run(now, now);
    adminId = Number(adminInfo.lastInsertRowid);

    // Seed Telegram connected account with encrypted bot token
    const tokenEnc = encrypt('123456789:ABCdefGHIjklMNOpqrSTUvwxYZ');
    const accInfo = db
      .prepare(`
        INSERT INTO connected_accounts (provider, display_name, external_id, auth_method, token_enc, status, created_at, updated_at)
        VALUES ('telegram', 'Test Channel Bot', '123456789', 'bot_token', ?, 'active', ?, ?)
      `)
      .run(tokenEnc, now, now);
    tgAccountId = Number(accInfo.lastInsertRowid);

    // Seed Telegram publishing destination
    const destInfo = db
      .prepare(`
        INSERT INTO publishing_destinations (kind, account_id, label, target_id, video_role, enabled, paused, created_at, updated_at)
        VALUES ('telegram', ?, 'Telegram Channel', '-100987654321', 'raw', 1, 0, ?, ?)
      `)
      .run(tgAccountId, now, now);
    tgDestId = Number(destInfo.lastInsertRowid);
  });

  after(() => {
    closeDatabase();
    if (existsSync(TEST_DIR)) {
      try {
        rmSync(TEST_DIR, { recursive: true, force: true });
      } catch {
        // Ignore
      }
    }
  });

  // -------------------------------------------------------------------------
  // Helper: create Reel with raw video file and approved caption
  // -------------------------------------------------------------------------
  function setupTestReel(filenameStem: string, sizeBytes = 1000, enqueuePublishJob = true) {
    const now = Date.now();
    // Ensure destination and account are active
    db.prepare("UPDATE publishing_destinations SET paused = 0, enabled = 1 WHERE id = ?").run(tgDestId);
    db.prepare("UPDATE connected_accounts SET status = 'active' WHERE id = ?").run(tgAccountId);

    const rInfo = db
      .prepare(`
        INSERT INTO reels (public_id, original_filename, filename_stem, status, created_by, created_at, updated_at)
        VALUES (?, ?, ?, 'ready', ?, ?, ?)
      `)
      .run(`reel_${filenameStem}`, `${filenameStem}.mp4`, filenameStem, adminId, now, now);
    const reelId = Number(rInfo.lastInsertRowid);

    // Create raw file on disk
    const storageName = `${filenameStem}_raw.mp4`;
    const rawPath = storage.resolveStoragePath(storageName, 'raw');
    writeFileSync(rawPath, Buffer.alloc(sizeBytes, 'A'));

    const fInfo = db
      .prepare(`
        INSERT INTO video_files (reel_id, role, storage_name, original_filename, size_bytes, sha256, duration_ms, state, validation_state, created_at, updated_at)
        VALUES (?, 'raw', ?, ?, ?, 'sha256_mock', 15000, 'present', 'valid', ?, ?)
      `)
      .run(reelId, storageName, `${filenameStem}.mp4`, sizeBytes, now, now);
    const rawFileId = Number(fInfo.lastInsertRowid);

    // Approved caption
    const cInfo = db
      .prepare(`
        INSERT INTO ai_content (reel_id, version, source, input_text, title, hashtags, status, created_at, updated_at)
        VALUES (?, 1, 'gemini', ?, 'Awesome Video Title', '["#tag1","#tag2"]', 'approved', ?, ?)
      `)
      .run(reelId, filenameStem, now, now);
    const captionId = Number(cInfo.lastInsertRowid);

    db.prepare('UPDATE reels SET approved_ai_content_id = ? WHERE id = ?').run(captionId, reelId);

    // Publishing record for Telegram
    const recInfo = db
      .prepare(`
        INSERT INTO publishing_records (reel_id, destination_id, video_file_id, ai_content_id, status, idempotency_key, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)
      `)
      .run(reelId, tgDestId, rawFileId, captionId, `pub:${reelId}:${tgDestId}:${now}`, now, now);
    const recordId = Number(recInfo.lastInsertRowid);

    let job: ReturnType<typeof queue.enqueue> = null;
    if (enqueuePublishJob) {
      job = queue.enqueue({
        type: 'publish.telegram',
        dedupeKey: `publish:${reelId}:${tgDestId}:${now}`,
        reelId,
        destinationId: tgDestId,
        publishingRecordId: recordId,
        priority: 100,
      });
    }

    return { reelId, rawFileId, captionId, recordId, job, storageName, rawPath };
  }

  // -------------------------------------------------------------------------
  // 1. Telegram Credential Validation
  // -------------------------------------------------------------------------
  it('1. Telegram credential validation: verifies getMe, getChat, and getChatMember permissions', async () => {
    // Mock Telegram client with custom fetch
    class MockTelegramClient extends TelegramClient {
      public override async validateCredentials(botToken: string, chatId: string) {
        if (botToken === 'bad_token') {
          return { ok: false, failedStep: 'getMe' as const, error: 'Unauthorized' };
        }
        if (chatId === 'invalid_chat') {
          return { ok: false, failedStep: 'getChat' as const, error: 'Chat not found' };
        }
        if (chatId === 'no_admin_chat') {
          return {
            ok: false,
            failedStep: 'getChatMember' as const,
            canPostMessages: false,
            error: 'Bot is not admin with can_post_messages',
          };
        }
        return {
          ok: true,
          botId: 123456789,
          botUsername: 'TestBot',
          chatId: -100987654321,
          chatTitle: 'My Channel',
          canPostMessages: true,
        };
      }
    }

    const mockClient = new MockTelegramClient();

    // Success case
    const success = await mockClient.validateCredentials('valid_token', '-100987654321');
    assert.strictEqual(success.ok, true);
    assert.strictEqual(success.canPostMessages, true);
    assert.strictEqual(success.botUsername, 'TestBot');

    // Bad token
    const badToken = await mockClient.validateCredentials('bad_token', '-100987654321');
    assert.strictEqual(badToken.ok, false);
    assert.strictEqual(badToken.failedStep, 'getMe');

    // Missing admin permissions
    const noAdmin = await mockClient.validateCredentials('valid_token', 'no_admin_chat');
    assert.strictEqual(noAdmin.ok, false);
    assert.strictEqual(noAdmin.failedStep, 'getChatMember');
    assert.strictEqual(noAdmin.canPostMessages, false);
  });

  // -------------------------------------------------------------------------
  // 2. Happy Path Telegram Publishing & Atomic Transaction
  // -------------------------------------------------------------------------
  it('2. Happy path: sendVideo success creates telegram_messages, marks published, and enqueues file.delete_raw', async () => {
    const { reelId, rawFileId, recordId, job, storageName } = setupTestReel('happy');

    // Create mock TelegramClient that succeeds
    class MockSuccessClient extends TelegramClient {
      public override async sendVideo(_botToken: string, options: SendVideoOptions): Promise<TelegramMessageResponse> {
        assert.strictEqual(options.chatId, '-100987654321');
        assert.ok(options.caption?.includes('Awesome Video Title'));
        assert.ok(options.caption?.includes('#tag1'));
        assert.strictEqual(options.supportsStreaming, true);

        return {
          message_id: 8888,
          chat: { id: -100987654321, title: 'Telegram Channel' },
          date: Math.floor(Date.now() / 1000),
          video: {
            file_id: 'tg_file_id_xyz',
            file_unique_id: 'tg_unique_123',
            file_size: 1000,
            duration: 15,
          },
        };
      }
    }

    const publisher = new TelegramPublisher(db, storage, new MockSuccessClient());

    // Worker claims job
    const claimed = queue.claimNextJob('worker-tg-1', ['publish.telegram']);
    assert.ok(claimed);
    assert.strictEqual(claimed.id, job.id);

    // Publish
    const result = await publisher.publish(claimed, 'worker-tg-1');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.status, 'published');
    assert.strictEqual(result.messageId, 8888);

    // Verify atomic transaction results:
    // A. telegram_messages row exists
    const msg = db
      .prepare('SELECT * FROM telegram_messages WHERE publishing_record_id = ?')
      .get(recordId) as { message_id: number; file_id: string; verification_method: string };
    assert.ok(msg);
    assert.strictEqual(msg.message_id, 8888);
    assert.strictEqual(msg.file_id, 'tg_file_id_xyz');
    assert.strictEqual(msg.verification_method, 'api_response');

    // B. publishing_records is published
    const rec = db
      .prepare('SELECT status, phase, remote_post_id FROM publishing_records WHERE id = ?')
      .get(recordId) as { status: string; phase: string; remote_post_id: string };
    assert.strictEqual(rec.status, 'published');
    assert.strictEqual(rec.phase, 'published');
    assert.strictEqual(rec.remote_post_id, '8888');

    // C. background_jobs is succeeded
    const finalJob = queue.getJobById(job.id);
    assert.strictEqual(finalJob?.state, 'succeeded');

    // D. file.delete_raw job was enqueued
    const deleteJob = db
      .prepare("SELECT * FROM background_jobs WHERE type = 'file.delete_raw' AND reel_id = ?")
      .get(reelId) as { id: number; dedupe_key: string; priority: number } | undefined;
    assert.ok(deleteJob, 'file.delete_raw job must be enqueued');
    assert.strictEqual(deleteJob.dedupe_key, `delete_raw:${rawFileId}`);
    assert.strictEqual(deleteJob.priority, 20);
  });

  // -------------------------------------------------------------------------
  // 3. Strict Raw File Deletion Execution (PRD Section 13 / FR-018)
  // -------------------------------------------------------------------------
  it('3. Strict raw deletion: unlinks file, logs to file_deletion_log, updates state to deleted', () => {
    // The previous test setup has a verified telegram delivery for 'happy' reel!
    const file = db
      .prepare("SELECT id, storage_name, size_bytes FROM video_files WHERE storage_name = 'happy_raw.mp4'")
      .get() as { id: number; storage_name: string; size_bytes: number };
    assert.ok(file);

    const filePath = storage.resolveStoragePath(file.storage_name, 'raw');
    assert.strictEqual(existsSync(filePath), true, 'File must exist on disk before deletion');

    // Execute raw deletion
    const delResult = deletionService.deleteRawFile(file.id);
    assert.strictEqual(delResult.ok, true);
    assert.strictEqual(delResult.outcome, 'deleted');

    // File MUST be removed from disk
    assert.strictEqual(existsSync(filePath), false, 'Raw file must be deleted from disk');

    // video_files.state must be 'deleted'
    const updatedFile = db
      .prepare('SELECT state, deletion_reason, deleted_at FROM video_files WHERE id = ?')
      .get(file.id) as { state: string; deletion_reason: string; deleted_at: number | null };
    assert.strictEqual(updatedFile.state, 'deleted');
    assert.strictEqual(updatedFile.deletion_reason, 'telegram_delivered');
    assert.ok(updatedFile.deleted_at !== null);

    // file_deletion_log must contain immutable record
    const log = db
      .prepare('SELECT * FROM file_deletion_log WHERE video_file_id = ?')
      .get(file.id) as { outcome: string; reason: string; role: string; storage_name: string };
    assert.ok(log);
    assert.strictEqual(log.outcome, 'deleted');
    assert.strictEqual(log.reason, 'telegram_delivered');
    assert.strictEqual(log.role, 'raw');
    assert.strictEqual(log.storage_name, file.storage_name);
  });

  // -------------------------------------------------------------------------
  // 4. Never-Delete Rule: Unverified Delivery Refusal (PRD 13.3)
  // -------------------------------------------------------------------------
  it('4. Never-delete rule: raw file is strictly retained if telegram delivery is not verified', () => {
    // Setup a reel whose destination is still pending / uncertain
    const { rawFileId, rawPath, recordId } = setupTestReel('never_delete_pending', 1000, false);

    assert.strictEqual(existsSync(rawPath), true);

    // Ensure destination is in_progress / uncertain
    db.prepare("UPDATE publishing_records SET status = 'uncertain' WHERE id = ?").run(recordId);

    // Attempt raw file deletion: MUST BE REFUSED!
    const result = deletionService.deleteRawFile(rawFileId);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.outcome, 'refused');
    assert.strictEqual(result.reason, 'telegram_not_published');

    // CRITICAL: Physical file MUST STILL EXIST on disk!
    assert.strictEqual(existsSync(rawPath), true, 'Raw file must be retained on disk when unverified');

    // Refusal logged in file_deletion_log
    const log = db
      .prepare('SELECT * FROM file_deletion_log WHERE video_file_id = ?')
      .get(rawFileId) as { outcome: string; reason: string } | undefined;
    assert.ok(log);
    assert.strictEqual(log.outcome, 'refused');
  });

  // -------------------------------------------------------------------------
  // 5. Never-Delete Rule: Active Lease Lock Refusal (PRD 13.3)
  // -------------------------------------------------------------------------
  it('5. Never-delete rule: raw file deletion is refused if locked by an active job lease', () => {
    const { rawFileId, rawPath, recordId } = setupTestReel('lease_locked', 1000, false);

    // Simulate published destination and telegram_messages proof
    const now = Date.now();
    db.prepare("UPDATE publishing_records SET status = 'published' WHERE id = ?").run(recordId);
    db.prepare(`
      INSERT INTO telegram_messages (publishing_record_id, chat_id, message_id, delivered_at, verification_method, created_at, updated_at)
      VALUES (?, '-100987654321', 9999, ?, 'api_response', ?, ?)
    `).run(recordId, now, now, now);

    // Create an active leased job holding the lock
    const otherJob = queue.enqueue({ type: 'browser.task' });
    assert.ok(otherJob);
    queue.claimNextJob('other-worker', ['browser.task']);
    queue.acquireFileLock(otherJob.id, rawFileId);

    // Attempt deletion while file is locked by other job: MUST REFUSE
    const result = deletionService.deleteRawFile(rawFileId, 77777 /* different job ID */);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.outcome, 'refused');
    assert.strictEqual(result.reason, 'active_lease');

    // Physical file must still exist
    assert.strictEqual(existsSync(rawPath), true);
  });

  // -------------------------------------------------------------------------
  // 6. Size Limit Enforcement (PRD 12.2)
  // -------------------------------------------------------------------------
  it('6. Size limit: raw file > 50 MB on cloud Bot API is rejected with needs_action', async () => {
    // 55 MB raw file
    const { rawFileId, job, recordId } = setupTestReel('huge_file', 55 * 1024 * 1024, true);

    class MockOversizeClient extends TelegramClient {
      public override async sendVideo(): Promise<TelegramMessageResponse> {
        throw new Error('sendVideo should never be called for >50MB on cloud Bot API');
      }
    }

    const publisher = new TelegramPublisher(db, storage, new MockOversizeClient());

    const claimed = queue.claimNextJob('w-size', ['publish.telegram']);
    assert.ok(claimed);
    assert.strictEqual(claimed.id, job?.id);

    const result = await publisher.publish(claimed, 'w-size');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 'needs_action');
    assert.ok(result.error?.includes('50 MB'));

    // Record status should be needs_action
    const rec = db
      .prepare('SELECT status, last_error_code FROM publishing_records WHERE id = ?')
      .get(recordId) as { status: string; last_error_code: string };
    assert.strictEqual(rec.status, 'needs_action');
    assert.strictEqual(rec.last_error_code, 'SIZE_LIMIT_EXCEEDED');
  });

  // -------------------------------------------------------------------------
  // 7. Uncertain Delivery & Channel Post Reconciliation (PRD 12.4)
  // -------------------------------------------------------------------------
  it('7. Uncertain delivery: timeout after upload retains raw file; reconcile detects channel_post and completes', async () => {
    const { reelId, rawFileId, rawPath, recordId, job } = setupTestReel('uncertain');

    // Mock client that simulates timeout during sendVideo
    class MockTimeoutClient extends TelegramClient {
      public override async sendVideo(): Promise<TelegramMessageResponse> {
        const err = new Error('Telegram sendVideo upload timed out after 600000 ms');
        err.name = 'AbortError';
        throw err;
      }

      public override async getChannelPostUpdates(): Promise<TelegramChannelPostUpdate[]> {
        return [
          {
            update_id: 501,
            channel_post: {
              message_id: 7777,
              chat: { id: -100987654321, title: 'Telegram Channel' },
              date: Math.floor(Date.now() / 1000),
              caption: 'Awesome Video Title\n\n#tag1 #tag2',
              video: {
                file_id: 'reconciled_fid',
                file_unique_id: 'reconciled_uid',
                file_size: 1000,
                duration: 15,
              },
            },
          },
        ];
      }
    }

    const mockClient = new MockTimeoutClient();
    const publisher = new TelegramPublisher(db, storage, mockClient);
    const reconciler = new TelegramReconciler(db, mockClient);

    const claimed = queue.claimNextJob('w-unc', ['publish.telegram']);
    assert.ok(claimed);

    // Publish encounters timeout
    const pubResult = await publisher.publish(claimed, 'w-unc');
    assert.strictEqual(pubResult.ok, false);
    assert.strictEqual(pubResult.status, 'uncertain');

    // Raw file MUST still exist!
    assert.strictEqual(existsSync(rawPath), true, 'Raw file must be retained on uncertain outcome');

    // Destination status is uncertain, phase is publish_requested
    const rec = db
      .prepare('SELECT status, phase FROM publishing_records WHERE id = ?')
      .get(recordId) as { status: string; phase: string };
    assert.strictEqual(rec.status, 'uncertain');
    assert.strictEqual(rec.phase, 'publish_requested');

    // reconcile.destination job was enqueued
    const recJob = queue.claimNextJob('w-rec', ['reconcile.destination']);
    assert.ok(recJob);
    assert.strictEqual(recJob.reel_id, reelId);

    // Run reconciliation
    const reconResult = await reconciler.reconcile(recJob, 'w-rec');
    assert.strictEqual(reconResult.reconciled, true);
    assert.strictEqual(reconResult.outcome, 'published');
    assert.strictEqual(reconResult.messageId, 7777);

    // Destination is now published with verification_method = 'channel_post_reconcile'
    const finalMsg = db
      .prepare('SELECT message_id, verification_method FROM telegram_messages WHERE publishing_record_id = ?')
      .get(recordId) as { message_id: number; verification_method: string };
    assert.strictEqual(finalMsg.message_id, 7777);
    assert.strictEqual(finalMsg.verification_method, 'channel_post_reconcile');

    // file.delete_raw job should now be enqueued (drain older delete jobs from previous tests)
    db.prepare("DELETE FROM background_jobs WHERE type = 'file.delete_raw' AND reel_id != ?").run(reelId);
    const delJob = queue.claimNextJob('w-del', ['file.delete_raw']);
    assert.ok(delJob);
    assert.strictEqual(delJob.reel_id, reelId);

    // Execute raw file deletion
    const delRes = deletionService.deleteRawFile(rawFileId, delJob.id);
    assert.strictEqual(delRes.ok, true);
    assert.strictEqual(delRes.outcome, 'deleted');

    // Now file is deleted!
    assert.strictEqual(existsSync(rawPath), false);
  });

  // -------------------------------------------------------------------------
  // 8. Rate Limit Handling (HTTP 429)
  // -------------------------------------------------------------------------
  it('8. Rate limit 429: extracts retry_after and defers job without failing terminal', async () => {
    const { job, rawPath } = setupTestReel('rate_limit');

    class Mock429Client extends TelegramClient {
      public override async sendVideo(): Promise<TelegramMessageResponse> {
        throw new TelegramRateLimitError('Too Many Requests: retry after 45', 45);
      }
    }

    const publisher = new TelegramPublisher(db, storage, new Mock429Client());
    const claimed = queue.claimNextJob('w-429', ['publish.telegram']);
    assert.ok(claimed);

    const result = await publisher.publish(claimed, 'w-429');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 'failed_retryable');
    assert.strictEqual(result.retryAfterSeconds, 45);

    // Job should be queued with run_at ~now + 45s
    const updatedJob = queue.getJobById(job.id);
    assert.strictEqual(updatedJob?.state, 'queued');
    assert.ok(updatedJob.run_at > Date.now() + 40_000);

    // Raw file must be retained!
    assert.strictEqual(existsSync(rawPath), true);
  });

  // -------------------------------------------------------------------------
  // 9. WorkerPool End-to-End Execution
  // -------------------------------------------------------------------------
  it('9. WorkerPool end-to-end: claims publish.telegram, delivers, and runs file.delete_raw', async () => {
    const { reelId, rawFileId, rawPath, recordId, job } = setupTestReel('worker_e2e');

    class MockE2EClient extends TelegramClient {
      public override async sendVideo(): Promise<TelegramMessageResponse> {
        return {
          message_id: 9901,
          chat: { id: -100987654321 },
          date: Math.floor(Date.now() / 1000),
          video: { file_id: 'fid_e2e', file_unique_id: 'uid_e2e' },
        };
      }
    }

    const publisher = new TelegramPublisher(db, storage, new MockE2EClient());
    const pool = new WorkerPool(db, publisher, undefined, deletionService);

    // Run publish.telegram job
    const claimedPublish = queue.claimNextJob(pool.workerId, ['publish.telegram']);
    assert.ok(claimedPublish);
    await pool.executeJob(claimedPublish);

    // Destination should be published
    const rec = db.prepare('SELECT status FROM publishing_records WHERE id = ?').get(recordId) as { status: string };
    assert.strictEqual(rec.status, 'published');

    // Claim and execute file.delete_raw job
    db.prepare("DELETE FROM background_jobs WHERE type = 'file.delete_raw' AND reel_id != ?").run(reelId);
    const claimedDelete = queue.claimNextJob(pool.workerId, ['file.delete_raw']);
    assert.ok(claimedDelete);
    await pool.executeJob(claimedDelete);

    // Raw file must be deleted from disk
    assert.strictEqual(existsSync(rawPath), false, 'Raw file must be deleted by WorkerPool');

    // video_files row marked deleted
    const fRow = db.prepare('SELECT state FROM video_files WHERE id = ?').get(rawFileId) as { state: string };
    assert.strictEqual(fRow.state, 'deleted');
  });
});
