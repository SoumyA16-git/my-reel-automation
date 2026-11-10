import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { type Database } from 'better-sqlite3';
import { createReadStream, statSync, existsSync } from 'node:fs';
import { getStorageManager, type StorageRole } from '../storage/StorageManager.js';
import type { VideoFileRow } from '../reels/ReelService.js';

export function registerMediaRoutes(fastify: FastifyInstance, db: Database): void {
  const storage = getStorageManager();

  // -------------------------------------------------------------------------
  // GET /api/v1/media/:fileId/stream — authenticated range video preview (SEC-006)
  // -------------------------------------------------------------------------
  fastify.get('/api/v1/media/:fileId/stream', async (request: FastifyRequest, reply: FastifyReply) => {
    // SEC-006: Videos are never publicly accessible
    if (!request.session) {
      return reply.status(401).send({
        code: 'UNAUTHORIZED',
        message: 'Authentication required to stream media',
        requestId: request.id,
      });
    }

    const { fileId } = request.params as { fileId: string };
    const id = parseInt(fileId, 10);

    if (isNaN(id)) {
      return reply.status(400).send({
        code: 'INVALID_ID',
        message: 'Invalid file ID',
        requestId: request.id,
      });
    }

    const videoFile = db
      .prepare<[number]>('SELECT * FROM video_files WHERE id = ?')
      .get(id) as VideoFileRow | undefined;

    if (!videoFile) {
      return reply.status(404).send({
        code: 'FILE_NOT_FOUND',
        message: 'Video file record not found',
        requestId: request.id,
      });
    }

    let filePath: string;
    try {
      filePath = storage.resolveStoragePath(videoFile.storage_name, videoFile.role as StorageRole);
    } catch {
      return reply.status(400).send({
        code: 'INVALID_PATH',
        message: 'Invalid video file path',
        requestId: request.id,
      });
    }

    if (!existsSync(filePath)) {
      return reply.status(404).send({
        code: 'FILE_MISSING_ON_DISK',
        message: 'Video file does not exist on disk',
        requestId: request.id,
      });
    }

    const stat = statSync(filePath);
    const fileSize = stat.size;
    const rangeHeader = request.headers.range;

    const mimeType = videoFile.mime_type || 'video/mp4';

    if (rangeHeader) {
      // Range header format: "bytes=start-end"
      const parts = rangeHeader.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0]!, 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

      if (start >= fileSize || end >= fileSize || start > end) {
        reply.header('Content-Range', `bytes */${fileSize}`);
        return reply.status(416).send({ code: 'RANGE_NOT_SATISFIABLE' });
      }

      const chunkSize = end - start + 1;
      const fileStream = createReadStream(filePath, { start, end });

      reply.status(206);
      reply.headers({
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': mimeType,
      });

      return reply.send(fileStream);
    } else {
      const fileStream = createReadStream(filePath);
      reply.headers({
        'Content-Length': fileSize,
        'Content-Type': mimeType,
        'Accept-Ranges': 'bytes',
      });

      return reply.send(fileStream);
    }
  });
}

