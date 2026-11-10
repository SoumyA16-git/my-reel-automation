import { type Database } from 'better-sqlite3';
import { logger } from '../logger.js';

/** Max login failures per window before lockout. */
const MAX_FAILURES = 5;
/** Lockout window in milliseconds (15 minutes). */
const WINDOW_MS = 15 * 60 * 1000;
/** Lockout duration in milliseconds (15 minutes base, doubles per window). */
const LOCKOUT_BASE_MS = 15 * 60 * 1000;

// In-process IP-based rate limit store (complementary to per-account lockout in DB)
const ipFailures = new Map<string, { count: number; windowStart: number }>();

function cleanupIpStore(): void {
  const now = Date.now();
  for (const [ip, data] of ipFailures.entries()) {
    if (now - data.windowStart > WINDOW_MS) {
      ipFailures.delete(ip);
    }
  }
}

// Cleanup every 5 minutes
setInterval(cleanupIpStore, 5 * 60 * 1000).unref();

/**
 * Check if an IP is currently rate-limited.
 * Returns true if the IP should be blocked.
 */
export function isIpRateLimited(ip: string): boolean {
  const now = Date.now();
  const data = ipFailures.get(ip);

  if (!data) return false;

  if (now - data.windowStart > WINDOW_MS) {
    ipFailures.delete(ip);
    return false;
  }

  return data.count >= MAX_FAILURES;
}

/**
 * Record a failed login attempt for an IP.
 */
export function recordIpFailure(ip: string): void {
  const now = Date.now();
  const data = ipFailures.get(ip);

  if (!data || now - data.windowStart > WINDOW_MS) {
    ipFailures.set(ip, { count: 1, windowStart: now });
  } else {
    data.count++;
  }
}

/**
 * Reset IP failure counter after successful login.
 */
export function resetIpFailures(ip: string): void {
  ipFailures.delete(ip);
}

/**
 * Check if an account is locked out (per-account lockout stored in DB).
 */
export function isAccountLocked(db: Database, username: string): boolean {
  const now = Date.now();
  const row = db
    .prepare<[string]>(
      'SELECT locked_until, failed_login_count FROM admin_users WHERE username = ? COLLATE NOCASE',
    )
    .get(username) as { locked_until: number | null; failed_login_count: number } | undefined;

  if (!row) return false;
  if (row.locked_until === null) return false;
  return row.locked_until > now;
}

/**
 * Record a failed login for an account.
 * Locks the account after MAX_FAILURES consecutive failures.
 */
export function recordAccountFailure(db: Database, username: string): void {
  const now = Date.now();

  const row = db
    .prepare<[string]>(
      'SELECT id, failed_login_count FROM admin_users WHERE username = ? COLLATE NOCASE',
    )
    .get(username) as { id: number; failed_login_count: number } | undefined;

  if (!row) return;

  const newCount = row.failed_login_count + 1;
  let lockedUntil: number | null = null;

  if (newCount >= MAX_FAILURES) {
    // Progressive lockout: each violation window doubles the lockout
    const multiplier = Math.pow(2, Math.floor(newCount / MAX_FAILURES) - 1);
    lockedUntil = now + LOCKOUT_BASE_MS * multiplier;
    logger.warn(
      { username, failureCount: newCount, lockedUntil },
      'Account locked due to too many failed login attempts',
    );
  }

  db.prepare<[number, number | null, number, number]>(
    'UPDATE admin_users SET failed_login_count = ?, locked_until = ?, updated_at = ? WHERE id = ?',
  ).run(newCount, lockedUntil, now, row.id);
}

/**
 * Reset account failure counter after successful login.
 */
export function resetAccountFailures(db: Database, adminId: number): void {
  const now = Date.now();
  db.prepare<[number, number, number]>(
    'UPDATE admin_users SET failed_login_count = 0, locked_until = NULL, last_login_at = ?, updated_at = ? WHERE id = ?',
  ).run(now, now, adminId);
}

/**
 * Get remaining lockout time in milliseconds, or 0 if not locked.
 */
export function getLockoutRemainingMs(db: Database, username: string): number {
  const now = Date.now();
  const row = db
    .prepare<[string]>('SELECT locked_until FROM admin_users WHERE username = ? COLLATE NOCASE')
    .get(username) as { locked_until: number | null } | undefined;

  if (!row?.locked_until) return 0;
  return Math.max(0, row.locked_until - now);
}

