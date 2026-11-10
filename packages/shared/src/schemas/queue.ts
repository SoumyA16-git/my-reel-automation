import { z } from 'zod';
import { JobStateSchema, JobTypeSchema } from './reel.js';

// ---------------------------------------------------------------------------
// Background Job
// ---------------------------------------------------------------------------
export const BackgroundJobSchema = z.object({
  id: z.number().int().positive(),
  type: JobTypeSchema,
  dedupeKey: z.string().nullable().optional(),
  reelId: z.number().int().positive().nullable().optional(),
  destinationId: z.number().int().positive().nullable().optional(),
  publishingRecordId: z.number().int().positive().nullable().optional(),
  payload: z.record(z.unknown()),
  state: JobStateSchema,
  priority: z.number().int().default(100),
  runAt: z.number().int().positive(), // UTC epoch ms
  attempts: z.number().int().default(0),
  maxAttempts: z.number().int().default(5),
  leaseOwner: z.string().nullable().optional(),
  leaseExpiresAt: z.number().int().nullable().optional(),
  heartbeatAt: z.number().int().nullable().optional(),
  startedAt: z.number().int().nullable().optional(),
  finishedAt: z.number().int().nullable().optional(),
  cancelRequested: z.boolean().default(false),
  lastErrorCode: z.string().nullable().optional(),
  lastErrorMessage: z.string().nullable().optional(),
  createdBy: z.enum(['scheduler', 'admin', 'system']).default('system'),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type BackgroundJob = z.infer<typeof BackgroundJobSchema>;

export const EnqueueJobInputSchema = z.object({
  type: JobTypeSchema,
  dedupeKey: z.string().optional(),
  reelId: z.number().int().positive().optional(),
  destinationId: z.number().int().positive().optional(),
  publishingRecordId: z.number().int().positive().optional(),
  payload: z.record(z.unknown()).default({}),
  priority: z.number().int().default(100),
  runAt: z.number().int().positive().optional(), // Defaults to Date.now()
  maxAttempts: z.number().int().default(5),
  createdBy: z.enum(['scheduler', 'admin', 'system']).default('system'),
});
export type EnqueueJobInput = z.infer<typeof EnqueueJobInputSchema>;

export const ListJobsQuerySchema = z.object({
  state: JobStateSchema.optional(),
  type: JobTypeSchema.optional(),
  reelId: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListJobsQuery = z.infer<typeof ListJobsQuerySchema>;

// ---------------------------------------------------------------------------
// Automation State
// ---------------------------------------------------------------------------
export const AutomationStatusSchema = z.object({
  paused: z.boolean(),
  pausedReason: z.string().nullable().optional(),
  pausedAt: z.number().int().nullable().optional(),
  activeWorkers: z.number().int().default(0),
  queuedJobs: z.number().int().default(0),
  runningJobs: z.number().int().default(0),
});
export type AutomationStatus = z.infer<typeof AutomationStatusSchema>;

