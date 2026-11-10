import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { rmSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { openDatabase, closeDatabase } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrate.js';
import { StorageManager, initStorageManager } from '../src/storage/StorageManager.js';
import { JobQueue } from '../src/queue/JobQueue.js';
import {
  MetaClient,
  MetaAuthError,
  MetaRateLimitError,
  MetaNetworkError,
} from '../src/publishers/meta/MetaClient.js';
import { MetaPublisher } from '../src/publishers/meta/MetaPublisher.js';
import { MetaReconciler } from '../src/publishers/meta/MetaReconciler.js';
import { WorkerPool } from '../src/queue/WorkerPool.js';
import { encrypt } from '../src/crypto/index.js';
import { SettingsService } from '../src/settings/SettingsService.js';

const TEST_DIR = join(process.cwd(), 'temp_test_m5');
const TEST_STORAGE = join(TEST_DIR, 'storage');
const TEST_DB_PATH = join(TEST_STORAGE, 'db', 'test_m5_reelhub.sqlite');

describe('M5 Meta Publisher (Instagram & Facebook) Tests', () => {
  let db: ReturnType<typeof openDatabase>;
  let storage: StorageManager;
  let queue: JobQueue;
  let adminId: number;
  let metaAccountId: number;
  let igDestId: number;
  let fbDestId: number;

  before(() => {
    process.env['MASTER_KEY'] = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    process.env['NODE_ENV'] = 'test';

    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
    mkdirSync(join(TEST_STORAGE, 'db'), { recursive: true });

    storage = initStorageManager(TEST_STORAGE);
    storage.ensureDirectories();

    db = openDatabase(TEST_DB_PATH);
    runMigrations(db);

    const settings = new SettingsService(db);
    settings.seedDefaults();

    queue = new JobQueue(db);

    const now = Date.now();
    // Seed admin
    const adminInfo = db
      .prepare(`
        INSERT INTO admin_users (username, password_hash, created_at, updated_at)
        VALUES ('m5_admin', 'hash', ?, ?)
      `)
      .run(now, now);
    adminId = Number(adminInfo.lastInsertRowid);

    // Seed Meta connected account with encrypted access token
    const tokenEnc = encrypt('EAABmock_meta_access_token_1234567890');
    const accInfo = db
      .prepare(`
        INSERT INTO connected_accounts (
          provider, display_name, external_id, external_id_2, auth_method,
          token_enc, status, created_at, updated_at
        ) VALUES ('meta', 'Test Business Page', 'page_12345', 'ig_67890', 'oauth', ?, 'active', ?, ?)
      `)
      .run(tokenEnc, now, now);
    metaAccountId = Number(accInfo.lastInsertRowid);

    // Seed Instagram destination
    const igInfo = db
      .prepare(`
        INSERT INTO publishing_destinations (
          kind, account_id, label, target_id, video_role, enabled, paused, created_at, updated_at
        ) VALUES ('instagram', ?, 'Instagram Reels', 'ig_67890', 'censored', 1, 0, ?, ?)
      `)
      .run(metaAccountId, now, now);
    igDestId = Number(igInfo.lastInsertRowid);

    // Seed Facebook destination
    const fbInfo = db
      .prepare(`
        INSERT INTO publishing_destinations (
          kind, account_id, label, target_id, video_role, enabled, paused, created_at, updated_at
        ) VALUES ('facebook', ?, 'Facebook Page Reels', 'page_12345', 'censored', 1, 0, ?, ?)
      `)
      .run(metaAccountId, now, now);
    fbDestId = Number(fbInfo.lastInsertRowid);
  });

  after(() => {
    closeDatabase();
    if (existsSync(TEST_DIR)) {
      try {
        rmSync(TEST_DIR, { recursive: true, force: true });
      } catch {
        // ignore on Windows if lock takes a moment to release
      }
    }
  });

  // Helper to create test reel and video files
  function setupTestReel(
    destId: number,
    opts: {
      censoredSize?: number;
      censoredDuration?: number;
      censoredWidth?: number;
      censoredHeight?: number;
      phase?: string;
      remoteContainerId?: string | null;
      enqueuePublishJob?: boolean;
    } = {},
  ) {
    const now = Date.now();
    const destKind = destId === igDestId ? 'instagram' : 'facebook';

    // Ensure destination is enabled and unpaused
    db.prepare('UPDATE publishing_destinations SET paused = 0, enabled = 1 WHERE id = ?').run(destId);

    // Create Reel
    const publicId = `reel_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const stem = `stem_${destKind}_${Math.random().toString(36).slice(2, 8)}`;
    const reelInfo = db
      .prepare(`
        INSERT INTO reels (public_id, original_filename, filename_stem, status, created_by, created_at, updated_at)
        VALUES (?, ?, ?, 'ready', ?, ?, ?)
      `)
      .run(publicId, `${stem}.mp4`, stem, adminId, now, now);
    const reelId = Number(reelInfo.lastInsertRowid);

    // Create Censored video file
    const size = opts.censoredSize ?? 10 * 1024 * 1024; // 10 MB default
    const durationMs = opts.censoredDuration ?? 15_000; // 15 seconds
    const width = opts.censoredWidth ?? 1080;
    const height = opts.censoredHeight ?? 1920;
    const storageName = `test_c_${reelId}_${destKind}.mp4`;
    const diskPath = join(TEST_STORAGE, 'videos', 'censored', storageName);

    // Create dummy file on disk
    writeFileSync(diskPath, Buffer.alloc(Math.min(size, 4096)));

    const fileInfo = db
      .prepare(`
        INSERT INTO video_files (
          reel_id, role, storage_name, original_filename, size_bytes,
          sha256, duration_ms, width, height, state, validation_state, created_at, updated_at
        ) VALUES (?, 'censored', ?, 'orig.mp4', ?, 'mocksha256', ?, ?, ?, 'present', 'valid', ?, ?)
      `)
      .run(reelId, storageName, size, durationMs, width, height, now, now);
    const fileId = Number(fileInfo.lastInsertRowid);

    // Caption
    const capInfo = db
      .prepare(`
        INSERT INTO ai_content (
          reel_id, version, source, input_text, title, hashtags,
          status, approved_at, created_at, updated_at
        ) VALUES (?, 1, 'gemini', 'input text', 'My Awesome Reel', '["#viral","#reels"]', 'approved', ?, ?, ?)
      `)
      .run(reelId, now, now, now);
    const capId = Number(capInfo.lastInsertRowid);

    // Link approved ai content
    db.prepare('UPDATE reels SET approved_ai_content_id = ? WHERE id = ?').run(capId, reelId);

    // Publishing record
    const initialPhase = opts.phase ?? 'none';
    const remoteId = opts.remoteContainerId ?? null;
    const recInfo = db
      .prepare(`
        INSERT INTO publishing_records (
          reel_id, destination_id, video_file_id, ai_content_id,
          status, phase, remote_container_id, idempotency_key, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)
      `)
      .run(reelId, destId, fileId, capId, initialPhase, remoteId, `meta-key-${reelId}-${destId}`, now, now);
    const recordId = Number(recInfo.lastInsertRowid);

    let jobId: number | undefined;
    if (opts.enqueuePublishJob !== false) {
      const job = queue.enqueue({
        type: `publish.${destKind}`,
        reelId,
        destinationId: destId,
        publishingRecordId: recordId,
        payload: {
          reelId,
          destinationId: destId,
          publishingRecordId: recordId,
        },
        priority: 50,
      });
      jobId = job.id;
    }

    return { reelId, fileId, capId, recordId, jobId, diskPath };
  }

  // -------------------------------------------------------------------------
  // Test 1: Instagram Reel Happy Path
  // -------------------------------------------------------------------------
  it('1. Instagram Reel happy path: container -> resumable upload -> poll status -> publish -> permalink', async () => {
    const { reelId, recordId, jobId } = setupTestReel(igDestId);

    class MockInstagramClient extends MetaClient {
      public containerCreated = false;
      public uploadDone = false;
      public pollDone = false;
      public publishDone = false;
      public permalinkChecked = false;

      public override async checkTokenHealth() {
        return { id: 'user_1', isValid: true };
      }

      public override async createInstagramContainer(igUserId: string) {
        assert.strictEqual(igUserId, 'ig_67890');
        this.containerCreated = true;
        return { containerId: 'c_ig_1001', uploadUri: 'https://mock.rupload/ig_1001' };
      }

      public override async uploadBytes(uploadUrl: string) {
        this.uploadDone = true;
        return { success: true, bytesTransferred: 1024 };
      }

      public override async pollInstagramContainerStatus(containerId: string) {
        assert.strictEqual(containerId, 'c_ig_1001');
        this.pollDone = true;
        return { statusCode: 'FINISHED', status: 'READY' };
      }

      public override async publishInstagramContainer(igUserId: string, containerId: string) {
        assert.strictEqual(igUserId, 'ig_67890');
        assert.strictEqual(containerId, 'c_ig_1001');
        this.publishDone = true;
        return { mediaId: 'media_ig_9999' };
      }

      public override async getInstagramPermalink(mediaId: string) {
        assert.strictEqual(mediaId, 'media_ig_9999');
        this.permalinkChecked = true;
        return 'https://www.instagram.com/reel/CxxxYYY/';
      }
    }

    const mockClient = new MockInstagramClient();
    const publisher = new MetaPublisher(db, storage, mockClient);

    const job = queue.claimNextJob('w1', ['publish.instagram']);
    assert.ok(job);
    assert.strictEqual(job.id, jobId);

    const res = await publisher.publish(job, 'w1');

    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.status, 'published');
    assert.strictEqual(res.postId, 'media_ig_9999');
    assert.strictEqual(res.permalink, 'https://www.instagram.com/reel/CxxxYYY/');

    assert.strictEqual(mockClient.containerCreated, true);
    assert.strictEqual(mockClient.uploadDone, true);
    assert.strictEqual(mockClient.pollDone, true);
    assert.strictEqual(mockClient.publishDone, true);
    assert.strictEqual(mockClient.permalinkChecked, true);

    // Verify DB state
    const record = db.prepare('SELECT * FROM publishing_records WHERE id = ?').get(recordId) as any;
    assert.strictEqual(record.status, 'published');
    assert.strictEqual(record.phase, 'published');
    assert.strictEqual(record.remote_post_id, 'media_ig_9999');
    assert.strictEqual(record.remote_url, 'https://www.instagram.com/reel/CxxxYYY/');

    // Verify file lock released
    const file = db.prepare('SELECT in_use_by_job_id FROM video_files WHERE id = ?').get(record.video_file_id) as any;
    assert.strictEqual(file.in_use_by_job_id, null);

    // Verify attempt row
    const attempt = db.prepare('SELECT * FROM publishing_attempts WHERE publishing_record_id = ?').get(recordId) as any;
    assert.strictEqual(attempt.outcome, 'succeeded');
    assert.strictEqual(attempt.phase_reached, 'published');
  });

  // -------------------------------------------------------------------------
  // Test 2: Facebook Page Reel Happy Path
  // -------------------------------------------------------------------------
  it('2. Facebook Page Reel happy path: start session -> resumable upload -> finish -> poll live status', async () => {
    const { reelId, recordId, jobId } = setupTestReel(fbDestId);

    class MockFacebookClient extends MetaClient {
      public startDone = false;
      public uploadDone = false;
      public finishDone = false;
      public pollDone = false;

      public override async checkTokenHealth() {
        return { id: 'user_1', isValid: true };
      }

      public override async startFacebookReelSession(pageId: string) {
        assert.strictEqual(pageId, 'page_12345');
        this.startDone = true;
        return { videoId: 'fb_vid_5555', uploadUrl: 'https://mock.rupload/fb_5555' };
      }

      public override async uploadBytes() {
        this.uploadDone = true;
        return { success: true, bytesTransferred: 1024 };
      }

      public override async finishFacebookReelSession(pageId: string, token: string, params: any) {
        assert.strictEqual(pageId, 'page_12345');
        assert.strictEqual(params.videoId, 'fb_vid_5555');
        this.finishDone = true;
        return { success: true };
      }

      public override async pollFacebookReelStatus(videoId: string) {
        assert.strictEqual(videoId, 'fb_vid_5555');
        this.pollDone = true;
        return {
          publishingStatus: 'complete',
          permalinkUrl: 'https://www.facebook.com/reel/fb_vid_5555',
        };
      }
    }

    const mockClient = new MockFacebookClient();
    const publisher = new MetaPublisher(db, storage, mockClient);

    const job = queue.claimNextJob('w1', ['publish.facebook']);
    assert.ok(job);
    assert.strictEqual(job.id, jobId);

    const res = await publisher.publish(job, 'w1');

    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.status, 'published');
    assert.strictEqual(res.postId, 'fb_vid_5555');
    assert.strictEqual(res.permalink, 'https://www.facebook.com/reel/fb_vid_5555');

    assert.strictEqual(mockClient.startDone, true);
    assert.strictEqual(mockClient.uploadDone, true);
    assert.strictEqual(mockClient.finishDone, true);
    assert.strictEqual(mockClient.pollDone, true);

    const record = db.prepare('SELECT * FROM publishing_records WHERE id = ?').get(recordId) as any;
    assert.strictEqual(record.status, 'published');
    assert.strictEqual(record.phase, 'published');
    assert.strictEqual(record.remote_post_id, 'fb_vid_5555');
  });

  // -------------------------------------------------------------------------
  // Test 3: Instagram Pre-flight Check: File Oversize (> 300 MB)
  // -------------------------------------------------------------------------
  it('3. Instagram pre-flight size check: file > 300 MB flagged needs_action (OVERSIZE_FOR_INSTAGRAM)', async () => {
    // 320 MB file size
    const oversizeBytes = 320 * 1024 * 1024;
    const { recordId, jobId } = setupTestReel(igDestId, { censoredSize: oversizeBytes });

    class MockClient extends MetaClient {
      public override async checkTokenHealth() {
        return { id: 'u1', isValid: true };
      }
      public override async createInstagramContainer() {
        assert.fail('Should never create container for oversize file');
      }
    }

    const publisher = new MetaPublisher(db, storage, new MockClient());
    const job = queue.claimNextJob('w1', ['publish.instagram']);
    assert.ok(job);
    assert.strictEqual(job.id, jobId);

    const res = await publisher.publish(job, 'w1');
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.status, 'needs_action');

    const rec = db.prepare('SELECT status, last_error_code FROM publishing_records WHERE id = ?').get(recordId) as any;
    assert.strictEqual(rec.status, 'needs_action');
    assert.strictEqual(rec.last_error_code, 'OVERSIZE_FOR_INSTAGRAM');

    const notif = db
      .prepare("SELECT * FROM notifications WHERE type = 'publish_failed' AND title LIKE '%300 MB%'")
      .get() as any;
    assert.ok(notif, 'Admin notification should be generated for oversize Instagram file');
  });

  // -------------------------------------------------------------------------
  // Test 4: Instagram Pre-flight Check: Duration Out of Range (< 3s)
  // -------------------------------------------------------------------------
  it('4. Instagram pre-flight duration check: < 3s flagged needs_action (DURATION_OUT_OF_RANGE)', async () => {
    // 1500 ms = 1.5 seconds (< 3s minimum)
    const { recordId, jobId } = setupTestReel(igDestId, { censoredDuration: 1500 });

    class MockClient extends MetaClient {
      public override async checkTokenHealth() {
        return { id: 'u1', isValid: true };
      }
      public override async createInstagramContainer() {
        assert.fail('Should never create container for short video');
      }
    }

    const publisher = new MetaPublisher(db, storage, new MockClient());
    const job = queue.claimNextJob('w1', ['publish.instagram']);
    assert.ok(job);
    assert.strictEqual(job.id, jobId);

    const res = await publisher.publish(job, 'w1');
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.status, 'needs_action');

    const rec = db.prepare('SELECT status, last_error_code FROM publishing_records WHERE id = ?').get(recordId) as any;
    assert.strictEqual(rec.status, 'needs_action');
    assert.strictEqual(rec.last_error_code, 'DURATION_OUT_OF_RANGE');
  });

  // -------------------------------------------------------------------------
  // Test 5: Facebook Pre-flight Check: Minimum Resolution (< 540p)
  // -------------------------------------------------------------------------
  it('5. Facebook pre-flight resolution check: < 540p flagged needs_action (LOW_RESOLUTION_FOR_FACEBOOK)', async () => {
    // 480x360 resolution (below 540p)
    const { recordId, jobId } = setupTestReel(fbDestId, { censoredWidth: 480, censoredHeight: 360 });

    class MockClient extends MetaClient {
      public override async checkTokenHealth() {
        return { id: 'u1', isValid: true };
      }
      public override async startFacebookReelSession() {
        assert.fail('Should never start FB reel session for low-res video');
      }
    }

    const publisher = new MetaPublisher(db, storage, new MockClient());
    const job = queue.claimNextJob('w1', ['publish.facebook']);
    assert.ok(job);
    assert.strictEqual(job.id, jobId);

    const res = await publisher.publish(job, 'w1');
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.status, 'needs_action');

    const rec = db.prepare('SELECT status, last_error_code FROM publishing_records WHERE id = ?').get(recordId) as any;
    assert.strictEqual(rec.status, 'needs_action');
    assert.strictEqual(rec.last_error_code, 'LOW_RESOLUTION_FOR_FACEBOOK');
  });

  // -------------------------------------------------------------------------
  // Test 6: Checkpoint Resumption on Instagram
  // -------------------------------------------------------------------------
  it('6. Checkpoint resumption on Instagram: existing container_created phase resumes without re-creating container', async () => {
    // Record already has container_created checkpoint
    const { recordId, jobId } = setupTestReel(igDestId, {
      phase: 'container_created',
      remoteContainerId: 'c_existing_777',
    });

    class MockResumeClient extends MetaClient {
      public containerCreated = false;
      public uploadDone = false;

      public override async checkTokenHealth() {
        return { id: 'u1', isValid: true };
      }

      public override async createInstagramContainer() {
        this.containerCreated = true;
        assert.fail('Should NOT re-create container if remoteContainerId already exists');
      }

      public override async uploadBytes(uploadUrl: string) {
        assert.ok(uploadUrl.includes('c_existing_777'), 'Upload must use existing container ID');
        this.uploadDone = true;
        return { success: true, bytesTransferred: 500 };
      }

      public override async pollInstagramContainerStatus(containerId: string) {
        assert.strictEqual(containerId, 'c_existing_777');
        return { statusCode: 'FINISHED' };
      }

      public override async publishInstagramContainer(igUserId: string, containerId: string) {
        assert.strictEqual(containerId, 'c_existing_777');
        return { mediaId: 'media_resumed_888' };
      }

      public override async getInstagramPermalink() {
        return 'https://instagram.com/reel/resumed';
      }
    }

    const mockClient = new MockResumeClient();
    const publisher = new MetaPublisher(db, storage, mockClient);

    const job = queue.claimNextJob('w1', ['publish.instagram']);
    assert.ok(job);
    assert.strictEqual(job.id, jobId);

    const res = await publisher.publish(job, 'w1');
    assert.strictEqual(res.ok, true);
    assert.strictEqual(mockClient.containerCreated, false, 'createInstagramContainer must NOT be called');
    assert.strictEqual(mockClient.uploadDone, true, 'uploadBytes must be called to complete');

    const rec = db.prepare('SELECT status, phase, remote_post_id FROM publishing_records WHERE id = ?').get(recordId) as any;
    assert.strictEqual(rec.status, 'published');
    assert.strictEqual(rec.phase, 'published');
    assert.strictEqual(rec.remote_post_id, 'media_resumed_888');
  });

  // -------------------------------------------------------------------------
  // Test 7: Checkpoint Resumption on Facebook
  // -------------------------------------------------------------------------
  it('7. Checkpoint resumption on Facebook: upload_complete phase resumes directly to finish and poll', async () => {
    // Record already reached upload_complete checkpoint
    const { recordId, jobId } = setupTestReel(fbDestId, {
      phase: 'upload_complete',
      remoteContainerId: 'fb_existing_vid_999',
    });

    class MockResumeClient extends MetaClient {
      public startDone = false;
      public uploadDone = false;
      public finishDone = false;

      public override async checkTokenHealth() {
        return { id: 'u1', isValid: true };
      }

      public override async startFacebookReelSession() {
        this.startDone = true;
        assert.fail('Should NOT restart session');
      }

      public override async uploadBytes() {
        this.uploadDone = true;
        assert.fail('Should NOT re-upload bytes if upload_complete');
      }

      public override async finishFacebookReelSession(pageId: string, token: string, params: any) {
        assert.strictEqual(params.videoId, 'fb_existing_vid_999');
        this.finishDone = true;
        return { success: true };
      }

      public override async pollFacebookReelStatus(videoId: string) {
        assert.strictEqual(videoId, 'fb_existing_vid_999');
        return { publishingStatus: 'complete', permalinkUrl: 'https://fb.com/reel/999' };
      }
    }

    const mockClient = new MockResumeClient();
    const publisher = new MetaPublisher(db, storage, mockClient);

    const job = queue.claimNextJob('w1', ['publish.facebook']);
    assert.ok(job);
    assert.strictEqual(job.id, jobId);

    const res = await publisher.publish(job, 'w1');
    assert.strictEqual(res.ok, true);
    assert.strictEqual(mockClient.startDone, false);
    assert.strictEqual(mockClient.uploadDone, false);
    assert.strictEqual(mockClient.finishDone, true);

    const rec = db.prepare('SELECT status, phase, remote_post_id FROM publishing_records WHERE id = ?').get(recordId) as any;
    assert.strictEqual(rec.status, 'published');
    assert.strictEqual(rec.remote_post_id, 'fb_existing_vid_999');
  });

  // -------------------------------------------------------------------------
  // Test 8: Uncertain Delivery Handling (Timeout after Publish Request)
  // -------------------------------------------------------------------------
  it('8. Uncertain delivery handling: network abort during publish marks status uncertain & enqueues reconcile job', async () => {
    const { recordId, jobId, reelId } = setupTestReel(igDestId);

    class MockTimeoutClient extends MetaClient {
      public override async checkTokenHealth() {
        return { id: 'u1', isValid: true };
      }

      public override async createInstagramContainer() {
        return { containerId: 'c_abort_123', uploadUri: 'https://mock/abort' };
      }

      public override async uploadBytes() {
        return { success: true, bytesTransferred: 1024 };
      }

      public override async pollInstagramContainerStatus() {
        return { statusCode: 'FINISHED' };
      }

      public override async publishInstagramContainer() {
        // Simulate network timeout or socket hangup after publish call was sent
        throw new MetaNetworkError('Connection reset by peer during publish request');
      }
    }

    const mockClient = new MockTimeoutClient();
    const publisher = new MetaPublisher(db, storage, mockClient);

    const job = queue.claimNextJob('w1', ['publish.instagram']);
    assert.ok(job);
    assert.strictEqual(job.id, jobId);

    const res = await publisher.publish(job, 'w1');
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.status, 'uncertain');

    const rec = db.prepare('SELECT status, phase, last_error_code FROM publishing_records WHERE id = ?').get(recordId) as any;
    assert.strictEqual(rec.status, 'uncertain');
    assert.strictEqual(rec.phase, 'publish_requested');
    assert.strictEqual(rec.last_error_code, 'UNCERTAIN_DELIVERY');

    // Verify automatic reconcile job was enqueued
    const reconcileJob = db
      .prepare("SELECT * FROM background_jobs WHERE type = 'reconcile.destination' AND reel_id = ?")
      .get(reelId) as any;
    assert.ok(reconcileJob, 'reconcile.destination job must be enqueued on uncertain outcome');
    assert.strictEqual(reconcileJob.priority, 10, 'Reconcile job should have high priority');
  });

  // -------------------------------------------------------------------------
  // Test 9: Automated Reconciliation via Recent Media Match
  // -------------------------------------------------------------------------
  it('9. Automated reconciliation: matches recent media and promotes uncertain destination to published', async () => {
    // Record is uncertain with publish_requested_at set
    const { recordId, reelId } = setupTestReel(igDestId, {
      phase: 'publish_requested',
      remoteContainerId: 'c_reconcile_match',
      enqueuePublishJob: false,
    });

    db.prepare(`
      UPDATE publishing_records
      SET status = 'uncertain',
          publish_requested_at = ?
      WHERE id = ?
    `).run(Date.now() - 60_000, recordId); // 1 minute ago

    // Enqueue reconcile job
    const reconJob = queue.enqueue({
      type: 'reconcile.destination',
      reelId,
      destinationId: igDestId,
      publishingRecordId: recordId,
      payload: { reelId, destinationId: igDestId, publishingRecordId: recordId },
      priority: 10,
    });

    class MockReconcileClient extends MetaClient {
      public override async getRecentInstagramMedia(igUserId: string) {
        // Return recent media with caption matching the test reel title ("My Awesome Reel")
        return [
          {
            id: 'media_reconciled_found',
            caption: 'My Awesome Reel\n\n#viral #reels',
            timestamp: new Date().toISOString(),
            permalink: 'https://instagram.com/reel/reconciled_found',
          },
        ];
      }
    }

    const reconciler = new MetaReconciler(db, new MockReconcileClient());
    const claimedJob = queue.claimNextJob('w1', ['reconcile.destination']);
    assert.ok(claimedJob);
    assert.strictEqual(claimedJob.id, reconJob.id);

    const reconRes = await reconciler.reconcile(claimedJob, 'w1');
    assert.strictEqual(reconRes.reconciled, true);
    assert.strictEqual(reconRes.outcome, 'published');
    assert.strictEqual(reconRes.postId, 'media_reconciled_found');

    // DB record should now be published with verified permalink
    const rec = db.prepare('SELECT status, phase, remote_post_id, remote_url FROM publishing_records WHERE id = ?').get(recordId) as any;
    assert.strictEqual(rec.status, 'published');
    assert.strictEqual(rec.phase, 'published');
    assert.strictEqual(rec.remote_post_id, 'media_reconciled_found');
    assert.strictEqual(rec.remote_url, 'https://instagram.com/reel/reconciled_found');
  });

  // -------------------------------------------------------------------------
  // Test 10: Destination Isolation (FR-016)
  // -------------------------------------------------------------------------
  it('10. Destination isolation (FR-016): Facebook failure does not affect or re-publish Instagram', async () => {
    // Single reel with BOTH Instagram and Facebook destinations
    const now = Date.now();
    const reelInfo = db
      .prepare(`
        INSERT INTO reels (public_id, original_filename, filename_stem, status, created_by, created_at, updated_at)
        VALUES ('reel_multi', 'multi.mp4', 'multi', 'ready', ?, ?, ?)
      `)
      .run(adminId, now, now);
    const reelId = Number(reelInfo.lastInsertRowid);

    // Video file
    const fileInfo = db
      .prepare(`
        INSERT INTO video_files (
          reel_id, role, storage_name, original_filename, size_bytes,
          sha256, duration_ms, width, height, state, validation_state, created_at, updated_at
        ) VALUES (?, 'censored', 'c_multi.mp4', 'c.mp4', 5000000, 'hash', 10000, 1080, 1920, 'present', 'valid', ?, ?)
      `)
      .run(reelId, now, now);
    const fileId = Number(fileInfo.lastInsertRowid);
    writeFileSync(join(TEST_STORAGE, 'videos', 'censored', 'c_multi.mp4'), Buffer.alloc(100));

    // Caption
    const capInfo = db
      .prepare(`
        INSERT INTO ai_content (
          reel_id, version, source, input_text, title, hashtags, status, approved_at, created_at, updated_at
        ) VALUES (?, 1, 'gemini', 'multi text', 'Multi', '["#tag1","#tag2"]', 'approved', ?, ?, ?)
      `)
      .run(reelId, now, now, now);
    const capId = Number(capInfo.lastInsertRowid);
    db.prepare('UPDATE reels SET approved_ai_content_id = ? WHERE id = ?').run(capId, reelId);

    // Record for IG
    const igRecInfo = db
      .prepare("INSERT INTO publishing_records (reel_id, destination_id, video_file_id, ai_content_id, status, idempotency_key, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', 'm-ig', ?, ?)")
      .run(reelId, igDestId, fileId, capId, now, now);
    const igRecId = Number(igRecInfo.lastInsertRowid);

    // Record for FB
    const fbRecInfo = db
      .prepare("INSERT INTO publishing_records (reel_id, destination_id, video_file_id, ai_content_id, status, idempotency_key, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', 'm-fb', ?, ?)")
      .run(reelId, fbDestId, fileId, capId, now, now);
    const fbRecId = Number(fbRecInfo.lastInsertRowid);

    // Enqueue jobs
    const jobIg = queue.enqueue({
      type: 'publish.instagram',
      reelId,
      destinationId: igDestId,
      publishingRecordId: igRecId,
      payload: { reelId, destinationId: igDestId, publishingRecordId: igRecId },
      priority: 50,
    });
    const jobFb = queue.enqueue({
      type: 'publish.facebook',
      reelId,
      destinationId: fbDestId,
      publishingRecordId: fbRecId,
      payload: { reelId, destinationId: fbDestId, publishingRecordId: fbRecId },
      priority: 50,
    });

    // Client where IG succeeds, but FB fails
    class SelectiveClient extends MetaClient {
      public override async checkTokenHealth() {
        return { id: 'u1', isValid: true };
      }
      public override async createInstagramContainer() {
        return { containerId: 'c_ig_isolated', uploadUri: 'https://mock/ig' };
      }
      public override async uploadBytes() {
        return { success: true, bytesTransferred: 100 };
      }
      public override async pollInstagramContainerStatus() {
        return { statusCode: 'FINISHED' };
      }
      public override async publishInstagramContainer() {
        return { mediaId: 'media_ig_isolated' };
      }
      public override async getInstagramPermalink() {
        return 'https://instagram.com/reel/isolated';
      }
      public override async startFacebookReelSession() {
        throw new Error('Facebook 500 internal server error');
      }
    }

    const publisher = new MetaPublisher(db, storage, new SelectiveClient());

    // 1. Publish Instagram
    const claimedIg = queue.claimNextJob('w1', ['publish.instagram']);
    assert.ok(claimedIg);
    assert.strictEqual(claimedIg.id, jobIg.id);
    const igRes = await publisher.publish(claimedIg, 'w1');
    assert.strictEqual(igRes.ok, true);
    assert.strictEqual(igRes.status, 'published');

    // 2. Publish Facebook
    const claimedFb = queue.claimNextJob('w1', ['publish.facebook']);
    assert.ok(claimedFb);
    assert.strictEqual(claimedFb.id, jobFb.id);
    const fbRes = await publisher.publish(claimedFb, 'w1');
    assert.strictEqual(fbRes.ok, false);
    assert.strictEqual(fbRes.status, 'failed_retryable');

    // 3. Inspect status of both destinations
    const recIg = db.prepare('SELECT status FROM publishing_records WHERE id = ?').get(igRecId) as any;
    const recFb = db.prepare('SELECT status FROM publishing_records WHERE id = ?').get(fbRecId) as any;

    assert.strictEqual(recIg.status, 'published', 'Instagram must be published');
    assert.strictEqual(recFb.status, 'failed_retryable', 'Facebook must be failed_retryable');

    // Reel aggregate state should be partial (one published, one failed)
    const reelRow = db.prepare('SELECT status FROM reels WHERE id = ?').get(reelId) as any;
    assert.strictEqual(reelRow.status, 'partially_published', 'Reel aggregate state must reflect partial failure');
  });

  // -------------------------------------------------------------------------
  // Test 11: Meta Token Auth Error (OAuth code 190)
  // -------------------------------------------------------------------------
  it('11. Token health & auth error: expired token marks destination paused & needs_auth without rapid retry', async () => {
    const { recordId, jobId } = setupTestReel(igDestId);

    class MockExpiredClient extends MetaClient {
      public override async checkTokenHealth() {
        throw new MetaAuthError('Error validating access token: Session has expired', {
          errorCode: 190,
          errorSubcode: 463,
          errorType: 'OAuthException',
        });
      }
    }

    const publisher = new MetaPublisher(db, storage, new MockExpiredClient());
    const job = queue.claimNextJob('w1', ['publish.instagram']);
    assert.ok(job);
    assert.strictEqual(job.id, jobId);

    const res = await publisher.publish(job, 'w1');
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.status, 'needs_auth');

    // Verify destination was paused
    const dest = db.prepare('SELECT paused, paused_reason FROM publishing_destinations WHERE id = ?').get(igDestId) as any;
    assert.strictEqual(dest.paused, 1);
    assert.ok(dest.paused_reason.includes('Needs re-authentication') || dest.paused_reason.includes('Needs authentication'));

    // Verify account status
    const acc = db.prepare('SELECT status FROM connected_accounts WHERE id = ?').get(metaAccountId) as any;
    assert.strictEqual(acc.status, 'needs_auth');

    // Verify notification was created
    const notif = db
      .prepare("SELECT * FROM notifications WHERE type = 'account_expired'")
      .get() as any;
    assert.ok(notif, 'account_expired notification must be created');

    // Verify job was finalized as failed and is not immediately re-claimed
    const subsequentJob = queue.claimNextJob('w1', ['publish.instagram']);
    assert.strictEqual(subsequentJob, null, 'Must NOT rapidly retry when authentication is needed');
  });

  // -------------------------------------------------------------------------
  // Test 12: WorkerPool End-to-End with Meta Destinations
  // -------------------------------------------------------------------------
  it('12. WorkerPool end-to-end: executes publish.instagram and publish.facebook background jobs', async () => {
    const igSetup = setupTestReel(igDestId);
    const fbSetup = setupTestReel(fbDestId);

    class MockWorkerMetaClient extends MetaClient {
      public override async checkTokenHealth() {
        return { id: 'u1', isValid: true };
      }
      public override async createInstagramContainer() {
        return { containerId: 'c_pool_ig', uploadUri: 'https://mock/pool/ig' };
      }
      public override async uploadBytes() {
        return { success: true, bytesTransferred: 1024 };
      }
      public override async pollInstagramContainerStatus() {
        return { statusCode: 'FINISHED' };
      }
      public override async publishInstagramContainer() {
        return { mediaId: 'media_pool_ig' };
      }
      public override async getInstagramPermalink() {
        return 'https://instagram.com/reel/pool';
      }
      public override async startFacebookReelSession() {
        return { videoId: 'vid_pool_fb', uploadUrl: 'https://mock/pool/fb' };
      }
      public override async finishFacebookReelSession() {
        return { success: true };
      }
      public override async pollFacebookReelStatus() {
        return { publishingStatus: 'complete', permalinkUrl: 'https://fb.com/reel/pool' };
      }
    }

    const mockClient = new MockWorkerMetaClient();
    const metaPublisher = new MetaPublisher(db, storage, mockClient);
    const metaReconciler = new MetaReconciler(db, mockClient);

    const pool = new WorkerPool(
      db,
      undefined,
      undefined,
      undefined,
      metaPublisher,
      metaReconciler,
    );

    // 1. Process Instagram
    const workedIg = await pool.pollAndWork(['publish.instagram']);
    assert.strictEqual(workedIg, true);

    const recIg = db.prepare('SELECT status FROM publishing_records WHERE id = ?').get(igSetup.recordId) as any;
    assert.strictEqual(recIg.status, 'published');

    // 2. Process Facebook
    const workedFb = await pool.pollAndWork(['publish.facebook']);
    assert.strictEqual(workedFb, true);

    const recFb = db.prepare('SELECT status FROM publishing_records WHERE id = ?').get(fbSetup.recordId) as any;
    assert.strictEqual(recFb.status, 'published');
  });
});
