import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { rmSync, mkdirSync, existsSync } from 'node:fs';
import { openDatabase, closeDatabase } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrate.js';
import { initStorageManager, StorageManager } from '../src/storage/StorageManager.js';
import { initSettingsService } from '../src/settings/SettingsService.js';
import { initAuditService } from '../src/audit/AuditService.js';
import { initNotificationService } from '../src/notifications/NotificationService.js';
import { initGeminiService } from '../src/ai/gemini.js';
import { initReelService } from '../src/reels/ReelService.js';
import { eventBus, type ReelHubEvent } from '../src/events/EventBus.js';
import { buildApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';

const TEST_DIR = join(process.cwd(), 'temp_test_m6');
const TEST_STORAGE = join(TEST_DIR, 'storage');
const TEST_DB_PATH = join(TEST_STORAGE, 'db', 'test_reelhub_m6.sqlite');

describe('M6 Dashboard & Event Bus Integration Tests', () => {
  let db: ReturnType<typeof openDatabase>;
  let storage: StorageManager;
  let app: FastifyInstance;

  before(async () => {
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
    initReelService(db, storage);

    // Build fastify app with static serving enabled
    app = await buildApp({ db, storage, serveStatic: true });
    await app.ready();
  });

  after(async () => {
    await app.close();
    closeDatabase();
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it('1. EventBus singleton dispatches and registers typed events', () => {
    let receivedPayload: any = null;
    const unsubscribe = eventBus.onEvent((e: ReelHubEvent) => {
      if (e.event === 'reel.status_changed') {
        receivedPayload = e.data;
      }
    });

    eventBus.emitReelStatusChanged(42, 'published', 'ready');

    assert.ok(receivedPayload);
    assert.strictEqual(receivedPayload.reelId, 42);
    assert.strictEqual(receivedPayload.newStatus, 'published');
    assert.strictEqual(receivedPayload.oldStatus, 'ready');

    unsubscribe();
  });

  it('2. EventBus dispatches notification and destination status events', () => {
    const receivedEvents: string[] = [];

    const unsubscribe = eventBus.onEvent((e) => {
      receivedEvents.push(e.event);
    });

    eventBus.emitNotificationCreated({
      id: 99,
      type: 'quota_warning',
      severity: 'warning',
      title: 'Quota close to limit',
      createdAt: Date.now(),
    });

    eventBus.emitDestinationStatusChanged(5, 'instagram', 'IG Main', 'active', true);

    eventBus.emitFileDeleted(101, 42, 'raw');

    assert.ok(receivedEvents.includes('notification.created'));
    assert.ok(receivedEvents.includes('destination.status_changed'));
    assert.ok(receivedEvents.includes('file.deleted'));

    unsubscribe();
  });

  it('3. SPA Static Serving: serves index.html on root / and client routes', async () => {
    const resRoot = await app.inject({
      method: 'GET',
      url: '/',
    });

    assert.strictEqual(resRoot.statusCode, 200);
    assert.ok(resRoot.headers['content-type']?.includes('text/html'));
    assert.ok(resRoot.payload.includes('<div id="root">'));
    assert.ok(resRoot.payload.includes('ReelHub'));

    // Client-side SPA routing fallback (e.g. /reels, /schedule)
    const resRoute = await app.inject({
      method: 'GET',
      url: '/reels',
    });

    assert.strictEqual(resRoute.statusCode, 200);
    assert.ok(resRoute.headers['content-type']?.includes('text/html'));
    assert.ok(resRoute.payload.includes('<div id="root">'));
  });

  it('4. API Routes return 404 JSON for non-existent API endpoints (not HTML)', async () => {
    const resApi = await app.inject({
      method: 'GET',
      url: '/api/v1/nonexistent_endpoint',
    });

    assert.strictEqual(resApi.statusCode, 404);
    assert.ok(resApi.headers['content-type']?.includes('application/json'));
    const body = JSON.parse(resApi.payload);
    assert.strictEqual(body.code, 'NOT_FOUND');
  });

  it('5. EventBus listeners clean up properly without leaking memory', () => {
    const beforeCount = eventBus.listenerCount('event');

    const unsub1 = eventBus.onEvent(() => {});
    const unsub2 = eventBus.onEvent(() => {});
    assert.strictEqual(eventBus.listenerCount('event'), beforeCount + 2);

    unsub1();
    assert.strictEqual(eventBus.listenerCount('event'), beforeCount + 1);

    unsub2();
    assert.strictEqual(eventBus.listenerCount('event'), beforeCount);
  });
});
