import { readFileSync, writeFileSync, existsSync, copyFileSync, rmSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import Database from 'better-sqlite3';
import { decrypt, loadMasterKey } from '../crypto/index.js';

export async function runRestoreCli(backupFile?: string, targetFile?: string): Promise<boolean> {
  if (!backupFile) {
    console.error('Usage: node dist/backup/restoreBackupCli.js <encrypted-backup-file.sqlite.enc> [target-db-path.sqlite]');
    return false;
  }

  const resolvedBackupPath = resolve(backupFile);
  if (!existsSync(resolvedBackupPath)) {
    console.error(`Error: Backup file not found at ${resolvedBackupPath}`);
    return false;
  }

  console.log(`[DR Drill] 1. Loading master encryption key...`);
  loadMasterKey();

  console.log(`[DR Drill] 2. Decrypting backup file: ${basename(resolvedBackupPath)}...`);
  const encBuffer = readFileSync(resolvedBackupPath);
  const decryptedBuffer = decrypt(encBuffer);
  console.log(`[DR Drill] Decrypted ${decryptedBuffer.length} bytes successfully.`);

  const tempVerificationPath = resolvedBackupPath.replace(/\.enc$/, '.verify.tmp');
  writeFileSync(tempVerificationPath, decryptedBuffer);

  try {
    console.log(`[DR Drill] 3. Verifying SQLite file integrity...`);
    const db = new Database(tempVerificationPath, { readonly: true });
    
    const integrityResult = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
    if (!integrityResult || integrityResult[0]?.integrity_check !== 'ok') {
      throw new Error(`Integrity check failed: ${JSON.stringify(integrityResult)}`);
    }
    console.log(`[DR Drill] PRAGMA integrity_check passed: OK.`);

    // Verification query
    const reelsCount = db.prepare('SELECT count(*) as count FROM reels').get() as { count: number };
    const recordsCount = db.prepare('SELECT count(*) as count FROM publishing_records').get() as { count: number };
    const destinationsCount = db.prepare('SELECT count(*) as count FROM publishing_destinations').get() as { count: number };
    console.log(`[DR Drill] Database Verified Schema & Counts:`);
    console.log(`  - Reels: ${reelsCount.count}`);
    console.log(`  - Publishing Records: ${recordsCount.count}`);
    console.log(`  - Publishing Destinations: ${destinationsCount.count}`);

    db.close();

    // If target file specified, perform the restore
    if (targetFile) {
      const resolvedTarget = resolve(targetFile);
      if (existsSync(resolvedTarget)) {
        const backupBackup = `${resolvedTarget}.bak-${Date.now()}`;
        console.log(`[DR Drill] Existing target found. Creating safety backup at ${backupBackup}`);
        copyFileSync(resolvedTarget, backupBackup);
      }
      console.log(`[DR Drill] 4. Writing restored database to ${resolvedTarget}...`);
      writeFileSync(resolvedTarget, decryptedBuffer);
      console.log(`[DR Drill] Disaster recovery restore complete! Target is ready for core service.`);
    } else {
      console.log(`[DR Drill] Verification drill successful! (Pass target path to perform write)`);
    }
    return true;
  } finally {
    try {
      rmSync(tempVerificationPath, { force: true });
    } catch {
      // ignore
    }
  }
}

// Auto-run if executed directly
if (process.argv[1]?.endsWith('restoreBackupCli.js') || process.argv[1]?.endsWith('restoreBackupCli.ts')) {
  const args = process.argv.slice(2);
  runRestoreCli(args[0], args[1]).catch((err) => {
    console.error('[DR Drill Error]:', err.message);
    process.exit(1);
  });
}

