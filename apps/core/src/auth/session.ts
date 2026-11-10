import { randomBytes } from 'node:crypto';
import { type Database } from 'better-sqlite3';
import { sha256hex } from '../crypto/index.js';
import { logger } from '../logger.js';

/** Session token length in bytes (256 bits). */
const TOKEN_BYTES = 32;

/** Idle timeout: 30 minutes in milliseconds. */
export const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/** Absolute timeout: 12 hours in milliseconds. */
export const SESSION_ABSOLUTE_TIMEOUT_MS = 12 * 60 * 60 * 1000;

export interface SessionRow {
  id: number;
  token_hash: string;
  admin_id: number;
  csrf_secret: string;
  ip: string | null;
  user_agent: string | null;
  expires_at: number;
  last_seen_at: number;
  revoked_at: number | null;
  created_at: number;
}

export interface CreateSessionOptions {
  adminId: number;
  ip?: string | null;
  userAgent?: string | null;
}

export interface SessionResult {
  /** Raw token — set as the cookie value. */
  token: string;
  /** CSRF secret for this session (stored in DB, never sent as cookie). */
  csrfSecret: string;
  /** Cookie expiry timestamp (ms). */
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// Create session
// ---------------------------------------------------------------------------

export function createSession(db: Database, opts: CreateSessionOptions): SessionResult {
  const token = randomBytes(TOKEN_BYTES).toString('hex');
  const tokenHash = sha256hex(token);
  const csrfSecret = randomBytes(TOKEN_BYTES).toString('hex');
  const now = Date.now();
  const expiresAt = now + SESSION_IDLE_TIMEOUT_MS; // Initial expiry = idle timeout

  db.prepare<[string, number, string, string | null, string | null, number, number, number]>(`
    INSERT INTO admin_sessions (token_hash, admin_id, csrf_secret, ip, user_agent, expires_at, last_seen_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    tokenHash,
    opts.adminId,
    csrfSecret,
    opts.ip ?? null,
    opts.userAgent ?? null,
    expiresAt,
    now,
    now,
  );

  logger.info({ adminId: opts.adminId, ip: opts.ip }, 'Session created');

  return { token, csrfSecret, expiresAt };
}

// ---------------------------------------------------------------------------
// Validate and refresh session
// ---------------------------------------------------------------------------

export interface ValidatedSession {
  sessionId: number;
  adminId: number;
  username: string;
  csrfSecret: string;
  ip: string | null;
  userAgent: string | null;
  expiresAt: number;
  lastSeenAt: number;
}

export function validateSession(
  db: Database,
  token: string,
): ValidatedSession | null {
  const tokenHash = sha256hex(token);
  const now = Date.now();

  const row = db
    .prepare<[string, number]>(`
      SELECT
        s.id, s.admin_id, s.csrf_secret, s.ip, s.user_agent,
        s.expires_at, s.last_seen_at, s.revoked_at, s.created_at,
        u.username
      FROM admin_sessions s
      JOIN admin_users u ON u.id = s.admin_id
      WHERE s.token_hash = ?
        AND s.revoked_at IS NULL
        AND s.expires_at > ?
    `)
    .get(tokenHash, now) as (SessionRow & { username: string }) | undefined;

  if (!row) return null;

  // Check absolute timeout (12 hours from creation)
  if (now - row.created_at > SESSION_ABSOLUTE_TIMEOUT_MS) {
    // Revoke the session
    db.prepare<[number, number]>(
      'UPDATE admin_sessions SET revoked_at = ? WHERE id = ?',
    ).run(now, row.id);
    logger.info({ sessionId: row.id }, 'Session revoked: absolute timeout exceeded');
    return null;
  }

  // Slide the expiry (idle timeout)
  const newExpiry = now + SESSION_IDLE_TIMEOUT_MS;
  db.prepare<[number, number, number]>(
    'UPDATE admin_sessions SET expires_at = ?, last_seen_at = ? WHERE id = ?',
  ).run(newExpiry, now, row.id);

  return {
    sessionId: row.id,
    adminId: row.admin_id,
    username: row.username,
    csrfSecret: row.csrf_secret,
    ip: row.ip,
    userAgent: row.user_agent,
    expiresAt: newExpiry,
    lastSeenAt: now,
  };
}

// ---------------------------------------------------------------------------
// Revoke session (logout)
// ---------------------------------------------------------------------------

export function revokeSession(db: Database, token: string): boolean {
  const tokenHash = sha256hex(token);
  const now = Date.now();

  const result = db
    .prepare<[number, string]>(
      'UPDATE admin_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL',
    )
    .run(now, tokenHash);

  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// Revoke all sessions for an admin (e.g., password change)
// ---------------------------------------------------------------------------

export function revokeAllSessions(db: Database, adminId: number): number {
  const now = Date.now();
  const result = db
    .prepare<[number, number]>(
      'UPDATE admin_sessions SET revoked_at = ? WHERE admin_id = ? AND revoked_at IS NULL',
    )
    .run(now, adminId);

  logger.info({ adminId, count: result.changes }, 'All sessions revoked for admin');
  return result.changes;
}

// ---------------------------------------------------------------------------
// Cookie configuration
// ---------------------------------------------------------------------------

export const COOKIE_NAME = 'reelhub_session';

export const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: 'strict' as const,
  path: '/',
} as const;

