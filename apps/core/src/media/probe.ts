import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../logger.js';

const execFileAsync = promisify(execFile);

export interface VideoMetadata {
  containerFormat: string;
  videoCodec: string | null;
  audioCodec: string | null;
  durationMs: number;
  width: number | null;
  height: number | null;
  bitrateBps: number | null;
  fpsMilli: number | null;
  sizeBytes: number;
}

interface FFprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  duration?: string;
  bit_rate?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
}

interface FFprobeFormat {
  format_name?: string;
  duration?: string;
  size?: string;
  bit_rate?: string;
}

interface FFprobeOutput {
  streams?: FFprobeStream[];
  format?: FFprobeFormat;
}

/**
 * Parse fractional frame rate string (e.g. "30/1" or "30000/1001") into fps × 1000 integer.
 */
function parseFpsMilli(rateStr?: string): number | null {
  if (!rateStr || rateStr === '0/0') return null;
  const parts = rateStr.split('/');
  if (parts.length === 2) {
    const num = parseFloat(parts[0]!);
    const den = parseFloat(parts[1]!);
    if (den > 0) {
      return Math.round((num / den) * 1000);
    }
  }
  const direct = parseFloat(rateStr);
  return isNaN(direct) ? null : Math.round(direct * 1000);
}

/**
 * Probe a video file using ffprobe.
 * Extracts container, codecs, duration, dimensions, bitrate, and frame rate.
 */
export async function probeVideo(filePath: string): Promise<VideoMetadata> {
  const args = [
    '-v',
    'quiet',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    filePath,
  ];

  try {
    const { stdout } = await execFileAsync('ffprobe', args, {
      maxBuffer: 10 * 1024 * 1024, // 10 MB buffer
      timeout: 30000, // 30s timeout
    });

    const parsed: FFprobeOutput = JSON.parse(stdout);

    const videoStream = parsed.streams?.find((s) => s.codec_type === 'video');
    const audioStream = parsed.streams?.find((s) => s.codec_type === 'audio');
    const format = parsed.format;

    // Determine duration in milliseconds
    let durationSeconds = 0;
    if (format?.duration) {
      durationSeconds = parseFloat(format.duration);
    } else if (videoStream?.duration) {
      durationSeconds = parseFloat(videoStream.duration);
    }

    const durationMs = Math.round(durationSeconds * 1000);

    // Frame rate
    const fpsMilli = parseFpsMilli(videoStream?.r_frame_rate) ?? parseFpsMilli(videoStream?.avg_frame_rate);

    // Bitrate
    let bitrateBps: number | null = null;
    if (format?.bit_rate) {
      bitrateBps = parseInt(format.bit_rate, 10);
    } else if (videoStream?.bit_rate) {
      bitrateBps = parseInt(videoStream.bit_rate, 10);
    }

    return {
      containerFormat: format?.format_name ?? 'unknown',
      videoCodec: videoStream?.codec_name ?? null,
      audioCodec: audioStream?.codec_name ?? null,
      durationMs,
      width: videoStream?.width ?? null,
      height: videoStream?.height ?? null,
      bitrateBps,
      fpsMilli,
      sizeBytes: format?.size ? parseInt(format.size, 10) : 0,
    };
  } catch (err) {
    logger.error({ err, filePath }, 'ffprobe failed to parse video');
    throw new Error(`Video probe failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

