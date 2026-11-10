import fastify from 'fastify';
import { BrowserManager } from './BrowserManager.js';

const app = fastify({
  logger: process.env['NODE_ENV'] !== 'test',
});

const browserManager = new BrowserManager();

// Security: Verify bearer token for internal API
app.addHook('onRequest', async (request, reply) => {
  if (request.url === '/health') return;

  const secret = process.env['BROWSER_WORKER_SECRET'];
  if (secret) {
    const authHeader = request.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (token !== secret) {
      return reply.status(401).send({ error: 'Unauthorized: invalid worker secret' });
    }
  }
});

// Health check endpoint
app.get('/health', async (_request, reply) => {
  const ping = await browserManager.healthPing();
  return reply.send({
    status: ping.ok ? 'ok' : 'degraded',
    worker: 'reelhub-browser-worker',
    memoryMb: ping.memoryMb,
    browserOk: ping.ok,
    error: ping.error,
    timestamp: Date.now(),
  });
});

export interface TaskRequestBody {
  taskId?: string;
  taskType: 'verify_permalink' | 'reconcile_feed' | 'health_ping';
  params?: {
    url?: string;
    profileUrl?: string;
    captionPrefix?: string;
  };
  timeoutMs?: number;
}

// Task execution endpoint
app.post<{ Body: TaskRequestBody }>('/tasks', async (request, reply) => {
  const { taskId = `task_${Date.now()}`, taskType, params = {}, timeoutMs = 25_000 } = request.body || {};

  if (!taskType) {
    return reply.status(400).send({ error: 'Bad Request', message: 'taskType is required' });
  }

  if (taskType === 'health_ping') {
    const ping = await browserManager.healthPing();
    return reply.send({
      ok: ping.ok,
      taskType,
      data: { memoryMb: ping.memoryMb },
      error: ping.error,
    });
  }

  if (taskType === 'verify_permalink') {
    const url = params.url;
    if (!url) {
      return reply.status(400).send({ error: 'Bad Request', message: 'params.url is required for verify_permalink' });
    }

    const result = await browserManager.runTask(
      'verify_permalink',
      taskId,
      async (page) => {
        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
        const httpStatus = response?.status() ?? 200;

        if (httpStatus === 404) {
          return { exists: false, reason: 'http_404', httpStatus };
        }

        const pageTitle = await page.title();
        const pageContent = await page.innerText('body').catch(() => '');

        const isNotFound =
          pageContent.includes("Sorry, this page isn't available") ||
          pageContent.includes('Page Not Found') ||
          pageContent.includes('This content isn\'t available right now');

        if (isNotFound) {
          return { exists: false, reason: 'content_unavailable', pageTitle, httpStatus };
        }

        let matchesCaption = false;
        if (params.captionPrefix) {
          matchesCaption = pageContent.toLowerCase().includes(params.captionPrefix.toLowerCase());
        }

        return {
          exists: true,
          url,
          pageTitle,
          matchesCaption: params.captionPrefix ? matchesCaption : undefined,
          httpStatus,
        };
      },
      timeoutMs,
    );

    return reply.send(result);
  }

  if (taskType === 'reconcile_feed') {
    const profileUrl = params.profileUrl;
    if (!profileUrl) {
      return reply.status(400).send({ error: 'Bad Request', message: 'params.profileUrl is required for reconcile_feed' });
    }

    const result = await browserManager.runTask(
      'reconcile_feed',
      taskId,
      async (page) => {
        await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
        const bodyText = await page.innerText('body').catch(() => '');

        let matched = false;
        if (params.captionPrefix) {
          matched = bodyText.toLowerCase().includes(params.captionPrefix.toLowerCase());
        }

        return {
          reconciled: matched,
          profileUrl,
        };
      },
      timeoutMs,
    );

    return reply.send(result);
  }

  return reply.status(400).send({
    error: 'Unsupported task type',
    message: `Unknown taskType: ${taskType}`,
  });
});

const PORT = parseInt(process.env['PORT'] ?? '4000', 10);
const HOST = process.env['HOST'] ?? '0.0.0.0';

if (process.env['NODE_ENV'] !== 'test') {
  app.listen({ port: PORT, host: HOST }, (err, address) => {
    if (err) {
      app.log.error(err);
      process.exit(1);
    }
    app.log.info(`Browser worker listening at ${address}`);
  });
}

// Graceful shutdown
const shutdown = async () => {
  await browserManager.close();
  await app.close();
};

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

export { app, browserManager };
