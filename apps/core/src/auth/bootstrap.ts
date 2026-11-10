import { randomBytes } from 'node:crypto';
import { type Database } from 'better-sqlite3';
import { hashPassword } from './password.js';
import { logger } from '../logger.js';

/** Bootstrap token length in bytes. */
const BOOTSTRAP_TOKEN_BYTES = 32;

let _bootstrapToken: string | null = null;

/**
 * Check if any admin users exist.
 */
export function hasAdminUsers(db: Database): boolean {
  const row = db
    .prepare<[]>('SELECT COUNT(*) as cnt FROM admin_users')
    .get() as { cnt: number };
  return row.cnt > 0;
}

/**
 * Generate and return the one-time bootstrap token.
 * Prints the token to stdout so the operator can use it.
 * Token is only valid until the first admin is created.
 */
export function getOrCreateBootstrapToken(): string {
  if (_bootstrapToken === null) {
    _bootstrapToken = randomBytes(BOOTSTRAP_TOKEN_BYTES).toString('hex');
    // Print prominently to stdout so it can be seen in Docker logs
    console.log('');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('[BOOTSTRAP] No admin account found.');
    console.log('[BOOTSTRAP] One-time setup token:');
    console.log(`[BOOTSTRAP] ${_bootstrapToken}`);
    console.log('[BOOTSTRAP] POST /api/v1/auth/bootstrap with this token to create the admin.');
    console.log('[BOOTSTRAP] This token is only shown once and expires when an admin is created.');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('');
  }
  return _bootstrapToken;
}

/**
 * Verify a provided bootstrap token matches the generated one.
 */
export function verifyBootstrapToken(provided: string): boolean {
  if (_bootstrapToken === null) return false;
  if (provided.length !== _bootstrapToken.length) return false;

  // Constant-time comparison
  let mismatch = 0;
  for (let i = 0; i < provided.length; i++) {
    mismatch |= (provided.charCodeAt(i) ?? 0) ^ (_bootstrapToken.charCodeAt(i) ?? 0);
  }
  return mismatch === 0;
}

/**
 * Create the initial admin user using the bootstrap token.
 * Clears the bootstrap token after use.
 */
export async function bootstrapAdmin(
  db: Database,
  username: string,
  password: string,
): Promise<number> {
  if (password.length < 12) {
    throw new Error('Password must be at least 12 characters');
  }

  const passwordHash = await hashPassword(password);
  const now = Date.now();

  const result = db
    .prepare<[string, string, number, number]>(
      'INSERT INTO admin_users (username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?)',
    )
    .run(username, passwordHash, now, now);

  const adminId = result.lastInsertRowid as number;

  // Clear the bootstrap token so it cannot be used again
  _bootstrapToken = null;

  logger.info({ adminId, username }, 'Admin account created via bootstrap');
  return adminId;
}

