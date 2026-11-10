import { z } from 'zod';

// ---------------------------------------------------------------------------
// Standard API error envelope
// ---------------------------------------------------------------------------
export const ApiErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  requestId: z.string(),
  details: z.unknown().optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------
export const PaginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type Pagination = z.infer<typeof PaginationSchema>;

export const PaginatedResponseSchema = <T extends z.ZodTypeAny>(itemSchema: T) =>
  z.object({
    items: z.array(itemSchema),
    total: z.number().int().nonnegative(),
    page: z.number().int().positive(),
    limit: z.number().int().positive(),
  });

// ---------------------------------------------------------------------------
// Health check response
// ---------------------------------------------------------------------------
export const HealthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded', 'error']),
  db: z.object({
    writable: z.boolean(),
    wal_mode: z.boolean(),
  }),
  scheduler: z.object({
    last_heartbeat_at: z.number().int().nullable(),
  }),
  storage: z.object({
    root_exists: z.boolean(),
    free_bytes: z.number().int(),
  }),
  version: z.string(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

