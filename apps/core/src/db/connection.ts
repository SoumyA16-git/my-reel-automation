import BetterSqlite3, { type Database } from 'better-sqlite3';
import { statSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { logger } from '../logger.js';

/** Filesystem types that are explicitly forbidden (network filesystems). */
const FORBIDDEN_FS_TYPES = new Set([
  'nfs',
  'nfs4',
  'cifs',
  'smb',
  'smbfs',
  'sshfs',
  'fuse.sshfs',
  'fuse',
  'davfs',
  'glusterfs',
  'cephfs',
]);

let _db: Database | null = null;

// ---------------------------------------------------------------------------
// Filesystem check (Linux only via /proc/mounts)
// ---------------------------------------------------------------------------

function checkFilesystem(dbPath: string): void {
  if (process.platform !== 'linux') {
    logger.warn(
      { platform: process.platform },
      'Filesystem type check is only supported on Linux; skipping. ' +
      'Ensure the DB is on a local disk, not NFS.',
    );
    return;
  }

  let mountsContent: string;
  try {
    mountsContent = readFileSync('/proc/mounts', 'utf-8');
  } catch {
    logger.warn('Could not read /proc/mounts; skipping filesystem check');
    return;
  }

  const dbDir = dirname(dbPath);
  const mounts = mountsContent
    .trim()
    .split('\n')
    .flatMap((line) => {
      const parts = line.split(' ');
      if (parts.length < 3) return [];
      return [{ mountPoint: parts[1] ?? '', fsType: (parts[2] ?? '').toLowerCase() }];
    });

  // Find the most specific (longest) matching mount point for the DB directory
  let bestMount: { mountPoint: string; fsType: string } | null = null;
  for (const m of mounts) {
    if (dbDir.startsWith(m.mountPoint)) {
      if (bestMount === null || m.mountPoint.length > bestMount.mountPoint.length) {
        bestMount = m;
      }
    }
  }

  if (!bestMount) {
    logger.warn({ dbPath }, 'Could not determine filesystem type; proceeding');
    return;
  }

  if (FORBIDDEN_FS_TYPES.has(bestMount.fsType)) {
    throw new Error(
      `SQLite WAL mode is not supported on "${bestMount.fsType}" (network filesystem). ` +
      `DB path: ${dbPath}. Move the database directory to a local disk (ext4, xfs, etc.).`,
    );
  }

  logger.debug({ fsType: bestMount.fsType, dbPath }, 'Filesystem check passed');
}

// ---------------------------------------------------------------------------
// Apply required PRAGMAs
// ---------------------------------------------------------------------------

function applyPragmas(db: Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  db.pragma('trusted_schema = OFF');
  db.pragma('wal_autocheckpoint = 1000');

  const journalMode = db.pragma('journal_mode', { simple: true }) as string;
  if (journalMode !== 'wal') {
    throw new Error(`Failed to enable WAL mode; journal_mode=${journalMode}`);
  }

  logger.debug('Database PRAGMAs applied');
}

// ---------------------------------------------------------------------------
// Writability check
// ---------------------------------------------------------------------------

function checkWritable(db: Database): void {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS _write_test (x INTEGER);
      DROP TABLE _write_test;
    `);
  } catch (err) {
    throw new Error(`Database is not writable: ${String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Verify DB directory exists and is on a local filesystem
// ---------------------------------------------------------------------------

function checkDbDirectory(dbPath: string): void {
  const dir = dirname(dbPath);
  try {
    statSync(dir);
  } catch {
    throw new Error(
      `Database directory does not exist: ${dir}. ` +
      'Create it and ensure it is writable by the process.',
    );
  }
  checkFilesystem(dbPath);
}

// ---------------------------------------------------------------------------
// Open connection
// ---------------------------------------------------------------------------

export function openDatabase(dbPath: string): Database {
  if (_db !== null) {
    if (_db.name === dbPath && _db.open) {
      return _db;
    }
    try {
      _db.close();
    } catch {
      // Ignore
    }
    _db = null;
  }

  logger.info({ dbPath }, 'Opening database');

  checkDbDirectory(dbPath);

  const db = new BetterSqlite3(dbPath, {
    verbose:
      process.env['LOG_LEVEL'] === 'trace'
        ? (sql) => logger.trace({ sql }, 'SQL')
        : undefined,
  });

  applyPragmas(db);
  checkWritable(db);

  _db = db;
  logger.info({ dbPath }, 'Database opened successfully');
  return db;
}

export function getDatabase(): Database {
  if (_db === null) {
    throw new Error('Database has not been opened yet. Call openDatabase() first.');
  }
  return _db;
}

export function closeDatabase(): void {
  if (_db !== null) {
    _db.close();
    _db = null;
    logger.info('Database closed');
  }
}

export function isDatabaseOpen(): boolean {
  return _db !== null && _db.open;
}

/** Check if DB is writable (used by health endpoint). */
export function isDbWritable(): boolean {
  if (_db === null || !_db.open) return false;
  try {
    checkWritable(_db);
    return true;
  } catch {
    return false;
  }
}

/** Check if WAL mode is active (used by health endpoint). */
export function isWalMode(): boolean {
  if (_db === null || !_db.open) return false;
  try {
    const mode = _db.pragma('journal_mode', { simple: true }) as string;
    return mode === 'wal';
  } catch {
    return false;
  }
}
