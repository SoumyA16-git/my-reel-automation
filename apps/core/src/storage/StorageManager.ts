import {
  mkdirSync,
  existsSync,
  statSync,
  realpathSync,
  createWriteStream,
  renameSync,
  unlinkSync,
  readdirSync,
} from 'node:fs';
import { statfs } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve, normalize, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { logger } from '../logger.js';

/** Storage subdirectory layout. */
const STORAGE_DIRS = [
  'videos/censored',
  'videos/raw',
  'videos/quarantine',
  'temp',
  'browser-profiles',
  'logs',
  'backups',
  'db',
] as const;

export type StorageRole =
  | 'censored'
  | 'raw'
  | 'quarantine'
  | 'temp'
  | 'browser-profiles'
  | 'logs'
  | 'backups'
  | 'db';

/** Map from role to subdirectory path. */
const ROLE_DIRS: Record<StorageRole, string> = {
  censored: 'videos/censored',
  raw: 'videos/raw',
  quarantine: 'videos/quarantine',
  temp: 'temp',
  'browser-profiles': 'browser-profiles',
  logs: 'logs',
  backups: 'backups',
  db: 'db',
};

export class StorageManager {
  private readonly storageRoot: string;

  constructor(storageRoot: string) {
    this.storageRoot = resolve(storageRoot);
  }

  // -------------------------------------------------------------------------
  // Directory setup
  // -------------------------------------------------------------------------

  /**
   * Ensure all required storage subdirectories exist.
   * Called at startup before any file operations.
   */
  ensureDirectories(): void {
    for (const dir of STORAGE_DIRS) {
      const fullPath = join(this.storageRoot, dir);
      if (!existsSync(fullPath)) {
        mkdirSync(fullPath, { recursive: true, mode: 0o750 });
        logger.debug({ path: fullPath }, 'Created storage directory');
      }
    }
    logger.info({ storageRoot: this.storageRoot }, 'Storage directories verified');
  }

  /**
   * Check if the storage root exists and is accessible.
   */
  rootExists(): boolean {
    try {
      statSync(this.storageRoot);
      return true;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Path resolution (the security boundary)
  // -------------------------------------------------------------------------

  /**
   * Resolve a storage name (UUID filename) to an absolute path for the given role.
   *
   * Security contract:
   * 1. `storageName` must be a simple filename with no path separators.
   * 2. `storageName` must not start with `.`.
   * 3. The resolved absolute path must be under `storageRoot/roleDir`.
   * 4. If the file exists, it must not be a symlink outside the storage root.
   *
   * @throws {Error} if any security constraint is violated.
   */
  resolveStoragePath(storageName: string, role: StorageRole): string {
    // 1. Reject empty names
    if (!storageName || storageName.trim() === '') {
      throw new Error('Storage name must not be empty');
    }

    // 2. Reject path separators and traversal sequences
    if (
      storageName.includes('/') ||
      storageName.includes('\\') ||
      storageName.includes('..') ||
      storageName.startsWith('.')
    ) {
      logger.error(
        { storageName, role },
        'SECURITY: Path traversal attempt detected in storage name',
      );
      throw new Error('Invalid storage name: must be a simple filename without path components');
    }

    // 3. Normalize and verify the constructed path stays under the role directory
    const roleDir = join(this.storageRoot, ROLE_DIRS[role]);
    const candidatePath = normalize(join(roleDir, storageName));
    const expectedPrefix = roleDir.endsWith(sep) ? roleDir : roleDir + sep;

    if (!candidatePath.startsWith(expectedPrefix) && candidatePath !== roleDir) {
      logger.error(
        { storageName, role, candidatePath, roleDir },
        'SECURITY: Resolved path escapes storage role directory',
      );
      throw new Error('Invalid storage name: resolved path is outside the storage directory');
    }

    // 4. If the path exists, verify it's not a symlink pointing outside root
    if (existsSync(candidatePath)) {
      try {
        const realPath = realpathSync(candidatePath);
        if (!realPath.startsWith(this.storageRoot)) {
          logger.error(
            { candidatePath, realPath, storageRoot: this.storageRoot },
            'SECURITY: Symlink points outside storage root',
          );
          throw new Error('Invalid storage path: symlink points outside storage root');
        }
      } catch (err) {
        if (err instanceof Error && err.message.includes('SECURITY:')) throw err;
        // File may not exist yet — that's OK
      }
    }

    return candidatePath;
  }

  /**
   * Get the directory for a given role (without a filename).
   */
  getRoleDirectory(role: StorageRole): string {
    return join(this.storageRoot, ROLE_DIRS[role]);
  }

  // -------------------------------------------------------------------------
  // Disk space
  // -------------------------------------------------------------------------

  /**
   * Get available disk space in bytes at the storage root.
   * Returns 0 if the check fails.
   */
  async getFreeBytes(): Promise<number> {
    try {
      const stats = await statfs(this.storageRoot);
      return stats.bavail * stats.bsize;
    } catch (err) {
      logger.warn({ err, storageRoot: this.storageRoot }, 'Failed to check disk space');
      return 0;
    }
  }

  /**
   * Check if enough free space is available.
   * @param requiredBytes Bytes required for the operation.
   * @returns true if enough space is available.
   */
  async checkDiskSpace(requiredBytes: number): Promise<{ ok: boolean; freeBytes: number }> {
    const freeBytes = await this.getFreeBytes();
    return { ok: freeBytes >= requiredBytes, freeBytes };
  }

  // -------------------------------------------------------------------------
  // Upload streaming & file lifecycle operations (M2)
  // -------------------------------------------------------------------------

  /**
   * Stream an upload from a multipart field to the temp directory.
   * Calculates SHA-256 hash and byte size on the fly without in-memory buffering.
   * If maxBytes is exceeded, aborts and removes the incomplete temp file.
   */
  async streamUpload(
    tempName: string,
    stream: NodeJS.ReadableStream,
    maxBytes = 500 * 1024 * 1024,
  ): Promise<{ sizeBytes: number; sha256: string; tempPath: string }> {
    const tempPath = this.resolveStoragePath(tempName, 'temp');
    const hash = createHash('sha256');
    let sizeBytes = 0;

    const counterAndHasher = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        sizeBytes += chunk.length;
        if (sizeBytes > maxBytes) {
          callback(new Error(`File size exceeded maximum limit of ${maxBytes} bytes`));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });

    const fileOut = createWriteStream(tempPath, { flags: 'w', mode: 0o640 });

    try {
      await pipeline(stream, counterAndHasher, fileOut);
      const sha256 = hash.digest('hex');
      logger.debug({ tempPath, sizeBytes, sha256 }, 'Upload stream finished successfully');
      return { sizeBytes, sha256, tempPath };
    } catch (err) {
      // Clean up incomplete temp file
      try {
        if (existsSync(tempPath)) {
          unlinkSync(tempPath);
        }
      } catch {
        // Ignore
      }
      logger.error({ err, tempPath }, 'Upload stream failed; temp file cleaned up');
      throw err;
    }
  }

  /**
   * Atomically move a validated file from temp to its final role location.
   */
  moveToFinal(tempName: string, finalName: string, role: StorageRole): string {
    const tempPath = this.resolveStoragePath(tempName, 'temp');
    const finalPath = this.resolveStoragePath(finalName, role);

    renameSync(tempPath, finalPath);
    logger.debug({ tempPath, finalPath, role }, 'File moved to final location');
    return finalPath;
  }

  /**
   * Move a replaced or cancelled file to quarantine awaiting retention cleanup.
   */
  quarantineFile(storageName: string, currentRole: StorageRole): string {
    const sourcePath = this.resolveStoragePath(storageName, currentRole);
    const quarantinePath = this.resolveStoragePath(storageName, 'quarantine');

    if (existsSync(sourcePath)) {
      renameSync(sourcePath, quarantinePath);
      logger.info({ sourcePath, quarantinePath }, 'File moved to quarantine');
    }
    return quarantinePath;
  }

  /**
   * Check if a file exists in the specified role directory.
   */
  fileExists(storageName: string, role: StorageRole): boolean {
    try {
      const filePath = this.resolveStoragePath(storageName, role);
      return existsSync(filePath);
    } catch {
      return false;
    }
  }

  /**
   * Purge temporary files older than maxAgeMs (default 24h).
   * Returns count of purged files.
   */
  cleanOldTempFiles(maxAgeMs = 24 * 3600 * 1000): number {
    const tempDir = this.getRoleDirectory('temp');
    if (!existsSync(tempDir)) return 0;

    let purged = 0;
    const now = Date.now();
    try {
      const files = readdirSync(tempDir);
      for (const file of files) {
        try {
          const filePath = join(tempDir, file);
          const stats = statSync(filePath);
          if (now - stats.mtimeMs > maxAgeMs) {
            unlinkSync(filePath);
            purged++;
            logger.info({ filePath }, 'Purged old temp file');
          }
        } catch (fileErr) {
          logger.warn({ fileErr, file }, 'Failed to purge temp file');
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to scan temp directory for cleanup');
    }
    return purged;
  }

  /**
   * Purge quarantined files older than maxAgeMs (default 7 days).
   * Returns count of purged files.
   */
  cleanOldQuarantineFiles(maxAgeMs = 7 * 24 * 3600 * 1000): number {
    const quarantineDir = this.getRoleDirectory('quarantine');
    if (!existsSync(quarantineDir)) return 0;

    let purged = 0;
    const now = Date.now();
    try {
      const files = readdirSync(quarantineDir);
      for (const file of files) {
        try {
          const filePath = join(quarantineDir, file);
          const stats = statSync(filePath);
          if (now - stats.mtimeMs > maxAgeMs) {
            unlinkSync(filePath);
            purged++;
            logger.info({ filePath }, 'Purged expired quarantined file');
          }
        } catch (fileErr) {
          logger.warn({ fileErr, file }, 'Failed to purge quarantined file');
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to scan quarantine directory for cleanup');
    }
    return purged;
  }

  /**
   * Securely delete a file from storage.
   * Path is verified within the role directory before deletion.
   */
  safeDelete(storageName: string, role: StorageRole): void {
    const filePath = this.resolveStoragePath(storageName, role);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
      logger.info({ filePath, role }, 'File deleted from storage');
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _storageManager: StorageManager | null = null;

export function initStorageManager(storageRoot: string): StorageManager {
  _storageManager = new StorageManager(storageRoot);
  return _storageManager;
}

export function getStorageManager(): StorageManager {
  if (_storageManager === null) {
    throw new Error('StorageManager has not been initialized. Call initStorageManager() first.');
  }
  return _storageManager;
}

