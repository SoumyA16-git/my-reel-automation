import { logger } from '../logger.js';

export interface BrowserHealthResponse {
  status: string;
  worker: string;
  memoryMb?: number;
  browserOk: boolean;
  error?: string;
  timestamp: number;
}

export interface VerifyPermalinkResult {
  ok: boolean;
  data?: {
    exists: boolean;
    url?: string;
    pageTitle?: string;
    matchesCaption?: boolean;
    httpStatus?: number;
    reason?: string;
  };
  error?: string;
  screenshotPath?: string;
  durationMs: number;
}

export interface ReconcileFeedResult {
  ok: boolean;
  data?: {
    reconciled: boolean;
    profileUrl?: string;
  };
  error?: string;
  durationMs: number;
}

export class BrowserWorkerClient {
  private readonly baseUrl: string;
  private readonly workerSecret: string | null;

  constructor(baseUrl?: string, workerSecret?: string) {
    this.baseUrl = (baseUrl || process.env['BROWSER_WORKER_URL'] || 'http://127.0.0.1:4000').replace(/\/$/, '');
    this.workerSecret = workerSecret !== undefined ? workerSecret : (process.env['BROWSER_WORKER_SECRET'] || null);
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (this.workerSecret) {
      headers['Authorization'] = `Bearer ${this.workerSecret}`;
    }
    return headers;
  }

  /**
   * Check if the browser worker container/service is running and ready.
   */
  public async checkHealth(timeoutMs = 5000): Promise<BrowserHealthResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(`${this.baseUrl}/health`, {
        method: 'GET',
        headers: this.getHeaders(),
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new Error(`Browser worker returned status ${res.status}`);
      }

      return (await res.json()) as BrowserHealthResponse;
    } catch (err: any) {
      logger.warn({ err: err.message, url: this.baseUrl }, 'Browser worker health check failed');
      return {
        status: 'unreachable',
        worker: 'reelhub-browser-worker',
        browserOk: false,
        error: err.message,
        timestamp: Date.now(),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Dispatches a verify_permalink task to verify an IG or FB reel post permalink.
   */
  public async verifyPermalink(
    url: string,
    expectedCaptionPrefix?: string,
    timeoutMs = 25_000,
  ): Promise<VerifyPermalinkResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs + 5000);

    try {
      const taskId = `verify_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const res = await fetch(`${this.baseUrl}/tasks`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({
          taskId,
          taskType: 'verify_permalink',
          params: {
            url,
            captionPrefix: expectedCaptionPrefix,
          },
          timeoutMs,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Browser worker task failed (${res.status}): ${body}`);
      }

      return (await res.json()) as VerifyPermalinkResult;
    } catch (err: any) {
      logger.error({ err: err.message, url }, 'verifyPermalink error in browser client');
      return {
        ok: false,
        error: err.message,
        durationMs: 0,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Dispatches a reconcile_feed task to check a profile feed for matching caption text.
   */
  public async reconcileFeed(
    profileUrl: string,
    captionPrefix: string,
    timeoutMs = 25_000,
  ): Promise<ReconcileFeedResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs + 5000);

    try {
      const taskId = `reconcile_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const res = await fetch(`${this.baseUrl}/tasks`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({
          taskId,
          taskType: 'reconcile_feed',
          params: {
            profileUrl,
            captionPrefix,
          },
          timeoutMs,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Browser worker feed reconcile failed (${res.status}): ${body}`);
      }

      return (await res.json()) as ReconcileFeedResult;
    } catch (err: any) {
      logger.error({ err: err.message, profileUrl }, 'reconcileFeed error in browser client');
      return {
        ok: false,
        error: err.message,
        durationMs: 0,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
