import { openSync, readSync, closeSync } from 'node:fs';
import { extname } from 'node:path';
import type { VideoMetadata } from './probe.js';

export interface ValidationResult {
  state: 'valid' | 'warning' | 'invalid';
  errors: string[];
  warnings: string[];
  report: {
    checks: Record<string, boolean>;
    errors: string[];
    warnings: string[];
    metadata: VideoMetadata;
  };
}

export interface ValidationOptions {
  role: 'censored' | 'raw';
  allowedExtensions?: string[];
  maxSizeBytes?: number;
  telegramCloudLimitBytes?: number;
}

const DEFAULT_ALLOWED_EXTENSIONS = ['.mp4', '.mov'];
const DEFAULT_MAX_SIZE_BYTES = 500 * 1024 * 1024; // 500 MB
const DEFAULT_TELEGRAM_CLOUD_LIMIT = 50 * 1024 * 1024; // 50 MB

/**
 * Check magic bytes of a file to verify video container.
 * MP4/MOV files typically have 'ftyp' or 'moov' at byte offset 4..8.
 */
export function checkVideoMagicBytes(filePath: string): boolean {
  try {
    const fd = openSync(filePath, 'r');
    const buffer = Buffer.alloc(16);
    const bytesRead = readSync(fd, buffer, 0, 16, 0);
    closeSync(fd);

    if (bytesRead < 8) return false;

    // Check for MP4/MOV/QuickTime container signatures (ftyp at offset 4, or moov/mdat/wide)
    const tag = buffer.toString('latin1', 4, 8);
    const validTags = ['ftyp', 'moov', 'mdat', 'wide', 'skip', 'free', 'pnot'];
    if (validTags.includes(tag)) {
      return true;
    }

    // Alternatively check first 4 bytes for QuickTime or other MP4 atoms
    const firstFour = buffer.toString('latin1', 0, 4);
    if (validTags.includes(firstFour)) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Validate a video file according to ReelHub PRD Section 7.2 rules.
 */
export function validateVideo(
  filePath: string,
  originalFilename: string,
  metadata: VideoMetadata,
  options: ValidationOptions,
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const checks: Record<string, boolean> = {};

  const allowedExtensions = options.allowedExtensions ?? DEFAULT_ALLOWED_EXTENSIONS;
  const maxSizeBytes = options.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES;
  const telegramLimit = options.telegramCloudLimitBytes ?? DEFAULT_TELEGRAM_CLOUD_LIMIT;

  // 1. Extension check
  const ext = extname(originalFilename).toLowerCase();
  const extensionValid = allowedExtensions.includes(ext);
  checks['extension'] = extensionValid;
  if (!extensionValid) {
    errors.push(`Invalid file extension "${ext}". Allowed: ${allowedExtensions.join(', ')}`);
  }

  // 2. Magic bytes / container signature check
  const magicBytesValid = checkVideoMagicBytes(filePath);
  checks['magic_bytes'] = magicBytesValid;
  if (!magicBytesValid) {
    errors.push('File container header does not match a valid MP4 or MOV video signature');
  }

  // 3. File size check
  const sizeValid = metadata.sizeBytes <= maxSizeBytes;
  checks['size_limit'] = sizeValid;
  if (!sizeValid) {
    const sizeMb = (metadata.sizeBytes / (1024 * 1024)).toFixed(1);
    const maxMb = (maxSizeBytes / (1024 * 1024)).toFixed(0);
    errors.push(`File size (${sizeMb} MB) exceeds maximum allowed limit of ${maxMb} MB`);
  }

  // Telegram cloud bot API limit warning for raw video
  if (options.role === 'raw' && metadata.sizeBytes > telegramLimit) {
    const sizeMb = (metadata.sizeBytes / (1024 * 1024)).toFixed(1);
    warnings.push(
      `Raw video is ${sizeMb} MB, which exceeds Telegram Cloud Bot API 50 MB limit. ` +
      'Requires self-hosted Telegram Bot API server to publish.',
    );
  }

  // 4. Video stream playable check
  const hasVideoStream = Boolean(metadata.videoCodec && metadata.width && metadata.height);
  checks['video_stream_present'] = hasVideoStream;
  if (!hasVideoStream) {
    errors.push('No playable video stream detected in file');
  }

  // 5. Duration check
  const durationValid = metadata.durationMs > 0;
  checks['duration_positive'] = durationValid;
  if (!durationValid) {
    errors.push('Video duration must be greater than 0');
  }

  // 6. Platform-specific validation
  if (options.role === 'censored') {
    // Facebook requirement: Minimum resolution 540p. Meta rejects < 540p at processing.
    const minDimension = Math.min(metadata.width ?? 0, metadata.height ?? 0);
    const meetsFbMin = minDimension >= 540;
    checks['facebook_min_540p'] = meetsFbMin;
    if (!meetsFbMin) {
      errors.push(
        `Resolution (${metadata.width}x${metadata.height}) is below Facebook minimum 540p. Meta will reject this Reel.`,
      );
    }

    // Instagram warnings (non-blocking)
    if (metadata.durationMs < 3000) {
      warnings.push('Duration is under 3 seconds (Instagram Reels recommend at least 3 seconds)');
    } else if (metadata.durationMs > 15 * 60 * 1000) {
      warnings.push('Duration exceeds 15 minutes (Instagram Reels maximum duration)');
    }

    if (metadata.fpsMilli) {
      const fps = metadata.fpsMilli / 1000;
      if (fps < 23 || fps > 60) {
        warnings.push(`Frame rate (${fps.toFixed(1)} fps) is outside Instagram recommendation of 23-60 fps`);
      }
    }

    if (metadata.width && metadata.height) {
      if (metadata.width > metadata.height) {
        warnings.push('Video is landscape (width > height); 9:16 vertical orientation is recommended for Reels');
      }
    }
  }

  const state: 'valid' | 'warning' | 'invalid' =
    errors.length > 0 ? 'invalid' : warnings.length > 0 ? 'warning' : 'valid';

  return {
    state,
    errors,
    warnings,
    report: {
      checks,
      errors,
      warnings,
      metadata,
    },
  };
}

