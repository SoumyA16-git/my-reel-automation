import { type Database } from 'better-sqlite3';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { logger } from '../logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function getMigrationsDir(): string {
  const primary = join(__dirname, 'migrations');
  if (existsSync(primary)) return primary;
  const fromSrc = join(__dirname, '../../src/db/migrations');
  if (existsSync(fromSrc)) return fromSrc;
  return primary;
}

interface MigrationRow {
  version: number;
  name: string;
  applied_at: number;
  checksum: string;
}

// ---------------------------------------------------------------------------
// Ensure the schema_migrations table exists (bootstrap)
// ---------------------------------------------------------------------------

function ensureMigrationsTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at INTEGER NOT NULL,
      checksum   TEXT NOT NULL
    )
  `);
}

// ---------------------------------------------------------------------------
// Load applied migrations
// ---------------------------------------------------------------------------

function getAppliedVersions(db: Database): Set<number> {
  const rows = db
    .prepare<[], Pick<MigrationRow, 'version'>>('SELECT version FROM schema_migrations')
    .all();
  return new Set(rows.map((r) => r.version));
}

// ---------------------------------------------------------------------------
// Discover migration files
// ---------------------------------------------------------------------------

interface MigrationFile {
  version: number;
  name: string;
  filename: string;
  sql: string;
  checksum: string;
}

function discoverMigrations(): MigrationFile[] {
  const migrationsDir = getMigrationsDir();
  let files: string[];
  try {
    files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));
  } catch {
    logger.warn({ dir: migrationsDir }, 'Migrations directory not found; no migrations to run');
    return [];
  }

  files.sort(); // alphabetical = numeric order if names start with 001_, 002_, …

  return files.map((filename) => {
    // Expect filenames like: 001_initial_schema.sql
    const match = /^(\d+)_(.+)\.sql$/.exec(filename);
    if (!match) {
      throw new Error(`Migration filename does not match expected pattern: ${filename}`);
    }
    const version = parseInt(match[1]!, 10);
    const name = match[2]!;
    const sql = readFileSync(join(migrationsDir, filename), 'utf-8');
    const checksum = createHash('sha256').update(sql, 'utf-8').digest('hex');
    return { version, name, filename, sql, checksum };
  });
}

// ---------------------------------------------------------------------------
// Run migrations
// ---------------------------------------------------------------------------

export function runMigrations(db: Database): void {
  ensureMigrationsTable(db);

  const applied = getAppliedVersions(db);
  const migrations = discoverMigrations();

  const pending = migrations.filter((m) => !applied.has(m.version));

  if (pending.length === 0) {
    logger.info('No pending database migrations');
    return;
  }

  logger.info({ count: pending.length }, 'Running database migrations');

  for (const migration of pending) {
    logger.info({ version: migration.version, name: migration.name }, 'Applying migration');

    // Run migration in a transaction
    const applyMigration = db.transaction(() => {
      db.exec(migration.sql);
      db.prepare<[number, string, number, string]>(
        'INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (?, ?, ?, ?)',
      ).run(migration.version, migration.name, Date.now(), migration.checksum);
    });

    try {
      applyMigration();
      logger.info({ version: migration.version, name: migration.name }, 'Migration applied successfully');
    } catch (err) {
      logger.error(
        { err, version: migration.version, name: migration.name },
        'Migration failed — database may be in an inconsistent state',
      );
      throw err;
    }
  }

  logger.info({ count: pending.length }, 'All migrations applied successfully');
}

