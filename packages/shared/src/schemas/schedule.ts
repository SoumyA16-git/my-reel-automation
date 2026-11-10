import { z } from 'zod';

// ---------------------------------------------------------------------------
// Schedule Slot Schema
// ---------------------------------------------------------------------------
export const ScheduleSlotSchema = z.object({
  id: z.number().int().positive().optional(),
  label: z.string().min(1).max(50),
  localTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Local time must be in HH:MM format (24-hour)'),
  weekdayMask: z
    .number()
    .int()
    .min(0)
    .max(127)
    .default(127), // Bitmask: bit 0 = Sunday, 1 = Monday ... 6 = Saturday (127 = all days)
  timezone: z.string().default('Asia/Kolkata'),
  capacity: z.number().int().positive().default(1),
  enabled: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
  createdAt: z.number().int().optional(),
  updatedAt: z.number().int().optional(),
});
export type ScheduleSlot = z.infer<typeof ScheduleSlotSchema>;

export const CreateSlotSchema = ScheduleSlotSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type CreateSlotInput = z.infer<typeof CreateSlotSchema>;

export const UpdateSlotSchema = CreateSlotSchema.partial();
export type UpdateSlotInput = z.infer<typeof UpdateSlotSchema>;

// ---------------------------------------------------------------------------
// Scheduled Job Schema
// ---------------------------------------------------------------------------
export const ScheduledJobSourceSchema = z.enum(['slot', 'custom', 'auto', 'publish_now']);
export type ScheduledJobSource = z.infer<typeof ScheduledJobSourceSchema>;

export const ScheduledJobSchema = z.object({
  id: z.number().int().positive(),
  reelId: z.number().int().positive(),
  destinationId: z.number().int().positive().nullable(),
  slotId: z.number().int().positive().nullable(),
  scheduledFor: z.number().int().positive(), // UTC epoch ms
  source: ScheduledJobSourceSchema,
  status: z.enum(['pending', 'paused', 'promoted', 'missed', 'cancelled']),
  promotedAt: z.number().int().nullable().optional(),
  missedAction: z.string().nullable().optional(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type ScheduledJob = z.infer<typeof ScheduledJobSchema>;

// ---------------------------------------------------------------------------
// Schedule Reel Request
// ---------------------------------------------------------------------------
export const ScheduleReelInputSchema = z.object({
  scheduledFor: z.number().int().positive().optional(), // Specific timestamp (UTC ms)
  slotId: z.number().int().positive().optional(), // Or fill a slot
  destinationIds: z.array(z.number().int().positive()).optional(), // Optional per-destination override
  source: ScheduledJobSourceSchema.default('custom'),
});
export type ScheduleReelInput = z.infer<typeof ScheduleReelInputSchema>;

