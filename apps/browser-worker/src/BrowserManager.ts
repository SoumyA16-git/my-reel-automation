import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export interface BrowserTaskResult<T = any> {
  ok: boolean;
  data?: T;
  error?: string;
  screenshotPath?: string;
  durationMs: number;
}

export class BrowserManager {
  private browser: Browser | null = null;
  private isLaunching = false;
  private readonly screenshotDir: string;
  private activeTasksCount = 0;
  private readonly maxConcurrentTasks = 2;

  constructor(screenshotDir?: string) {
    this.screenshotDir =
      screenshotDir ||
      process.env['BROWSER_DEBUG_DIR'] ||
      join(process.cwd(), 'temp', 'browser_debug');

    if (!existsSync(this.screenshotDir)) {
      try {
        mkdirSync(this.screenshotDir, { recursive: true });
      } catch {
        // ignore if read-only or in testing
      }
    }
  }

  /**
   * Lazily launches or returns existing Chromium browser instance.
   */
  public async getBrowser(): Promise<Browser> {
    if (this.browser && this.browser.isConnected()) {
      return this.browser;
    }

    if (this.isLaunching) {
      while (this.isLaunching) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (this.browser && this.browser.isConnected()) {
        return this.browser;
      }
    }

    this.isLaunching = true;
    try {
      this.browser = await chromium.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--no-first-run',
          '--no-zygote',
          '--single-process',
        ],
      });
      return this.browser;
    } finally {
      this.isLaunching = false;
    }
  }

  /**
   * Executes a task inside an isolated context and page with auto-cleanup and screenshot-on-error.
   */
  public async runTask<T>(
    taskName: string,
    taskId: string,
    taskFn: (page: Page) => Promise<T>,
    timeoutMs = 30_000,
  ): Promise<BrowserTaskResult<T>> {
    if (this.activeTasksCount >= this.maxConcurrentTasks) {
      return {
        ok: false,
        error: `Worker busy: max concurrent tasks (${this.maxConcurrentTasks}) reached`,
        durationMs: 0,
      };
    }

    this.activeTasksCount++;
    const startTime = Date.now();
    let browser: Browser;
    try {
      browser = await this.getBrowser();
    } catch (err: any) {
      this.activeTasksCount--;
      return {
        ok: false,
        error: `Failed to launch browser: ${err.message}`,
        durationMs: Date.now() - startTime,
      };
    }

    let context: BrowserContext | null = null;
    let page: Page | null = null;
    let screenshotPath: string | undefined;

    try {
      context = await browser.newContext({
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        viewport: { width: 1280, height: 720 },
      });
      page = await context.newPage();
      page.setDefaultTimeout(timeoutMs);

      // Race with timeout
      const resultPromise = taskFn(page);
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Task '${taskName}' timed out after ${timeoutMs}ms`)), timeoutMs),
      );

      const data = await Promise.race([resultPromise, timeoutPromise]);

      return {
        ok: true,
        data,
        durationMs: Date.now() - startTime,
      };
    } catch (err: any) {
      // Capture screenshot if page is still open
      if (page && !page.isClosed()) {
        try {
          const filename = `${taskId}_${Date.now()}.png`;
          const target = join(this.screenshotDir, filename);
          await page.screenshot({ path: target, fullPage: true });
          screenshotPath = target;
        } catch {
          // Ignore screenshot error
        }
      }

      return {
        ok: false,
        error: err.message || String(err),
        ...(screenshotPath ? { screenshotPath } : {}),
        durationMs: Date.now() - startTime,
      };
    } finally {
      this.activeTasksCount--;
      if (page && !page.isClosed()) {
        await page.close().catch(() => {});
      }
      if (context) {
        await context.close().catch(() => {});
      }
    }
  }

  /**
   * Health ping: checks if browser can launch and open blank page.
   */
  public async healthPing(): Promise<{ ok: boolean; memoryMb: number; error?: string }> {
    const mem = Math.round(process.memoryUsage().rss / (1024 * 1024));
    try {
      const res = await this.runTask('health_ping', 'ping', async (page) => {
        await page.goto('about:blank');
        return true;
      }, 10_000);

      return {
        ok: res.ok,
        memoryMb: mem,
        ...(res.error ? { error: res.error } : {}),
      };
    } catch (err: any) {
      return {
        ok: false,
        memoryMb: mem,
        error: err.message,
      };
    }
  }

  /**
   * Graceful close of Chromium instance.
   */
  public async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
  }
}
