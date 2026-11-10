import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { rmSync, mkdirSync, existsSync, writeFileSync, utimesSync } from 'node:fs';
import { openDatabase, closeDatabase } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrate.js';
import { StorageManager } from '../src/storage/StorageManager.js';
import { JobQueue, computeBackoff } from '../src/queue/JobQueue.js';
import { Scheduler, getNextSlotInstant } from '../src/scheduler/Scheduler.js';
import { RecoveryService } from '../src/queue/RecoveryService.js';
import { deriveReelStatus, recomputeAndSaveReelStatus } from '../src/reels/stateMachine.js';
import { SettingsService } from '../src/settings/SettingsService.js';

const TEST_DIR = join(process.cwd(), 'temp_test_m3');
const TEST_STORAGE = join(TEST_DIR, 'storage');
const TEST_DB_PATH = join(TEST_STORAGE, 'db', 'test_m3_reelhub.sqlite');

describe('M3 Job Queue, Scheduler, State Machine & Recovery Tests', () => {
  let db: ReturnType<typeof openDatabase>;
  let storage: StorageManager;
  let queue: JobQueue;
  let scheduler: Scheduler;
  let recovery: RecoveryService;
  let adminId: number;

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
    scheduler = new Scheduler(db);
    recovery = new RecoveryService(db, storage);

    // Seed admin user
    const now = Date.now();
    const adminInfo = db
      .prepare(`
        INSERT INTO admin_users (username, password_hash, created_at, updated_at)
        VALUES ('m3_admin', 'argon2id_hash_placeholder', ?, ?)
      `)
      .run(now, now);
    adminId = Number(adminInfo.lastInsertRowid);

    // Seed connected account and destinations
    const accInfo = db
      .prepare(`
        INSERT INTO connected_accounts (provider, display_name, external_id, auth_method, created_at, updated_at)
        VALUES ('meta', 'Test Meta Page', 'page_123', 'facebook_login', ?, ?)
      `)
      .run(now, now);
    const accountId = Number(accInfo.lastInsertRowid);

    // IG destination (censored)
    db.prepare(`
      INSERT INTO publishing_destinations (kind, account_id, label, target_id, video_role, created_at, updated_at)
      VALUES ('instagram', ?, 'IG Destination', 'ig_user_456', 'censored', ?, ?)
    `).run(accountId, now, now);

    // FB destination (censored)
    db.prepare(`
      INSERT INTO publishing_destinations (kind, account_id, label, target_id, video_role, created_at, updated_at)
      VALUES ('facebook', ?, 'FB Page Destination', 'page_123', 'censored', ?, ?)
    `).run(accountId, now, now);

    // TG destination (raw)
    const tgAccInfo = db
      .prepare(`
        INSERT INTO connected_accounts (provider, display_name, external_id, auth_method, created_at, updated_at)
        VALUES ('telegram', 'Test TG Bot', 'bot_789', 'bot_token', ?, ?)
      `)
      .run(now, now);
    const tgAccountId = Number(tgAccInfo.lastInsertRowid);

    db.prepare(`
      INSERT INTO publishing_destinations (kind, account_id, label, target_id, video_role, created_at, updated_at)
      VALUES ('telegram', ?, 'TG Channel', '-100123456789', 'raw', ?, ?)
    `).run(tgAccountId, now, now);
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
  // 1. Queue Concurrency & Atomic Claiming
  // -------------------------------------------------------------------------
  it('1. Atomic claiming: 10 concurrent simulated workers claiming 5 jobs results in exactly 5 distinct jobs and 0 duplicates', async () => {
    // Enqueue 5 jobs
    const jobIds: number[] = [];
    for (let i = 1; i <= 5; i++) {
      const job = queue.enqueue({
        type: 'ai.generate',
        payload: { testId: i },
        priority: 100,
      });
      assert.ok(job);
      jobIds.push(job.id);
    }

    // 10 workers race to claim
    const workers = Array.from({ length: 10 }, (_, i) => `worker-${i + 1}`);
    const claimedResults = await Promise.all(
      workers.map(async (workerId) => {
        // Short async tick to simulate concurrent event loop entries
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 5));
        return queue.claimNextJob(workerId, ['ai.generate']);
      }),
    );

    const nonNullClaims = claimedResults.filter((j): j is NonNullable<typeof j> => j !== null);

    // Exactly 5 jobs claimed
    assert.strictEqual(nonNullClaims.length, 5, 'Exactly 5 jobs should be claimed');

    // All claimed job IDs must be unique (0 duplicates!)
    const claimedIds = nonNullClaims.map((j) => j.id);
    const uniqueIds = new Set(claimedIds);
    assert.strictEqual(uniqueIds.size, 5, 'All claimed job IDs must be unique');

    // All 5 jobs must now be in 'leased' state
    for (const id of jobIds) {
      const row = queue.getJobById(id);
      assert.strictEqual(row?.state, 'leased');
      assert.ok(row.lease_owner);
      assert.strictEqual(row.attempts, 1);
    }
  });

  // -------------------------------------------------------------------------
  // 2. Fencing, Heartbeat & Lease Expiration
  // -------------------------------------------------------------------------
  it('2. Lease expiration and heartbeat: zombie worker is fenced after lease expiry', async () => {
    const job = queue.enqueue({
      type: 'browser.task',
      payload: { action: 'test' },
      priority: 50,
    });
    assert.ok(job);

    // Worker 1 claims with very short lease (50 ms)
    const claimed = queue.claimNextJob('worker-fast', ['browser.task'], 50);
    assert.ok(claimed);
    assert.strictEqual(claimed.id, job.id);

    // Heartbeat extends lease
    const hbSuccess = queue.heartbeat(job.id, 'worker-fast', 80);
    assert.strictEqual(hbSuccess, true);

    // Sleep past the lease expiration (120 ms)
    await new Promise((resolve) => setTimeout(resolve, 120));

    // Worker 2 should now be able to claim the expired job!
    const reclaimed = queue.claimNextJob('worker-slow', ['browser.task'], 10_000);
    assert.ok(reclaimed);
    assert.strictEqual(reclaimed.id, job.id);
    assert.strictEqual(reclaimed.lease_owner, 'worker-slow');
    assert.strictEqual(reclaimed.attempts, 2);

    // Worker 1 (zombie) tries to checkpoint: MUST FAIL (fenced!)
    const zombieCheckpoint = queue.checkpoint(job.id, 'worker-fast', { step: 1 });
    assert.strictEqual(zombieCheckpoint, false, 'Zombie worker checkpoint must be fenced');

    // Worker 1 (zombie) tries to finalize: MUST FAIL (fenced!)
    const zombieFinalize = queue.finalizeJob(job.id, 'worker-fast', 'succeeded');
    assert.strictEqual(zombieFinalize, false, 'Zombie worker finalize must be fenced');

    // Worker 2 finalizes successfully
    const legitFinalize = queue.finalizeJob(job.id, 'worker-slow', 'succeeded');
    assert.strictEqual(legitFinalize, true, 'Legit worker finalize must succeed');

    const finalJob = queue.getJobById(job.id);
    assert.strictEqual(finalJob?.state, 'succeeded');
    assert.strictEqual(finalJob?.lease_owner, null);
  });

  // -------------------------------------------------------------------------
  // 3. Exponential Backoff and Dead Parking
  // -------------------------------------------------------------------------
  it('3. Exponential backoff delays progression and parks as dead after max attempts', () => {
    // Test computeBackoff values
    const b1 = computeBackoff(1);
    assert.ok(b1 >= 48_000 && b1 <= 72_000, 'Attempt 1 backoff is ~1m');

    const b2 = computeBackoff(2);
    assert.ok(b2 >= 240_000 && b2 <= 360_000, 'Attempt 2 backoff is ~5m');

    const b3 = computeBackoff(3);
    assert.ok(b3 >= 720_000 && b3 <= 1_080_000, 'Attempt 3 backoff is ~15m');

    const b4 = computeBackoff(4);
    assert.ok(b4 >= 2_880_000 && b4 <= 4_320_000, 'Attempt 4 backoff is ~1h');

    // Enqueue job with max_attempts = 3 for fast testing
    const job = queue.enqueue({
      type: 'notify.dispatch',
      payload: { channel: 'test' },
      maxAttempts: 3,
    });
    assert.ok(job);

    // Attempt 1 fails
    let c = queue.claimNextJob('w1', ['notify.dispatch']);
    assert.ok(c);
    queue.finalizeJob(c.id, 'w1', 'failed', { code: 'ERR_1', message: 'Fail 1' });

    let j = queue.getJobById(job.id);
    assert.strictEqual(j?.state, 'queued');
    assert.strictEqual(j?.attempts, 1);
    assert.ok(j.run_at > Date.now());

    // Force run_at = now so it can be claimed for attempt 2
    db.prepare('UPDATE background_jobs SET run_at = ? WHERE id = ?').run(Date.now() - 1000, job.id);

    // Attempt 2 fails
    c = queue.claimNextJob('w1', ['notify.dispatch']);
    assert.ok(c);
    queue.finalizeJob(c.id, 'w1', 'failed', { code: 'ERR_2', message: 'Fail 2' });

    j = queue.getJobById(job.id);
    assert.strictEqual(j?.state, 'queued');
    assert.strictEqual(j?.attempts, 2);

    // Force run_at = now so it can be claimed for attempt 3
    db.prepare('UPDATE background_jobs SET run_at = ? WHERE id = ?').run(Date.now() - 1000, job.id);

    // Attempt 3 fails -> reaches max_attempts (3) -> parks as DEAD
    c = queue.claimNextJob('w1', ['notify.dispatch']);
    assert.ok(c);
    queue.finalizeJob(c.id, 'w1', 'failed', { code: 'ERR_FATAL', message: 'Final fail' });

    j = queue.getJobById(job.id);
    assert.strictEqual(j?.state, 'dead');
    assert.strictEqual(j?.attempts, 3);
    assert.strictEqual(j?.last_error_code, 'ERR_FATAL');

    // Manual retry resets dead job
    const retrySuccess = queue.manualRetry(job.id);
    assert.strictEqual(retrySuccess, true);

    j = queue.getJobById(job.id);
    assert.strictEqual(j?.state, 'queued');
    assert.strictEqual(j?.attempts, 0);
  });

  // -------------------------------------------------------------------------
  // 4. File Locking During Execution (FR-005)
  // -------------------------------------------------------------------------
  it('4. File locking prevents concurrent processing and unlocks on finalize', () => {
    const now = Date.now();
    // Create reel and video file
    const rInfo = db
      .prepare(`
        INSERT INTO reels (public_id, original_filename, filename_stem, created_by, created_at, updated_at)
        VALUES ('test_reel_lock', 'video.mp4', 'video', ?, ?, ?)
      `)
      .run(adminId, now, now);
    const reelId = Number(rInfo.lastInsertRowid);

    const fInfo = db
      .prepare(`
        INSERT INTO video_files (reel_id, role, storage_name, original_filename, size_bytes, sha256, state, created_at, updated_at)
        VALUES (?, 'censored', 'lock_test.mp4', 'video.mp4', 1024, 'dummy_sha', 'present', ?, ?)
      `)
      .run(reelId, now, now);
    const fileId = Number(fInfo.lastInsertRowid);

    // Enqueue job 1 and job 2
    const j1 = queue.enqueue({ type: 'publish.instagram', reelId });
    const j2 = queue.enqueue({ type: 'publish.facebook', reelId });
    assert.ok(j1 && j2);

    const c1 = queue.claimNextJob('worker-lock-1', ['publish.instagram']);
    assert.ok(c1);

    // Job 1 acquires file lock
    const lock1 = queue.acquireFileLock(c1.id, fileId);
    assert.strictEqual(lock1, true, 'Job 1 should acquire file lock');

    // Check lock state
    const fileRow = db.prepare('SELECT in_use_by_job_id FROM video_files WHERE id = ?').get(fileId) as {
      in_use_by_job_id: number | null;
    };
    assert.strictEqual(fileRow.in_use_by_job_id, c1.id);

    // Job 2 tries to acquire lock on same file: MUST FAIL
    const lock2 = queue.acquireFileLock(j2.id, fileId);
    assert.strictEqual(lock2, false, 'Job 2 must fail to acquire lock on locked file');

    // Finalize job 1: file lock must be automatically released
    queue.finalizeJob(c1.id, 'worker-lock-1', 'succeeded');

    const fileRowAfter = db
      .prepare('SELECT in_use_by_job_id FROM video_files WHERE id = ?')
      .get(fileId) as { in_use_by_job_id: number | null };
    assert.strictEqual(fileRowAfter.in_use_by_job_id, null, 'File lock must be released on finalize');
  });

  // -------------------------------------------------------------------------
  // 5. State Machine: Aggregate Reel Status Derivation
  // -------------------------------------------------------------------------
  it('5. State Machine: computes all aggregate Reel status transitions correctly', () => {
    const now = Date.now();
    const rInfo = db
      .prepare(`
        INSERT INTO reels (public_id, original_filename, filename_stem, status, created_by, created_at, updated_at)
        VALUES ('reel_sm_test', 'clip.mp4', 'clip', 'draft', ?, ?, ?)
      `)
      .run(adminId, now, now);
    const reelId = Number(rInfo.lastInsertRowid);

    // Initial state: draft (no files)
    assert.strictEqual(deriveReelStatus(db, reelId), 'draft');

    // Upload censored file: waiting_for_ai
    const cInfo = db
      .prepare(`
        INSERT INTO video_files (reel_id, role, storage_name, original_filename, size_bytes, sha256, validation_state, state, created_at, updated_at)
        VALUES (?, 'censored', 'sm_censored.mp4', 'clip_c.mp4', 1000, 'sha_c', 'valid', 'present', ?, ?)
      `)
      .run(reelId, now, now);
    const censoredFileId = Number(cInfo.lastInsertRowid);
    assert.strictEqual(deriveReelStatus(db, reelId), 'waiting_for_ai');

    // Upload raw file + approve caption: ready
    const rFInfo = db
      .prepare(`
        INSERT INTO video_files (reel_id, role, storage_name, original_filename, size_bytes, sha256, validation_state, state, created_at, updated_at)
        VALUES (?, 'raw', 'sm_raw.mp4', 'clip_r.mp4', 1000, 'sha_r', 'valid', 'present', ?, ?)
      `)
      .run(reelId, now, now);
    const rawFileId = Number(rFInfo.lastInsertRowid);

    const capInfo = db
      .prepare(`
        INSERT INTO ai_content (reel_id, version, source, input_text, title, hashtags, status, created_at, updated_at)
        VALUES (?, 1, 'gemini', 'clip', 'A Great Video Caption', '["#viral","#reels"]', 'approved', ?, ?)
      `)
      .run(reelId, now, now);
    const captionId = Number(capInfo.lastInsertRowid);

    db.prepare('UPDATE reels SET approved_ai_content_id = ? WHERE id = ?').run(captionId, reelId);
    assert.strictEqual(deriveReelStatus(db, reelId), 'ready');

    // Add scheduled_job: scheduled
    db.prepare(`
      INSERT INTO scheduled_jobs (reel_id, scheduled_for, source, status, created_at, updated_at)
      VALUES (?, ?, 'custom', 'pending', ?, ?)
    `).run(reelId, now + 100_000, now, now);
    assert.strictEqual(deriveReelStatus(db, reelId), 'scheduled');

    // Cancel scheduled_job: reverts to ready
    db.prepare("UPDATE scheduled_jobs SET status = 'cancelled' WHERE reel_id = ?").run(reelId);
    assert.strictEqual(deriveReelStatus(db, reelId), 'ready');

    // Add publishing records: 1 queued -> publishing
    const igDest = db.prepare("SELECT id FROM publishing_destinations WHERE kind = 'instagram'").get() as { id: number };
    const fbDest = db.prepare("SELECT id FROM publishing_destinations WHERE kind = 'facebook'").get() as { id: number };

    db.prepare(`
      INSERT INTO publishing_records (reel_id, destination_id, video_file_id, ai_content_id, status, idempotency_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'queued', 'sm_key_ig', ?, ?)
    `).run(reelId, igDest.id, censoredFileId, captionId, now, now);

    db.prepare(`
      INSERT INTO publishing_records (reel_id, destination_id, video_file_id, ai_content_id, status, idempotency_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'queued', 'sm_key_fb', ?, ?)
    `).run(reelId, fbDest.id, censoredFileId, captionId, now, now);

    assert.strictEqual(deriveReelStatus(db, reelId), 'publishing');

    // One published, one failed_retryable -> partially_published
    db.prepare("UPDATE publishing_records SET status = 'published' WHERE destination_id = ? AND reel_id = ?").run(igDest.id, reelId);
    db.prepare("UPDATE publishing_records SET status = 'failed_retryable' WHERE destination_id = ? AND reel_id = ?").run(fbDest.id, reelId);
    assert.strictEqual(deriveReelStatus(db, reelId), 'partially_published');

    // Both published -> completed
    db.prepare("UPDATE publishing_records SET status = 'published' WHERE destination_id = ? AND reel_id = ?").run(fbDest.id, reelId);
    assert.strictEqual(deriveReelStatus(db, reelId), 'completed');

    // Recompute and persist saves to DB
    const finalStatus = recomputeAndSaveReelStatus(db, reelId);
    assert.strictEqual(finalStatus, 'completed');

    const updatedReel = db.prepare('SELECT status, completed_at FROM reels WHERE id = ?').get(reelId) as {
      status: string;
      completed_at: number | null;
    };
    assert.strictEqual(updatedReel.status, 'completed');
    assert.ok(updatedReel.completed_at !== null);
  });

  // -------------------------------------------------------------------------
  // 6. Schedule Slots & Timezone Math
  // -------------------------------------------------------------------------
  it('6. Schedule slots CRUD and getNextSlotInstant Asia/Kolkata instant calculation', () => {
    // Create slot at 18:00 IST
    const slot = scheduler.createSlot({
      label: 'Evening Peak',
      localTime: '18:00',
      weekdayMask: 127,
      timezone: 'Asia/Kolkata',
      capacity: 1,
    });

    assert.ok(slot.id);
    assert.strictEqual(slot.label, 'Evening Peak');
    assert.strictEqual(slot.local_time, '18:00');

    // Compute next slot instant from a reference time
    const fromTime = Date.now();
    const nextInstant = getNextSlotInstant(slot, fromTime);

    assert.ok(nextInstant > fromTime, 'Next instant must be in the future');

    // Verify time in Asia/Kolkata timezone corresponds to 18:00
    const istTimeStr = new Date(nextInstant).toLocaleTimeString('en-US', {
      timeZone: 'Asia/Kolkata',
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
    });
    assert.strictEqual(istTimeStr, '18:00');

    // Update slot
    const updated = scheduler.updateSlot(slot.id, { label: 'Updated Evening Peak', capacity: 2 });
    assert.strictEqual(updated.label, 'Updated Evening Peak');
    assert.strictEqual(updated.capacity, 2);

    // List slots
    const slots = scheduler.getSlots();
    assert.ok(slots.some((s) => s.id === slot.id));
  });

  // -------------------------------------------------------------------------
  // 7. Scheduling Reel & Conflict Detection
  // -------------------------------------------------------------------------
  it('7. Scheduling Reel for a slot and detecting min_gap_seconds conflict', () => {
    const now = Date.now();
    // Create ready reel
    const rInfo = db
      .prepare(`
        INSERT INTO reels (public_id, original_filename, filename_stem, status, created_by, created_at, updated_at)
        VALUES ('reel_sched_test', 'sched.mp4', 'sched', 'ready', ?, ?, ?)
      `)
      .run(adminId, now, now);
    const reelId = Number(rInfo.lastInsertRowid);

    const capInfo = db
      .prepare(`
        INSERT INTO ai_content (reel_id, version, source, input_text, title, hashtags, status, created_at, updated_at)
        VALUES (?, 1, 'manual', 'sched', 'Sched Video', '["#tag1","#tag2"]', 'approved', ?, ?)
      `)
      .run(reelId, now, now);
    db.prepare('UPDATE reels SET approved_ai_content_id = ? WHERE id = ?').run(capInfo.lastInsertRowid, reelId);

    // Add video files so reel can be ready
    db.prepare(`
      INSERT INTO video_files (reel_id, role, storage_name, original_filename, size_bytes, sha256, validation_state, state, created_at, updated_at)
      VALUES (?, 'censored', 'sched_c.mp4', 'sched_c.mp4', 1000, 'sha_sc', 'valid', 'present', ?, ?)
    `).run(reelId, now, now);

    db.prepare(`
      INSERT INTO video_files (reel_id, role, storage_name, original_filename, size_bytes, sha256, validation_state, state, created_at, updated_at)
      VALUES (?, 'raw', 'sched_r.mp4', 'sched_r.mp4', 1000, 'sha_sr', 'valid', 'present', ?, ?)
    `).run(reelId, now, now);

    // Add slot
    const slot = scheduler.createSlot({
      label: 'Morning Slot',
      localTime: '10:00',
      capacity: 1,
    });

    // Schedule reel
    const scheduledJobs = scheduler.scheduleReel(reelId, { slotId: slot.id });
    assert.strictEqual(scheduledJobs.length, 1);
    assert.strictEqual(scheduledJobs[0]!.status, 'pending');

    const reelRow = db.prepare('SELECT status FROM reels WHERE id = ?').get(reelId) as { status: string };
    assert.strictEqual(reelRow.status, 'scheduled');

    // Unschedule reel
    scheduler.unscheduleReel(reelId);

    const unreelRow = db.prepare('SELECT status FROM reels WHERE id = ?').get(reelId) as { status: string };
    assert.strictEqual(unreelRow.status, 'ready');
  });

  // -------------------------------------------------------------------------
  // 8. Auto-Assign Ready Reels
  // -------------------------------------------------------------------------
  it('8. Auto-assign assigns ready Reels to earliest available slots respecting capacity', () => {
    const now = Date.now();
    // Create 2 ready reels
    const createReadyReel = (name: string) => {
      const rInfo = db
        .prepare(`
          INSERT INTO reels (public_id, original_filename, filename_stem, status, created_by, created_at, updated_at)
          VALUES (?, ?, ?, 'ready', ?, ?, ?)
        `)
        .run(`auto_${name}`, `${name}.mp4`, name, adminId, now, now);
      const id = Number(rInfo.lastInsertRowid);

      const capInfo = db
        .prepare(`
          INSERT INTO ai_content (reel_id, version, source, input_text, title, hashtags, status, created_at, updated_at)
          VALUES (?, 1, 'manual', ?, 'Auto Reel Caption', '["#a1","#a2"]', 'approved', ?, ?)
        `)
        .run(id, name, now, now);
      db.prepare('UPDATE reels SET approved_ai_content_id = ? WHERE id = ?').run(capInfo.lastInsertRowid, id);
      return id;
    };

    const r1 = createReadyReel('r1');
    const r2 = createReadyReel('r2');

    // Clear old slots and add test slot with capacity 1
    db.prepare('DELETE FROM schedule_slots').run();
    scheduler.createSlot({
      label: 'Slot 14:00',
      localTime: '14:00',
      capacity: 1,
    });

    const assignedCount = scheduler.autoAssignReadyReels();
    assert.ok(assignedCount >= 2, 'Ready reels should be assigned');

    // Check their scheduled_jobs
    const s1 = db.prepare("SELECT scheduled_for FROM scheduled_jobs WHERE reel_id = ? AND status = 'pending'").get(r1) as { scheduled_for: number };
    const s2 = db.prepare("SELECT scheduled_for FROM scheduled_jobs WHERE reel_id = ? AND status = 'pending'").get(r2) as { scheduled_for: number };

    assert.ok(s1 && s2);
    // Since capacity is 1, s2 must be scheduled at a later slot instant than s1!
    assert.notStrictEqual(s1.scheduled_for, s2.scheduled_for, 'Second reel must be placed in a subsequent slot instant');
  });

  // -------------------------------------------------------------------------
  // 9. Scheduler Tick Loop & Promotion
  // -------------------------------------------------------------------------
  it('9. Scheduler tick promotes due scheduled jobs into background_jobs with dedupe keys', () => {
    const now = Date.now();
    // Create reel with both video files and approved caption
    const rInfo = db
      .prepare(`
        INSERT INTO reels (public_id, original_filename, filename_stem, status, created_by, created_at, updated_at)
        VALUES ('reel_tick_test', 'tick.mp4', 'tick', 'ready', ?, ?, ?)
      `)
      .run(adminId, now, now);
    const reelId = Number(rInfo.lastInsertRowid);

    // Files
    db.prepare(`
      INSERT INTO video_files (reel_id, role, storage_name, original_filename, size_bytes, sha256, validation_state, state, created_at, updated_at)
      VALUES (?, 'censored', 'tick_c.mp4', 'tick.mp4', 1000, 'sha_c', 'valid', 'present', ?, ?)
    `).run(reelId, now, now);

    db.prepare(`
      INSERT INTO video_files (reel_id, role, storage_name, original_filename, size_bytes, sha256, validation_state, state, created_at, updated_at)
      VALUES (?, 'raw', 'tick_r.mp4', 'tick.mp4', 1000, 'sha_r', 'valid', 'present', ?, ?)
    `).run(reelId, now, now);

    const capInfo = db
      .prepare(`
        INSERT INTO ai_content (reel_id, version, source, input_text, title, hashtags, status, created_at, updated_at)
        VALUES (?, 1, 'manual', 'tick', 'Tick Reel Caption', '["#tick1","#tick2"]', 'approved', ?, ?)
      `)
      .run(reelId, now, now);
    db.prepare('UPDATE reels SET approved_ai_content_id = ? WHERE id = ?').run(capInfo.lastInsertRowid, reelId);

    // Create a due scheduled job (scheduled_for in the past)
    const pastTime = now - 10_000;
    const schedInfo = db
      .prepare(`
        INSERT INTO scheduled_jobs (reel_id, scheduled_for, source, status, created_at, updated_at)
        VALUES (?, ?, 'custom', 'pending', ?, ?)
      `)
      .run(reelId, pastTime, now, now);
    const schedJobId = Number(schedInfo.lastInsertRowid);

    // Run scheduler tick
    scheduler.tick();

    // The scheduled job should now be 'promoted'
    const schedRow = db.prepare('SELECT status, promoted_at FROM scheduled_jobs WHERE id = ?').get(schedJobId) as {
      status: string;
      promoted_at: number | null;
    };
    assert.strictEqual(schedRow.status, 'promoted');
    assert.ok(schedRow.promoted_at !== null);

    // Background jobs should have been enqueued for destinations (IG, FB, TG)
    const bgJobs = db.prepare('SELECT * FROM background_jobs WHERE reel_id = ?').all(reelId) as Array<{
      id: number;
      type: string;
      dedupe_key: string;
      state: string;
    }>;
    assert.ok(bgJobs.length >= 3, 'Jobs should be created for enabled destinations');

    // Dedupe keys should follow format publish:<reel>:<dest>:<time>
    for (const j of bgJobs) {
      assert.ok(j.dedupe_key.startsWith(`publish:${reelId}:`));
      assert.strictEqual(j.state, 'queued');
    }

    // Repeated tick should not create duplicate background jobs
    const countBefore = bgJobs.length;
    scheduler.tick();
    const countAfter = db.prepare('SELECT COUNT(*) as c FROM background_jobs WHERE reel_id = ?').get(reelId) as { c: number };
    assert.strictEqual(countAfter.c, countBefore, 'Repeated tick must not create duplicate jobs');
  });

  // -------------------------------------------------------------------------
  // 10. Missed-Schedule Recovery Policy (PRD 9.5 / FR-012)
  // -------------------------------------------------------------------------
  it('10. Missed schedule recovery: job overdue > 2 hours is marked missed and moved to next slot', () => {
    const now = Date.now();
    const rInfo = db
      .prepare(`
        INSERT INTO reels (public_id, original_filename, filename_stem, status, created_by, created_at, updated_at)
        VALUES ('reel_missed_test', 'missed.mp4', 'missed', 'ready', ?, ?, ?)
      `)
      .run(adminId, now, now);
    const reelId = Number(rInfo.lastInsertRowid);

    const capInfo = db
      .prepare(`
        INSERT INTO ai_content (reel_id, version, source, input_text, title, hashtags, status, created_at, updated_at)
        VALUES (?, 1, 'manual', 'missed', 'Missed Reel Caption', '["#m1","#m2"]', 'approved', ?, ?)
      `)
      .run(reelId, now, now);
    db.prepare('UPDATE reels SET approved_ai_content_id = ? WHERE id = ?').run(capInfo.lastInsertRowid, reelId);

    const slot = scheduler.createSlot({ label: 'Missed Slot', localTime: '11:00' });

    // Job scheduled 3 hours ago (> 2 hours!)
    const threeHoursAgo = now - 3 * 3600 * 1000;
    const schedInfo = db
      .prepare(`
        INSERT INTO scheduled_jobs (reel_id, slot_id, scheduled_for, source, status, created_at, updated_at)
        VALUES (?, ?, ?, 'slot', 'pending', ?, ?)
      `)
      .run(reelId, slot.id, threeHoursAgo, now, now);
    const schedId = Number(schedInfo.lastInsertRowid);

    // Run tick
    scheduler.tick();

    // Check that job was marked 'missed' with action 'moved_next'
    const schedRow = db.prepare('SELECT status, missed_action FROM scheduled_jobs WHERE id = ?').get(schedId) as {
      status: string;
      missed_action: string;
    };
    assert.strictEqual(schedRow.status, 'missed');
    assert.strictEqual(schedRow.missed_action, 'moved_next');

    // A replacement scheduled_job should have been created for the next slot
    const replacement = db
      .prepare("SELECT * FROM scheduled_jobs WHERE reel_id = ? AND status = 'pending'")
      .get(reelId) as { id: number; scheduled_for: number } | undefined;
    assert.ok(replacement, 'Replacement scheduled job must be created');
    assert.ok(replacement.scheduled_for > now);
  });

  // -------------------------------------------------------------------------
  // 11. Crash & Restart Recovery Service (PRD 19.6 / NFR-001)
  // -------------------------------------------------------------------------
  it('11. Crash recovery sweep recovers expired leases by phase, reconciles uncertain, and clears dead locks', () => {
    const now = Date.now();

    // Case A: Pre-publish phase (upload_started) with expired lease -> should re-queue
    const jobA = queue.enqueue({ type: 'publish.instagram' });
    assert.ok(jobA);
    db.prepare(`
      UPDATE background_jobs
      SET state = 'running', lease_owner = 'dead_worker_A', lease_expires_at = ?
      WHERE id = ?
    `).run(now - 10_000, jobA.id);

    // Create publishing record in phase 'upload_started'
    const recA = db.prepare(`
      INSERT INTO publishing_records (reel_id, destination_id, video_file_id, ai_content_id, status, phase, idempotency_key, created_at, updated_at)
      VALUES (1, 1, 1, 1, 'in_progress', 'upload_started', 'rec_A', ?, ?)
    `).run(now, now);
    db.prepare('UPDATE background_jobs SET publishing_record_id = ? WHERE id = ?').run(recA.lastInsertRowid, jobA.id);

    // Case B: In-flight publish request (phase='publish_requested') with expired lease -> uncertain + reconcile job!
    const jobB = queue.enqueue({ type: 'publish.facebook' });
    assert.ok(jobB);
    db.prepare(`
      UPDATE background_jobs
      SET state = 'running', lease_owner = 'dead_worker_B', lease_expires_at = ?
      WHERE id = ?
    `).run(now - 10_000, jobB.id);

    const recB = db.prepare(`
      INSERT INTO publishing_records (reel_id, destination_id, video_file_id, ai_content_id, status, phase, idempotency_key, created_at, updated_at)
      VALUES (1, 2, 1, 1, 'in_progress', 'publish_requested', 'rec_B', ?, ?)
    `).run(now, now);
    db.prepare('UPDATE background_jobs SET publishing_record_id = ? WHERE id = ?').run(recB.lastInsertRowid, jobB.id);

    // Case C: Stale file lock from a dead job
    const deadJob = queue.enqueue({ type: 'browser.task' });
    assert.ok(deadJob);
    db.prepare("UPDATE background_jobs SET state = 'dead' WHERE id = ?").run(deadJob.id);
    db.prepare('UPDATE video_files SET in_use_by_job_id = ? WHERE id = 1').run(deadJob.id);

    // Case D: Old temp file (> 24 hours)
    const tempDir = storage.getRoleDirectory('temp');
    const oldTempFile = join(tempDir, 'old_orphan.tmp');
    writeFileSync(oldTempFile, 'old temp bytes');
    const pastTime = new Date(now - 25 * 3600 * 1000);
    utimesSync(oldTempFile, pastTime, pastTime);

    // Run recovery sweep
    const summary = recovery.performStartupRecovery();
    assert.strictEqual(summary.ok, true);
    assert.strictEqual(summary.integrityPassed, true);
    assert.ok(summary.recoveredJobsCount >= 2);
    assert.ok(summary.clearedLocksCount >= 1);
    assert.ok(summary.purgedTempFiles >= 1);

    // Verify Case A: returned to queued
    const recoveredA = queue.getJobById(jobA.id);
    assert.strictEqual(recoveredA?.state, 'queued');

    // Verify Case B: marked uncertain and reconcile job enqueued
    const recRowB = db.prepare('SELECT status FROM publishing_records WHERE id = ?').get(recB.lastInsertRowid) as { status: string };
    assert.strictEqual(recRowB.status, 'uncertain');

    const reconcileJob = db.prepare("SELECT * FROM background_jobs WHERE type = 'reconcile.destination'").get() as { id: number; priority: number } | undefined;
    assert.ok(reconcileJob, 'reconcile.destination job must be enqueued for uncertain publish');
    assert.strictEqual(reconcileJob.priority, 50);

    // Verify Case C: lock cleared
    const fileRow = db.prepare('SELECT in_use_by_job_id FROM video_files WHERE id = 1').get() as { in_use_by_job_id: number | null };
    assert.strictEqual(fileRow.in_use_by_job_id, null, 'Stale file lock must be cleared');

    // Verify Case D: old temp file removed
    assert.strictEqual(existsSync(oldTempFile), false, 'Old temp file must be purged');
  });

  // -------------------------------------------------------------------------
  // 12. Automation Pause and Resume
  // -------------------------------------------------------------------------
  it('12. Global automation pause stops job claiming and promotion until resumed', () => {
    // Enqueue a job
    const job = queue.enqueue({ type: 'ai.generate', priority: 10 });
    assert.ok(job);

    // Pause automation
    const now = Date.now();
    db.prepare(`
      INSERT INTO application_settings (key, value, is_secret, updated_at)
      VALUES ('automation_paused', 'true', 0, ?)
      ON CONFLICT(key) DO UPDATE SET value = 'true', updated_at = ?
    `).run(now, now);

    // Claim should return null
    const claimedWhilePaused = queue.claimNextJob('worker-p', ['ai.generate']);
    assert.strictEqual(claimedWhilePaused, null, 'No jobs may be claimed while automation is paused');

    // Resume automation
    db.prepare(`
      UPDATE application_settings SET value = 'false', updated_at = ? WHERE key = 'automation_paused'
    `).run(now);

    // Claim should now succeed
    const claimedAfterResume = queue.claimNextJob('worker-p', ['ai.generate']);
    assert.ok(claimedAfterResume, 'Claim must succeed after automation is resumed');
    assert.strictEqual(claimedAfterResume.id, job.id);
  });
});
