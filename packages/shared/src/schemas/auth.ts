import { z } from 'zod';

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
export const BootstrapRequestSchema = z.object({
  setupToken: z.string().min(1),
  username: z.string().min(1).max(100),
  password: z.string().min(12).max(1000),
});
export type BootstrapRequest = z.infer<typeof BootstrapRequestSchema>;

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------
export const LoginRequestSchema = z.object({
  username: z.string().min(1).max(100),
  password: z.string().min(1).max(1000),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

// ---------------------------------------------------------------------------
// Session info (safe to return in API response)
// ---------------------------------------------------------------------------
export const SessionInfoSchema = z.object({
  adminId: z.number().int().positive(),
  username: z.string(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  expiresAt: z.number().int(),
  lastSeenAt: z.number().int(),
});
export type SessionInfo = z.infer<typeof SessionInfoSchema>;

