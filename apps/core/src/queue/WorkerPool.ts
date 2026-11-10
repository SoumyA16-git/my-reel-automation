import type { Database } from 'better-sqlite3';
import { getDatabase } from '../db/connection.js';
import { JobQueue, type JobRow } from './JobQueue.js';
import { TelegramPublisher } from '../publishers/telegram/TelegramPublisher.js';
import { TelegramReconciler } from '../publishers/telegram/TelegramReconciler.js';
import { MetaPublisher } from '../publishers/meta/MetaPublisher.js';
import { MetaReconciler } from '../publishers/meta/MetaReconciler.js';
import { RawFileDeletionService } from '../storage/RawFileDeletionService.js';
import { logger } from '../logger.js';

export class WorkerPool {
  private readonly db: Database;
  private readonly queue: JobQueue;
  private readonly telegramPublisher: TelegramPublisher;
  private readonly telegramReconciler: TelegramReconciler;
  private readonly metaPublisher: MetaPublisher;
  private readonly metaReconciler: MetaReconciler;
  private readonly rawDeletionService: RawFileDeletionService;
  private isPolling = false;
  private pollTimer: NodeJS.Timeout | null = null;
  public readonly workerId: string;

  constructor(
    db?: Database,
    telegramPublisher?: TelegramPublisher,
    telegramReconciler?: TelegramReconciler,
    rawDeletionService?: RawFileDeletionService,
    metaPublisher?: MetaPublisher,
    metaReconciler?: MetaReconciler,
  ) {
    this.db = db ?? getDatabase();
    this.queue = new JobQueue(this.db);
    this.telegramPublisher = telegramPublisher ?? new TelegramPublisher(this.db);
    this.telegramReconciler = telegramReconciler ?? new TelegramReconciler(this.db);
    this.rawDeletionService = rawDeletionService ?? new RawFileDeletionService(this.db);
    this.metaPublisher = metaPublisher ?? new MetaPublisher(this.db);
    this.metaReconciler = metaReconciler ?? new MetaReconciler(this.db);
    this.workerId = `core-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * Execute a single background job by its type.
   * Manages start, heartbeat, execution, and finalization.
   */
  public async executeJob(job: JobRow): Promise<void> {
    logger.info({ jobId: job.id, type: job.type, workerId: this.workerId }, 'Worker executing job');

    // Mark job as running
    this.queue.startJob(job.id, this.workerId);

    // Start 30s heartbeat timer
    const heartbeatTimer = setInterval(() => {
      const ok = this.queue.heartbeat(job.id, this.workerId, 60_000);
      if (!ok) {
        logger.warn({ jobId: job.id }, 'Worker lost lease during heartbeat; job was fenced');
      }
    }, 30_000);
    heartbeatTimer.unref();

    try {
      if (job.type === 'publish.telegram') {
        await this.telegramPublisher.publish(job, this.workerId);
      } else if (job.type === 'publish.instagram' || job.type === 'publish.facebook') {
        await this.metaPublisher.publish(job, this.workerId);
      } else if (job.type === 'file.delete_raw') {
        const payload = JSON.parse(job.payload || '{}') as { videoFileId?: number };
        if (!payload.videoFileId) {
          throw new Error('file.delete_raw payload missing videoFileId');
        }

        const result = this.rawDeletionService.deleteRawFile(payload.videoFileId, job.id);
        if (result.ok) {
          this.queue.finalizeJob(job.id, this.workerId, 'succeeded');
        } else if (result.outcome === 'failed') {
          this.queue.finalizeJob(job.id, this.workerId, 'failed', {
            code: 'DELETION_FAILED',
            message: result.error ?? 'Unlink failed',
          });
        } else {
          // Refused due to precondition (e.g. lease active) -> retry later
          this.queue.finalizeJob(job.id, this.workerId, 'failed', {
            code: 'DELETION_REFUSED',
            message: result.reason ?? 'Precondition not met',
          });
        }
      } else if (job.type === 'reconcile.destination') {
        if (job.destination_id) {
          const dest = this.db
            .prepare<[number]>('SELECT kind FROM publishing_destinations WHERE id = ?')
            .get(job.destination_id) as { kind: string } | undefined;
          if (dest && (dest.kind === 'instagram' || dest.kind === 'facebook')) {
            await this.metaReconciler.reconcile(job, this.workerId);
          } else {
            await this.telegramReconciler.reconcile(job, this.workerId);
          }
        } else {
          await this.telegramReconciler.reconcile(job, this.workerId);
        }
      } else {
        logger.warn({ type: job.type, jobId: job.id }, 'Unhandled job type; finalizing as succeeded');
        this.queue.finalizeJob(job.id, this.workerId, 'succeeded');
      }
    } catch (err) {
      logger.error({ err, jobId: job.id, type: job.type }, 'Error during job execution');
      this.queue.finalizeJob(job.id, this.workerId, 'failed', {
        code: 'EXECUTION_ERROR',
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      clearInterval(heartbeatTimer);
    }
  }

  /**
   * Run one polling iteration to claim and process an eligible job.
   */
  public async pollAndWork(supportedTypes?: string[]): Promise<boolean> {
    const job = this.queue.claimNextJob(this.workerId, supportedTypes);
    if (!job) return false;

    await this.executeJob(job);
    return true;
  }

  /**
   * Start worker loop polling every intervalMs (default 2000 ms).
   */
  public start(intervalMs = 2000, supportedTypes?: string[]): void {
    if (this.pollTimer !== null) return;

    this.pollTimer = setInterval(async () => {
      if (this.isPolling) return;
      this.isPolling = true;
      try {
        await this.pollAndWork(supportedTypes);
      } catch (err) {
        logger.error({ err }, 'Worker poll error');
      } finally {
        this.isPolling = false;
      }
    }, intervalMs);

    logger.info({ workerId: this.workerId, intervalMs }, 'Worker pool loop started');
  }

  /**
   * Stop worker loop.
   */
  public stop(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
      logger.info({ workerId: this.workerId }, 'Worker pool loop stopped');
    }
  }
}
