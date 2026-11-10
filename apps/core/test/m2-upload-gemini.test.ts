import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { rmSync, mkdirSync, existsSync, createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { openDatabase, closeDatabase } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrate.js';
import { StorageManager, initStorageManager } from '../src/storage/StorageManager.js';
import { initSettingsService } from '../src/settings/SettingsService.js';
import { initAuditService } from '../src/audit/AuditService.js';
import { initNotificationService } from '../src/notifications/NotificationService.js';
import { initGeminiService } from '../src/ai/gemini.js';
import { ReelService, initReelService } from '../src/reels/ReelService.js';
import { cleanFilenameForAi, GeminiOutputSchema } from '../src/ai/gemini.js';
import { probeVideo } from '../src/media/probe.js';
import { validateVideo, checkVideoMagicBytes } from '../src/media/validate.js';

const TEST_DIR = join(process.cwd(), 'temp_test_m2');
const TEST_STORAGE = join(TEST_DIR, 'storage');
const TEST_DB_PATH = join(TEST_STORAGE, 'db', 'test_reelhub_m2.sqlite');
const SYNTHETIC_VIDEO_PATH = join(TEST_DIR, 'sample_720p.mp4');
const SYNTHETIC_LOWRES_PATH = join(TEST_DIR, 'sample_360p.mp4');

describe('M2 Upload & Gemini Pipeline Tests', () => {
  let db: ReturnType<typeof openDatabase>;
  let storage: StorageManager;
  let reelService: ReelService;
  let adminId: number;

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

    const settings = initSettingsService(db);
    settings.seedDefaults();
    initAuditService(db);
    initNotificationService(db);
    initGeminiService(db);
    reelService = initReelService(db, storage);

    // Create an admin user for foreign key
    const now = Date.now();
    const adminRes = db
      .prepare('INSERT INTO admin_users (username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('m2admin', 'dummy', now, now);
    adminId = adminRes.lastInsertRowid as number;

    // Generate synthetic MP4 videos using ffmpeg for probe and validation tests
    // 720p valid video (720x1280 vertical)
    execFileSync('ffmpeg', [
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=2:size=720x1280:rate=30',
      '-pix_fmt',
      'yuv420p',
      '-y',
      SYNTHETIC_VIDEO_PATH,
    ]);

    // Lowres video (< 540p for Facebook block test)
    execFileSync('ffmpeg', [
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=2:size=360x360:rate=30',
      '-pix_fmt',
      'yuv420p',
      '-y',
      SYNTHETIC_LOWRES_PATH,
    ]);
  });

  after(() => {
    closeDatabase();
    try {
      rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  // -------------------------------------------------------------------------
  // 1. Filename cleaning & Gemini output schema (PRD Section 8)
  // -------------------------------------------------------------------------

  it('FR-006: cleanFilenameForAi performs deterministic cleaning', () => {
    assert.strictEqual(
      cleanFilenameForAi('abandoned_hospital_ghost_sighting_001.mp4'),
      'abandoned hospital ghost sighting',
    );
    assert.strictEqual(
      cleanFilenameForAi('crazy-stunts-v2-final.mov'),
      'crazy stunts',
    );
    assert.strictEqual(
      cleanFilenameForAi('my_cool_video_99.mp4'),
      'my cool video',
    );
  });

  it('FR-006: GeminiOutputSchema validates contract strictly', () => {
    // Valid output
    const valid = GeminiOutputSchema.safeParse({
      title: 'Exploring the Abandoned Ghost Hospital at Night',
      hashtags: ['#AbandonedPlaces', '#UrbanExploring'],
    });
    assert.strictEqual(valid.success, true);

    // Title too short (< 20 chars)
    const tooShort = GeminiOutputSchema.safeParse({
      title: 'Ghost video',
      hashtags: ['#Ghost', '#Night'],
    });
    assert.strictEqual(tooShort.success, false);

    // Title with hashtag
    const titleWithHashtag = GeminiOutputSchema.safeParse({
      title: 'Amazing stunt video #crazy in the city',
      hashtags: ['#Stunts', '#City'],
    });
    assert.strictEqual(titleWithHashtag.success, false);

    // Non-unique hashtags
    const duplicateTags = GeminiOutputSchema.safeParse({
      title: 'Amazing stunt video without hashtags in title',
      hashtags: ['#Stunts', '#stunts'],
    });
    assert.strictEqual(duplicateTags.success, false);

    // Not exactly 2 hashtags
    const threeTags = GeminiOutputSchema.safeParse({
      title: 'Amazing stunt video without hashtags in title',
      hashtags: ['#One', '#Two', '#Three'],
    });
    assert.strictEqual(threeTags.success, false);
  });

  // -------------------------------------------------------------------------
  // 2. ffprobe metadata probe & validation rules (PRD Section 7.2)
  // -------------------------------------------------------------------------

  it('FR-002: probeVideo extracts container, resolution, duration, and frame rate', async () => {
    const meta = await probeVideo(SYNTHETIC_VIDEO_PATH);
    assert.strictEqual(meta.width, 720);
    assert.strictEqual(meta.height, 1280);
    assert.ok(meta.durationMs >= 1900 && meta.durationMs <= 2100, 'Duration should be ~2000 ms');
    assert.strictEqual(meta.fpsMilli, 30000);
    assert.strictEqual(meta.videoCodec, 'h264');
  });

  it('FR-002: Magic bytes detection verifies MP4 container', () => {
    assert.strictEqual(checkVideoMagicBytes(SYNTHETIC_VIDEO_PATH), true);
  });

  it('FR-002: validateVideo blocks censored file below 540p resolution', async () => {
    const lowresMeta = await probeVideo(SYNTHETIC_LOWRES_PATH);
    const result = validateVideo(SYNTHETIC_LOWRES_PATH, 'lowres.mp4', lowresMeta, {
      role: 'censored',
    });
    assert.strictEqual(result.state, 'invalid');
    assert.ok(
      result.errors.some((e) => e.includes('Facebook minimum 540p')),
      'Should report Facebook 540p minimum failure',
    );
  });

  // -------------------------------------------------------------------------
  // 3. Reel management lifecycle & Ready Gate (FR-001, FR-004, FR-005)
  // -------------------------------------------------------------------------

  it('FR-001, FR-004: Uploading both files and approving caption achieves Ready state', async () => {
    try {
      // 1. Create draft Reel
      const reel = reelService.createDraft({
        originalFilename: 'abandoned_hospital_001.mp4',
        createdBy: adminId,
      });
      assert.strictEqual(reel.status, 'draft');

      // 2. Upload censored video
      const stream1 = createReadStream(SYNTHETIC_VIDEO_PATH);
      const { videoFile: censoredFile } = await reelService.uploadFile({
        reelId: reel.id,
        role: 'censored',
        originalFilename: 'abandoned_hospital_censored.mp4',
        stream: stream1,
      });
      assert.strictEqual(censoredFile.role, 'censored');
      assert.strictEqual(censoredFile.state, 'present');

      // Reel should still be 'draft' because raw file is missing
      const afterCensored = reelService.getReelById(reel.id);
      assert.strictEqual(afterCensored?.status, 'draft');

      // 3. Upload raw video
      const stream2 = createReadStream(SYNTHETIC_VIDEO_PATH);
      const { videoFile: rawFile } = await reelService.uploadFile({
        reelId: reel.id,
        role: 'raw',
        originalFilename: 'abandoned_hospital_raw.mp4',
        stream: stream2,
      });
      assert.strictEqual(rawFile.role, 'raw');
      assert.strictEqual(rawFile.state, 'present');

      // Reel should now be waiting_for_ai because both files are valid
      const afterRaw = reelService.getReelById(reel.id);
      assert.strictEqual(afterRaw?.status, 'waiting_for_ai');

      // 4. Add caption
      const caption = reelService.addManualCaption(
        reel.id,
        'Exploring the Haunted Abandoned Hospital Grounds',
        ['#Haunted', '#GhostHunter'],
      );
      assert.strictEqual(caption.status, 'edited');

      // 5. Approve caption -> Ready Gate check (FR-004)
      const approveResult = reelService.approveCaption(reel.id, caption.version);
      assert.strictEqual(approveResult.success, true);
      assert.strictEqual(approveResult.reelStatus, 'ready');

      const finalReel = reelService.getReelById(reel.id);
      assert.strictEqual(finalReel?.status, 'ready');
      assert.strictEqual(finalReel?.approved_ai_content_id, caption.id);
    } catch (err) {
      console.error('DEBUG ERROR IN FR-001 TEST:', err);
      throw err;
    }
  });

  it('FR-005: File replacement is refused when file is locked by a publishing job', async () => {
    const reel = reelService.createDraft({
      originalFilename: 'test_locking.mp4',
      createdBy: adminId,
    });

    const stream = createReadStream(SYNTHETIC_VIDEO_PATH);
    const { videoFile } = await reelService.uploadFile({
      reelId: reel.id,
      role: 'censored',
      originalFilename: 'test_locking.mp4',
      stream,
    });

    // Insert a real background_job to satisfy foreign key constraint
    const now = Date.now();
    const jobRes = db
      .prepare(
        "INSERT INTO background_jobs (type, run_at, created_at, updated_at) VALUES ('publish.instagram', ?, ?, ?)",
      )
      .run(now, now, now);
    const jobId = jobRes.lastInsertRowid as number;

    // Simulate active job lease on the file
    db.prepare('UPDATE video_files SET in_use_by_job_id = ? WHERE id = ?').run(jobId, videoFile.id);

    // Attempting replacement must throw / be refused before touching the stream
    const replaceStream = Readable.from([]);
    await assert.rejects(
      async () => {
        await reelService.uploadFile({
          reelId: reel.id,
          role: 'censored',
          originalFilename: 'test_locking_v2.mp4',
          stream: replaceStream,
        });
      },
      /file is currently in use/i,
      'Must reject replacement while file is locked',
    );
  });
});
