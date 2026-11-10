import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { logger } from '../logger.js';

const ALGORITHM = 'aes-256-gcm';
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;

// ---------------------------------------------------------------------------
// Master key loading
// ---------------------------------------------------------------------------

let _masterKey: Buffer | null = null;

/**
 * Load the master encryption key from env.
 * Priority:
 *  1. MASTER_KEY_FILE (path to a file containing hex/base64 key)
 *  2. MASTER_KEY (inline hex/base64 value)
 *  3. Generate and persist to MASTER_KEY_FILE if neither is set (first run)
 *
 * On first run without any config, generates a key, prints a clear warning,
 * and writes it to the path specified by MASTER_KEY_FILE (defaults to
 * /data/db/master.key when storage is set up).
 */
export function loadMasterKey(): Buffer {
  if (_masterKey !== null) return _masterKey;

  const keyFilePath = process.env['MASTER_KEY_FILE'];
  const keyEnv = process.env['MASTER_KEY'];

  if (keyFilePath) {
    if (existsSync(keyFilePath)) {
      const raw = readFileSync(keyFilePath, 'utf-8').trim();
      _masterKey = parseKey(raw);
      logger.info({ keyFile: keyFilePath }, 'Master key loaded from file');
      return _masterKey;
    }
    // File path specified but file doesn't exist — generate and save
    logger.warn(
      { keyFile: keyFilePath },
      'MASTER_KEY_FILE path set but file not found — generating a new master key. ' +
        'BACK UP THIS FILE SEPARATELY FROM YOUR DATABASE BACKUPS.',
    );
    _masterKey = randomBytes(KEY_LENGTH);
    try {
      writeFileSync(keyFilePath, _masterKey.toString('hex'), { mode: 0o600 });
      logger.info({ keyFile: keyFilePath }, 'New master key saved to file');
    } catch (err) {
      logger.error({ err, keyFile: keyFilePath }, 'Failed to save generated master key to file');
      throw new Error(
        `Could not write master key to ${keyFilePath}. ` +
          'Ensure the directory exists and is writable.',
      );
    }
    return _masterKey;
  }

  if (keyEnv) {
    _masterKey = parseKey(keyEnv);
    logger.info('Master key loaded from MASTER_KEY environment variable');
    return _masterKey;
  }

  // Neither configured — this is a programming error at startup
  throw new Error(
    'No master encryption key configured. ' +
      'Set MASTER_KEY_FILE or MASTER_KEY environment variable.',
  );
}

function parseKey(raw: string): Buffer {
  let key: Buffer;

  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    // 64 hex chars = 32 bytes
    key = Buffer.from(raw, 'hex');
  } else {
    // Try base64
    key = Buffer.from(raw, 'base64');
  }

  if (key.length !== KEY_LENGTH) {
    throw new Error(
      `Master key must be exactly ${KEY_LENGTH} bytes (got ${key.length}). ` +
        'Provide a 64-character hex string or a 44-character base64 string.',
    );
  }

  return key;
}

// ---------------------------------------------------------------------------
// Encrypt / Decrypt
// ---------------------------------------------------------------------------

/**
 * Encrypt plaintext using AES-256-GCM.
 * Output layout: [12 bytes nonce][ciphertext][16 bytes auth tag]
 */
export function encrypt(plaintext: string, masterKey?: Buffer): Buffer {
  const key = masterKey ?? loadMasterKey();
  const nonce = randomBytes(NONCE_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, nonce);

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([nonce, encrypted, tag]);
}

/**
 * Decrypt ciphertext produced by `encrypt`.
 * Input layout: [12 bytes nonce][ciphertext][16 bytes auth tag]
 */
export function decrypt(ciphertext: Buffer, masterKey?: Buffer): string {
  const key = masterKey ?? loadMasterKey();

  if (ciphertext.length < NONCE_LENGTH + TAG_LENGTH) {
    throw new Error('Ciphertext is too short to be valid');
  }

  const nonce = ciphertext.subarray(0, NONCE_LENGTH);
  const tag = ciphertext.subarray(ciphertext.length - TAG_LENGTH);
  const data = ciphertext.subarray(NONCE_LENGTH, ciphertext.length - TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, nonce);
  decipher.setAuthTag(tag);

  return decipher.update(data).toString('utf-8') + decipher.final('utf-8');
}

// ---------------------------------------------------------------------------
// Fingerprint — last 4 hex chars of SHA-256 (for safe UI display)
// ---------------------------------------------------------------------------

/**
 * Returns the last 4 hex characters of the SHA-256 of the given value.
 * Used for displaying a recognizable fingerprint of a secret without
 * exposing the secret itself.
 */
export function fingerprint(value: string): string {
  const hash = createHash('sha256').update(value, 'utf-8').digest('hex');
  return hash.slice(-4);
}

// ---------------------------------------------------------------------------
// SHA-256 hash of a string (for session token storage)
// ---------------------------------------------------------------------------

export function sha256hex(value: string): string {
  return createHash('sha256').update(value, 'utf-8').digest('hex');
}

