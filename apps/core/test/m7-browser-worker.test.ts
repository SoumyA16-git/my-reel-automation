import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { BrowserWorkerClient } from '../src/browser/BrowserWorkerClient.js';
import { app as workerApp, browserManager } from '../../browser-worker/src/index.js';

describe('M7 Browser Worker Integration & IPC Tests', () => {
  let workerBaseUrl: string;
  const TEST_SECRET = 'test-browser-worker-secret-xyz';

  before(async () => {
    process.env['BROWSER_WORKER_SECRET'] = TEST_SECRET;
    process.env['NODE_ENV'] = 'test';

    // Start worker on an ephemeral port
    const address = await workerApp.listen({ port: 0, host: '127.0.0.1' });
    workerBaseUrl = address;
  });

  after(async () => {
    await browserManager.close();
    await workerApp.close();
  });

  it('1. GET /health is accessible without bearer token', async () => {
    const client = new BrowserWorkerClient(workerBaseUrl, undefined);
    const health = await client.checkHealth();

    assert.ok(health.worker.includes('browser-worker'));
    assert.strictEqual(typeof health.timestamp, 'number');
  });

  it('2. POST /tasks rejects requests with missing or invalid bearer token (401)', async () => {
    // Client with no secret
    const unauthClient = new BrowserWorkerClient(workerBaseUrl, '');
    const res = await unauthClient.verifyPermalink('https://instagram.com/reel/123');

    assert.strictEqual(res.ok, false);
    assert.ok(res.error?.includes('401') || res.error?.includes('Unauthorized'));

    // Client with wrong secret
    const badClient = new BrowserWorkerClient(workerBaseUrl, 'wrong-secret');
    const resBad = await badClient.verifyPermalink('https://instagram.com/reel/123');

    assert.strictEqual(resBad.ok, false);
    assert.ok(resBad.error?.includes('401') || resBad.error?.includes('Unauthorized'));
  });

  it('3. POST /tasks validates required parameters', async () => {
    const client = new BrowserWorkerClient(workerBaseUrl, TEST_SECRET);

    // Call without required url
    const resMissing = await client.verifyPermalink('');
    assert.strictEqual(resMissing.ok, false);
    assert.ok(resMissing.error?.includes('params.url is required'));

    // Call without profileUrl
    const resMissingProfile = await client.reconcileFeed('', 'prefix');
    assert.strictEqual(resMissingProfile.ok, false);
    assert.ok(resMissingProfile.error?.includes('params.profileUrl is required'));
  });

  it('4. Health Ping task executes via BrowserWorkerClient', async () => {
    const client = new BrowserWorkerClient(workerBaseUrl, TEST_SECRET);
    const res = await fetch(`${workerBaseUrl}/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TEST_SECRET}`,
      },
      body: JSON.stringify({
        taskType: 'health_ping',
      }),
    });

    assert.strictEqual(res.status, 200);
    const body = (await res.json()) as any;
    assert.strictEqual(body.taskType, 'health_ping');
  });

  it('5. Unreachable worker returns safe fallback object without crashing', async () => {
    const deadClient = new BrowserWorkerClient('http://127.0.0.1:59999', TEST_SECRET);
    const health = await deadClient.checkHealth(1000);

    assert.strictEqual(health.status, 'unreachable');
    assert.strictEqual(health.browserOk, false);
    assert.ok(health.error);
  });
});
