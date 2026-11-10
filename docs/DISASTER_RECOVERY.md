# ReelHub — Disaster Recovery & Backup Restoration Runbook

This runbook defines the verified procedure for disaster recovery, data restoration drills, and node migration as required by PRD Section 19.8, FR-028, and NFR-014.

---

## 1. RTO and RPO Targets

- **RTO (Recovery Time Objective):** ≤ 30 minutes from disaster to live service.
- **RPO (Recovery Point Objective):** ≤ 6 hours (standard encrypted online backup cadence).

---

## 2. Automated Backups Overview

ReelHub automatically executes online backups every 6 hours via `BackupService` (`apps/core/src/backup/BackupService.ts`):
1. Executes SQLite online backup API (`better-sqlite3.backup()`).
2. Runs `PRAGMA integrity_check` on the backup image.
3. Encrypts backup using AES-256-GCM with the master encryption key (`MASTER_KEY`).
4. Persists the encrypted backup to `/srv/reelhub/backups/backup_<ISO_TIMESTAMP>.sqlite.enc`.
5. Enforces retention: keeps 7 daily backups + 4 weekly backups; rotates older files.

---

## 3. Step-by-Step Restoration Procedure

### Step 1: Stop the Running Container
To prevent any write operations or lock contention:
```bash
docker compose -p reelhub stop core
```

### Step 2: Locate the Target Backup
List existing backups in the backup volume:
```bash
ls -lt /srv/reelhub/backups/
```
Select the latest healthy file, e.g. `/srv/reelhub/backups/backup_2026-11-09T14-20-51-493Z.sqlite.enc`.

### Step 3: Run the Turnkey Restore CLI
Execute the restore CLI either directly with Node or inside a temporary Node container:

#### Option A: Directly on the host (if Node is installed)
```bash
export MASTER_KEY="<your-32-byte-hex-key>" # or MASTER_KEY_FILE=/srv/reelhub/master_key
pnpm --filter @reelhub/core restore /srv/reelhub/backups/backup_2026-11-09T...sqlite.enc /srv/reelhub/db/reelhub.sqlite
```

#### Option B: Via Docker
```bash
docker run --rm \
  -v /srv/reelhub/db:/data/db \
  -v /srv/reelhub/backups:/data/backups \
  -e MASTER_KEY="<your-32-byte-hex-key>" \
  reelhub-core \
  node apps/core/dist/backup/restoreBackupCli.js \
    /data/backups/backup_2026-11-09T...sqlite.enc \
    /data/db/reelhub.sqlite
```

The restore CLI automatically:
- Decrypts the backup file using AES-256-GCM.
- Verifies ciphertext authentication tag (rejects tampered or corrupt files).
- Runs `PRAGMA integrity_check` on the decrypted database.
- Safely archives the current `/srv/reelhub/db/reelhub.sqlite` to `reelhub.sqlite.bak-<TIMESTAMP>`.
- Atomically replaces `reelhub.sqlite` with the verified backup database.
- Prints total row counts for `reels`, `publishing_records`, and `publishing_destinations`.

### Step 4: Verify Video Assets Integrity
Verify that the corresponding video files exist in `/srv/reelhub/videos/censored/`:
```bash
ls -lh /srv/reelhub/videos/censored/
```

### Step 5: Start the Core Service
```bash
docker compose -p reelhub start core
```

### Step 6: Post-Restore Health Verification
Verify that the service is running, WAL mode is active, and database is writable:
```bash
curl http://127.0.0.1:3000/api/v1/system/health
```
Expected output:
```json
{
  "status": "ok",
  "db": {
    "writable": true,
    "wal_mode": true
  },
  "storage": {
    "disk_writable": true
  }
}
```

---

## 4. Periodic DR Drill Checklist

Conduct this drill monthly:
1. Copy the latest `.sqlite.enc` file to a test environment.
2. Run `node apps/core/dist/backup/restoreBackupCli.js <backup.enc>` (dry-run mode without target).
3. Confirm output displays `[DR Drill] PRAGMA integrity_check passed: OK.` and expected row counts.
4. Record drill timestamp and operator in your ops log.

