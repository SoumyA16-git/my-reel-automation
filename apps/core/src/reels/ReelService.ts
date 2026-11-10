import { type Database } from 'better-sqlite3';
import { ulid } from 'ulid';
import { logger } from '../logger.js';
import { StorageManager, getStorageManager, type StorageRole } from '../storage/StorageManager.js';
import { probeVideo, type VideoMetadata } from '../media/probe.js';
import { validateVideo, type ValidationResult } from '../media/validate.js';
import { cleanFilenameForAi, getGeminiService } from '../ai/gemini.js';
import { getAuditService } from '../audit/AuditService.js';
import { getNotificationService } from '../notifications/NotificationService.js';
import { getSettingsService } from '../settings/SettingsService.js';

export interface ReelRow {
  id: number;
  public_id: string;
  original_filename: string;
  filename_stem: string;
  status: string;
  status_reason: string | null;
  priority: number;
  approved_ai_content_id: number | null;
  paused: number;
  created_by: number;
  completed_at: number | null;
  cancelled_at: number | null;
  archived_at: number | null;
  deleted_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface VideoFileRow {
  id: number;
  reel_id: number;
  role: 'censored' | 'raw';
  storage_name: string;
  original_filename: string;
  size_bytes: number;
  sha256: string;
  mime_type: string | null;
  container_format: string | null;
  video_codec: string | null;
  audio_codec: string | null;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  bitrate_bps: number | null;
  fps_milli: number | null;
  validation_state: 'pending' | 'valid' | 'warning' | 'invalid';
  validation_report: string | null;
  state: 'uploading' | 'present' | 'quarantined' | 'deleted' | 'deletion_failed' | 'missing';
  in_use_by_job_id: number | null;
  in_use_since: number | null;
  deleted_at: number | null;
  deletion_reason: string | null;
}

export interface AiContentRow {
  id: number;
  reel_id: number;
  platform: string | null;
  version: number;
  source: 'gemini' | 'manual';
  model: string | null;
  prompt_version: string | null;
  input_text: string;
  title: string;
  hashtags: string;
  status: 'generated' | 'edited' | 'approved' | 'superseded' | 'failed';
  error: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  approved_at: number | null;
  created_at: number;
  updated_at: number;
}

export class ReelService {
  constructor(
    private readonly db: Database,
    private readonly storage: StorageManager = getStorageManager(),
  ) { }

  // -------------------------------------------------------------------------
  // Reel Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Create a new draft Reel record.
   */
  createDraft(params: {
    originalFilename: string;
    createdBy: number;
    priority?: number | undefined;
  }): ReelRow {
    const publicId = ulid();
    const stem = cleanFilenameForAi(params.originalFilename);
    const now = Date.now();

    const result = this.db
      .prepare<[string, string, string, number, number, number, number]>(`
        INSERT INTO reels (
          public_id, original_filename, filename_stem, status,
          priority, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, 'draft', ?, ?, ?, ?)
      `)
      .run(
        publicId,
        params.originalFilename,
        stem,
        params.priority ?? 0,
        params.createdBy,
        now,
        now,
      );

    const id = result.lastInsertRowid as number;

    getAuditService().log({
      actorId: params.createdBy,
      action: 'reel.create',
      targetType: 'reel',
      targetId: publicId,
      result: 'success',
    });

    return this.getReelById(id)!;
  }

  /**
   * Get Reel by internal ID.
   */
  getReelById(id: number): ReelRow | null {
    return (
      (this.db
        .prepare<[number]>('SELECT * FROM reels WHERE id = ? AND deleted_at IS NULL')
        .get(id) as ReelRow | undefined) ?? null
    );
  }

  /**
   * Get Reel by public ULID.
   */
  getReelByPublicId(publicId: string): ReelRow | null {
    return (
      (this.db
        .prepare<[string]>('SELECT * FROM reels WHERE public_id = ? AND deleted_at IS NULL')
        .get(publicId) as ReelRow | undefined) ?? null
    );
  }

  /**
   * Get full Reel details including files and caption versions.
   */
  getReelDetail(id: number): {
    reel: ReelRow;
    files: VideoFileRow[];
    captions: AiContentRow[];
  } | null {
    const reel = this.getReelById(id);
    if (!reel) return null;

    const files = this.db
      .prepare<[number]>('SELECT * FROM video_files WHERE reel_id = ? ORDER BY id ASC')
      .all(id) as VideoFileRow[];

    const captions = this.db
      .prepare<[number]>('SELECT * FROM ai_content WHERE reel_id = ? ORDER BY version DESC')
      .all(id) as AiContentRow[];

    return { reel, files, captions };
  }

  /**
   * List reels with pagination and filters.
   */
  listReels(params: {
    page?: number | undefined;
    limit?: number | undefined;
    status?: string | undefined;
    search?: string | undefined;
  }): { items: Array<ReelRow & { files: VideoFileRow[]; approvedCaption: AiContentRow | null }>; total: number } {
    const page = Math.max(1, params.page ?? 1);
    const limit = Math.min(100, Math.max(1, params.limit ?? 20));
    const offset = (page - 1) * limit;

    const conditions: string[] = ['deleted_at IS NULL'];
    const sqlParams: unknown[] = [];

    if (params.status) {
      conditions.push('status = ?');
      sqlParams.push(params.status);
    }

    if (params.search) {
      conditions.push('(original_filename LIKE ? OR filename_stem LIKE ?)');
      sqlParams.push(`%${params.search}%`, `%${params.search}%`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRow = this.db
      .prepare(`SELECT COUNT(*) as total FROM reels ${whereClause}`)
      .get(...(sqlParams as [unknown])) as { total: number };

    const reels = this.db
      .prepare(`SELECT * FROM reels ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...(sqlParams as [unknown]), limit, offset) as ReelRow[];

    const items = reels.map((reel) => {
      const files = this.db
        .prepare<[number]>("SELECT * FROM video_files WHERE reel_id = ? AND state = 'present'")
        .all(reel.id) as VideoFileRow[];

      const approvedCaption = reel.approved_ai_content_id
        ? ((this.db
          .prepare<[number]>('SELECT * FROM ai_content WHERE id = ?')
          .get(reel.approved_ai_content_id) as AiContentRow | undefined) ?? null)
        : null;

      return {
        ...reel,
        files,
        approvedCaption,
      };
    });

    return { items, total: countRow.total };
  }

  // -------------------------------------------------------------------------
  // Video File Upload & Validation Pipeline
  // -------------------------------------------------------------------------

  /**
   * Handle video upload for a Reel.
   * Performs streaming to temp, ffprobe analysis, validation rules,
   * duplicate detection, atomic move, and state transitions.
   */
  async uploadFile(params: {
    reelId: number;
    role: 'censored' | 'raw';
    originalFilename: string;
    stream: NodeJS.ReadableStream;
  }): Promise<{ videoFile: VideoFileRow; validation: ValidationResult }> {
    const reel = this.getReelById(params.reelId);
    if (!reel) {
      throw new Error(`Reel ${params.reelId} not found`);
    }

    // FR-005: Locking check — verify existing file is not leased by a publishing job
    const existingFile = this.db
      .prepare<[number, string]>(
        "SELECT * FROM video_files WHERE reel_id = ? AND role = ? AND state = 'present'",
      )
      .get(params.reelId, params.role) as VideoFileRow | undefined;

    if (existingFile && existingFile.in_use_by_job_id !== null) {
      throw new Error('Cannot replace video file: file is currently in use by an active publishing job');
    }

    const ext = params.originalFilename.slice(params.originalFilename.lastIndexOf('.')).toLowerCase();
    const tempUuid = ulid();
    const tempName = `${tempUuid}${ext}`;
    const storageName = `${ulid()}${ext}`;

    const settings = getSettingsService();
    const maxSizeBytes = (settings.get('upload.max_file_size_bytes') as number) ?? 500 * 1024 * 1024;

    let sizeBytes: number;
    let sha256: string;
    let tempPath: string;

    try {
      // 1. Stream to temp & compute SHA-256
      const streamRes = await this.storage.streamUpload(
        tempName,
        params.stream,
        maxSizeBytes,
      );
      sizeBytes = streamRes.sizeBytes;
      sha256 = streamRes.sha256;
      tempPath = streamRes.tempPath;
    } catch (err) {
      logger.error({ err }, 'Error during storage.streamUpload in uploadFile');
      throw err;
    }

    // 2. Probe with ffprobe
    const metadata: VideoMetadata = await probeVideo(tempPath);
    metadata.sizeBytes = sizeBytes;

    // 3. Validate
    const validation: ValidationResult = validateVideo(
      tempPath,
      params.originalFilename,
      metadata,
      { role: params.role, maxSizeBytes },
    );

    // 4. Duplicate checks (FR-003)
    const duplicateRow = this.db
      .prepare<[string, string, number]>(
        "SELECT reel_id FROM video_files WHERE sha256 = ? AND role = ? AND reel_id != ? AND state = 'present' LIMIT 1",
      )
      .get(sha256, params.role, params.reelId) as { reel_id: number } | undefined;

    if (duplicateRow) {
      validation.warnings.push(
        `Duplicate video content detected: identical file already uploaded for Reel #${duplicateRow.reel_id}`,
      );
    }

    // Check if censored and raw have identical hashes
    const otherRole: 'censored' | 'raw' = params.role === 'censored' ? 'raw' : 'censored';
    const otherFile = this.db
      .prepare<[number, string]>(
        "SELECT sha256 FROM video_files WHERE reel_id = ? AND role = ? AND state = 'present'",
      )
      .get(params.reelId, otherRole) as { sha256: string } | undefined;

    if (otherFile && otherFile.sha256 === sha256) {
      validation.warnings.push('Both censored and raw versions are identical. Please verify raw file is unedited.');
    }

    // 5. Atomic move to final storage
    this.storage.moveToFinal(tempName, storageName, params.role);

    // 6. Quarantine old file if replacing
    if (existingFile) {
      this.storage.quarantineFile(existingFile.storage_name, params.role);
      this.db
        .prepare<[number, number]>(
          "UPDATE video_files SET state = 'quarantined', updated_at = ? WHERE id = ?",
        )
        .run(Date.now(), existingFile.id);
    }

    // 7. Insert new video_files row
    const now = Date.now();
    const insertResult = this.db
      .prepare<[number, string, string, string, number, string, string | null, string | null, string | null, string | null, number | null, number | null, number | null, number | null, number | null, string, string, number, number]>(`
        INSERT INTO video_files (
          reel_id, role, storage_name, original_filename, size_bytes, sha256,
          mime_type, container_format, video_codec, audio_codec,
          duration_ms, width, height, bitrate_bps, fps_milli,
          validation_state, validation_report, state, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, 'present', ?, ?
        )
      `)
      .run(
        params.reelId,
        params.role,
        storageName,
        params.originalFilename,
        sizeBytes,
        sha256,
        'video/mp4',
        metadata.containerFormat,
        metadata.videoCodec,
        metadata.audioCodec,
        metadata.durationMs,
        metadata.width,
        metadata.height,
        metadata.bitrateBps,
        metadata.fpsMilli,
        validation.state,
        JSON.stringify(validation.report),
        now,
        now,
      );

    const videoFileId = insertResult.lastInsertRowid as number;
    const videoFile = this.db
      .prepare<[number]>('SELECT * FROM video_files WHERE id = ?')
      .get(videoFileId) as VideoFileRow;

    // 8. Ready Gate / AI Generation transition
    await this.checkAndUpdateReelState(params.reelId);

    return { videoFile, validation };
  }

  /**
   * Check video file states and advance Reel status.
   * If both censored and raw are valid:
   * - Transition to waiting_for_ai
   * - Trigger Gemini caption generation if not already generated
   */
  async checkAndUpdateReelState(reelId: number): Promise<void> {
    const files = this.db
      .prepare<[number]>("SELECT role, validation_state FROM video_files WHERE reel_id = ? AND state = 'present'")
      .all(reelId) as Array<{ role: string; validation_state: string }>;

    const censored = files.find((f) => f.role === 'censored');
    const raw = files.find((f) => f.role === 'raw');

    const bothPresentAndValid =
      censored &&
      ['valid', 'warning'].includes(censored.validation_state) &&
      raw &&
      ['valid', 'warning'].includes(raw.validation_state);

    const reel = this.getReelById(reelId);
    if (!reel) return;

    if (bothPresentAndValid) {
      if (reel.status === 'draft') {
        const now = Date.now();
        this.db
          .prepare<[number, number]>(
            "UPDATE reels SET status = 'waiting_for_ai', updated_at = ? WHERE id = ?",
          )
          .run(now, reelId);

        logger.info({ reelId }, 'Both video versions valid; Reel moved to waiting_for_ai');

        // Automatically trigger Gemini caption generation
        try {
          const gemini = getGeminiService();
          await gemini.generateCaption(reelId, reel.original_filename);
        } catch (err) {
          logger.warn({ err, reelId }, 'Automatic Gemini caption generation failed; user can generate manually');
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Caption Management & Approval Gate (FR-004)
  // -------------------------------------------------------------------------

  /**
   * Approve a caption version.
   * FR-004: A Reel cannot become Ready until both versions are validated and a caption is approved.
   */
  approveCaption(reelId: number, version: number): { success: boolean; reelStatus: string } {
    const targetCaption = this.db
      .prepare<[number, number]>(
        'SELECT id FROM ai_content WHERE reel_id = ? AND version = ?',
      )
      .get(reelId, version) as { id: number } | undefined;

    if (!targetCaption) {
      throw new Error(`Caption version ${version} not found for Reel ${reelId}`);
    }

    const now = Date.now();

    // In one transaction: supersede others and approve chosen
    const approveTx = this.db.transaction(() => {
      this.db
        .prepare<[number, number]>(
          "UPDATE ai_content SET status = 'superseded', updated_at = ? WHERE reel_id = ? AND status = 'approved'",
        )
        .run(now, reelId);

      this.db
        .prepare<[number, number, number]>(
          "UPDATE ai_content SET status = 'approved', approved_at = ?, updated_at = ? WHERE id = ?",
        )
        .run(now, now, targetCaption.id);

      this.db
        .prepare<[number, number, number]>(
          'UPDATE reels SET approved_ai_content_id = ?, updated_at = ? WHERE id = ?',
        )
        .run(targetCaption.id, now, reelId);
    });

    approveTx();

    // Check Ready Gate (FR-004)
    const files = this.db
      .prepare<[number]>("SELECT role, validation_state FROM video_files WHERE reel_id = ? AND state = 'present'")
      .all(reelId) as Array<{ role: string; validation_state: string }>;

    const censored = files.find((f) => f.role === 'censored');
    const raw = files.find((f) => f.role === 'raw');

    const bothValid =
      censored &&
      ['valid', 'warning'].includes(censored.validation_state) &&
      raw &&
      ['valid', 'warning'].includes(raw.validation_state);

    let newStatus = 'waiting_for_ai';
    if (bothValid) {
      newStatus = 'ready';
      this.db
        .prepare<[number, number]>(
          "UPDATE reels SET status = 'ready', updated_at = ? WHERE id = ?",
        )
        .run(now, reelId);
      logger.info({ reelId }, 'Caption approved and both files valid: Reel is now Ready');
    }

    return { success: true, reelStatus: newStatus };
  }

  /**
   * Add a manual caption version.
   */
  addManualCaption(reelId: number, title: string, hashtags: [string, string]): AiContentRow {
    const maxVersionRow = this.db
      .prepare<[number]>('SELECT COALESCE(MAX(version), 0) as maxVer FROM ai_content WHERE reel_id = ?')
      .get(reelId) as { maxVer: number };
    const version = maxVersionRow.maxVer + 1;

    const now = Date.now();
    const result = this.db
      .prepare<[number, number, string, string, number, number]>(`
        INSERT INTO ai_content (
          reel_id, version, source, input_text, title, hashtags, status, created_at, updated_at
        ) VALUES (?, ?, 'manual', '', ?, ?, 'edited', ?, ?)
      `)
      .run(reelId, version, title, JSON.stringify(hashtags), now, now);

    return this.db
      .prepare<[number]>('SELECT * FROM ai_content WHERE id = ?')
      .get(result.lastInsertRowid as number) as AiContentRow;
  }

  /**
   * Soft-delete a Reel.
   */
  softDelete(reelId: number, actorId?: number): void {
    const now = Date.now();

    // Check if in publishing state
    const reel = this.getReelById(reelId);
    if (!reel) throw new Error('Reel not found');

    if (reel.status === 'publishing') {
      throw new Error('Cannot delete Reel while publishing is in progress');
    }

    this.db
      .prepare<[number, number, number]>(
        "UPDATE reels SET deleted_at = ?, status = 'cancelled', updated_at = ? WHERE id = ?",
      )
      .run(now, now, reelId);

    getAuditService().log({
      actorId: actorId ?? null,
      action: 'reel.delete',
      targetType: 'reel',
      targetId: reel.public_id,
      result: 'success',
    });
  }
}

let _reelService: ReelService | null = null;

export function initReelService(db: Database, storage?: StorageManager): ReelService {
  _reelService = new ReelService(db, storage);
  return _reelService;
}

export function getReelService(): ReelService {
  if (_reelService === null) {
    throw new Error('ReelService has not been initialized.');
  }
  return _reelService;
}
