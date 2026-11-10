import { z } from 'zod';

// ---------------------------------------------------------------------------
// Reel status
// ---------------------------------------------------------------------------
export const ReelStatusSchema = z.enum([
  'draft',
  'uploading',
  'waiting_for_ai',
  'ready',
  'scheduled',
  'publishing',
  'partially_published',
  'completed',
  'failed',
  'paused',
  'cancelled',
]);
export type ReelStatus = z.infer<typeof ReelStatusSchema>;

// ---------------------------------------------------------------------------
// Video file role
// ---------------------------------------------------------------------------
export const VideoRoleSchema = z.enum(['censored', 'raw']);
export type VideoRole = z.infer<typeof VideoRoleSchema>;

// ---------------------------------------------------------------------------
// Video file validation state
// ---------------------------------------------------------------------------
export const ValidationStateSchema = z.enum(['pending', 'valid', 'warning', 'invalid']);
export type ValidationState = z.infer<typeof ValidationStateSchema>;

// ---------------------------------------------------------------------------
// Video file state
// ---------------------------------------------------------------------------
export const VideoFileStateSchema = z.enum([
  'uploading',
  'present',
  'quarantined',
  'deleted',
  'deletion_failed',
  'missing',
]);
export type VideoFileState = z.infer<typeof VideoFileStateSchema>;

// ---------------------------------------------------------------------------
// Publishing destination kind
// ---------------------------------------------------------------------------
export const DestinationKindSchema = z.enum(['instagram', 'facebook', 'telegram']);
export type DestinationKind = z.infer<typeof DestinationKindSchema>;

// ---------------------------------------------------------------------------
// Publishing record status
// ---------------------------------------------------------------------------
export const PublishingStatusSchema = z.enum([
  'pending',
  'queued',
  'in_progress',
  'processing_remote',
  'verifying',
  'published',
  'failed_retryable',
  'needs_auth',
  'needs_action',
  'uncertain',
  'paused',
  'cancelled',
  'skipped',
]);
export type PublishingStatus = z.infer<typeof PublishingStatusSchema>;

// ---------------------------------------------------------------------------
// AI content status
// ---------------------------------------------------------------------------
export const AiContentStatusSchema = z.enum([
  'generated',
  'edited',
  'approved',
  'superseded',
  'failed',
]);
export type AiContentStatus = z.infer<typeof AiContentStatusSchema>;

// ---------------------------------------------------------------------------
// Hashtag schema (validated format)
// ---------------------------------------------------------------------------
export const HashtagSchema = z
  .string()
  .min(4) // '#' + 3 chars min
  .max(31) // '#' + 30 chars max
  .regex(/^#[A-Za-z0-9_]+$/, 'Hashtag must start with # followed by letters, digits, or underscores');

// ---------------------------------------------------------------------------
// AI generated caption schema
// ---------------------------------------------------------------------------
export const AiCaptionSchema = z.object({
  title: z.string().min(20).max(150),
  hashtags: z
    .array(HashtagSchema)
    .length(2)
    .refine((tags) => new Set(tags).size === 2, 'Hashtags must be unique'),
});
export type AiCaption = z.infer<typeof AiCaptionSchema>;

// ---------------------------------------------------------------------------
// Reel summary (returned by API)
// ---------------------------------------------------------------------------
export const ReelSummarySchema = z.object({
  id: z.number().int().positive(),
  publicId: z.string(),
  originalFilename: z.string(),
  filenameStem: z.string(),
  status: ReelStatusSchema,
  statusReason: z.string().nullable(),
  priority: z.number().int(),
  paused: z.boolean(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  completedAt: z.number().int().nullable(),
  cancelledAt: z.number().int().nullable(),
});
export type ReelSummary = z.infer<typeof ReelSummarySchema>;

// ---------------------------------------------------------------------------
// Background job state
// ---------------------------------------------------------------------------
export const JobStateSchema = z.enum([
  'queued',
  'leased',
  'running',
  'succeeded',
  'failed',
  'dead',
  'cancelled',
]);
export type JobState = z.infer<typeof JobStateSchema>;

// ---------------------------------------------------------------------------
// Job type
// ---------------------------------------------------------------------------
export const JobTypeSchema = z.enum([
  'media.probe',
  'ai.generate',
  'publish.instagram',
  'publish.facebook',
  'publish.telegram',
  'reconcile.destination',
  'file.delete_raw',
  'file.cleanup',
  'token.refresh',
  'db.backup',
  'db.integrity_check',
  'browser.task',
  'notify.dispatch',
]);
export type JobType = z.infer<typeof JobTypeSchema>;

// ---------------------------------------------------------------------------
// Notification severity
// ---------------------------------------------------------------------------
export const NotificationSeveritySchema = z.enum(['info', 'success', 'warning', 'critical']);
export type NotificationSeverity = z.infer<typeof NotificationSeveritySchema>;

// ---------------------------------------------------------------------------
// Scheduled job status
// ---------------------------------------------------------------------------
export const ScheduledJobStatusSchema = z.enum([
  'pending',
  'paused',
  'promoted',
  'missed',
  'cancelled',
]);
export type ScheduledJobStatus = z.infer<typeof ScheduledJobStatusSchema>;

