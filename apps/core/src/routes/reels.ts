import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { getReelService } from '../reels/ReelService.js';
import { getGeminiService, cleanFilenameForAi } from '../ai/gemini.js';
import { csrfProtect } from '../auth/csrf.js';

const CreateReelSchema = z.object({
  originalFilename: z.string().min(1).max(255),
  priority: z.number().int().optional(),
});

const AddCaptionSchema = z.object({
  title: z.string().min(20).max(150),
  hashtags: z.tuple([z.string(), z.string()]),
});

export function registerReelRoutes(fastify: FastifyInstance): void {
  const reelService = getReelService();

  // -------------------------------------------------------------------------
  // POST /api/v1/reels — create draft Reel
  // -------------------------------------------------------------------------
  fastify.post(
    '/api/v1/reels',
    { preHandler: [csrfProtect] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.session) {
        return reply.status(401).send({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
          requestId: request.id,
        });
      }

      const parseResult = CreateReelSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          code: 'VALIDATION_ERROR',
          message: 'Invalid request body',
          details: parseResult.error.format(),
          requestId: request.id,
        });
      }

      const reel = reelService.createDraft({
        originalFilename: parseResult.data.originalFilename,
        createdBy: request.session.adminId,
        priority: parseResult.data.priority,
      });

      return reply.status(201).send({ reel });
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/v1/reels — list Reels (paginated, searchable, filterable)
  // -------------------------------------------------------------------------
  fastify.get('/api/v1/reels', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.session) {
      return reply.status(401).send({
        code: 'UNAUTHORIZED',
        message: 'Authentication required',
        requestId: request.id,
      });
    }

    const query = request.query as {
      page?: string;
      limit?: string;
      status?: string;
      search?: string;
    };

    const result = reelService.listReels({
      page: query.page ? parseInt(query.page, 10) : 1,
      limit: query.limit ? parseInt(query.limit, 10) : 20,
      status: query.status,
      search: query.search,
    });

    return reply.send(result);
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/reels/:id — get Reel details
  // -------------------------------------------------------------------------
  fastify.get('/api/v1/reels/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.session) {
      return reply.status(401).send({
        code: 'UNAUTHORIZED',
        message: 'Authentication required',
        requestId: request.id,
      });
    }

    const { id } = request.params as { id: string };
    const reelId = parseInt(id, 10);
    const detail = isNaN(reelId)
      ? reelService.getReelByPublicId(id)
      : reelService.getReelDetail(reelId);

    if (!detail) {
      return reply.status(404).send({
        code: 'NOT_FOUND',
        message: 'Reel not found',
        requestId: request.id,
      });
    }

    return reply.send({ reel: detail });
  });

  // -------------------------------------------------------------------------
  // PUT /api/v1/reels/:id/files/:role — streaming upload video file
  // -------------------------------------------------------------------------
  fastify.put(
    '/api/v1/reels/:id/files/:role',
    { preHandler: [csrfProtect] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.session) {
        return reply.status(401).send({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
          requestId: request.id,
        });
      }

      const { id, role } = request.params as { id: string; role: string };
      const reelId = parseInt(id, 10);

      if (isNaN(reelId)) {
        return reply.status(400).send({
          code: 'INVALID_ID',
          message: 'Invalid reel ID',
          requestId: request.id,
        });
      }

      if (role !== 'censored' && role !== 'raw') {
        return reply.status(400).send({
          code: 'INVALID_ROLE',
          message: 'Role must be either "censored" or "raw"',
          requestId: request.id,
        });
      }

      // Check multipart stream
      const part = await request.file();
      if (!part) {
        return reply.status(400).send({
          code: 'NO_FILE',
          message: 'No file found in multipart upload',
          requestId: request.id,
        });
      }

      try {
        const uploadResult = await reelService.uploadFile({
          reelId,
          role,
          originalFilename: part.filename,
          stream: part.file,
        });

        return reply.send({
          success: true,
          videoFile: uploadResult.videoFile,
          validation: uploadResult.validation,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('in use by an active publishing job')) {
          return reply.status(409).send({
            code: 'FILE_LOCKED',
            message,
            requestId: request.id,
          });
        }
        return reply.status(500).send({
          code: 'UPLOAD_FAILED',
          message,
          requestId: request.id,
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /api/v1/reels/:id — soft delete Reel
  // -------------------------------------------------------------------------
  fastify.delete(
    '/api/v1/reels/:id',
    { preHandler: [csrfProtect] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.session) {
        return reply.status(401).send({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
          requestId: request.id,
        });
      }

      const { id } = request.params as { id: string };
      const reelId = parseInt(id, 10);

      try {
        reelService.softDelete(reelId, request.session.adminId);
        return reply.send({ success: true });
      } catch (err) {
        return reply.status(400).send({
          code: 'DELETE_FAILED',
          message: err instanceof Error ? err.message : String(err),
          requestId: request.id,
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/v1/reels/:id/captions/generate — generate caption with Gemini
  // -------------------------------------------------------------------------
  fastify.post(
    '/api/v1/reels/:id/captions/generate',
    { preHandler: [csrfProtect] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.session) {
        return reply.status(401).send({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
          requestId: request.id,
        });
      }

      const { id } = request.params as { id: string };
      const reelId = parseInt(id, 10);
      const reel = reelService.getReelById(reelId);

      if (!reel) {
        return reply.status(404).send({
          code: 'NOT_FOUND',
          message: 'Reel not found',
          requestId: request.id,
        });
      }

      try {
        const gemini = getGeminiService();
        const caption = await gemini.generateCaption(reelId, reel.original_filename);
        return reply.send({ success: true, caption });
      } catch (err) {
        return reply.status(500).send({
          code: 'AI_GENERATION_FAILED',
          message: err instanceof Error ? err.message : String(err),
          requestId: request.id,
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/v1/reels/:id/captions — add manual caption
  // -------------------------------------------------------------------------
  fastify.post(
    '/api/v1/reels/:id/captions',
    { preHandler: [csrfProtect] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.session) {
        return reply.status(401).send({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
          requestId: request.id,
        });
      }

      const { id } = request.params as { id: string };
      const reelId = parseInt(id, 10);

      const parseResult = AddCaptionSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          code: 'VALIDATION_ERROR',
          message: 'Invalid caption format',
          details: parseResult.error.format(),
          requestId: request.id,
        });
      }

      const caption = reelService.addManualCaption(
        reelId,
        parseResult.data.title,
        parseResult.data.hashtags,
      );

      return reply.status(201).send({ caption });
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/v1/reels/:id/captions/:version/approve — approve caption
  // -------------------------------------------------------------------------
  fastify.post(
    '/api/v1/reels/:id/captions/:version/approve',
    { preHandler: [csrfProtect] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.session) {
        return reply.status(401).send({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
          requestId: request.id,
        });
      }

      const { id, version } = request.params as { id: string; version: string };
      const reelId = parseInt(id, 10);
      const ver = parseInt(version, 10);

      try {
        const result = reelService.approveCaption(reelId, ver);
        return reply.send(result);
      } catch (err) {
        return reply.status(400).send({
          code: 'APPROVE_FAILED',
          message: err instanceof Error ? err.message : String(err),
          requestId: request.id,
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/v1/uploads/pair — bulk pairing helper
  // -------------------------------------------------------------------------
  fastify.post('/api/v1/uploads/pair', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.session) {
      return reply.status(401).send({
        code: 'UNAUTHORIZED',
        message: 'Authentication required',
        requestId: request.id,
      });
    }

    const body = request.body as { filenames?: string[] };
    if (!Array.isArray(body?.filenames)) {
      return reply.status(400).send({
        code: 'INVALID_INPUT',
        message: 'filenames array is required',
        requestId: request.id,
      });
    }

    // Group filenames by normalized stem
    const groups = new Map<string, { stem: string; filenames: string[] }>();
    for (const fn of body.filenames) {
      const stem = cleanFilenameForAi(fn);
      if (!groups.has(stem)) {
        groups.set(stem, { stem, filenames: [] });
      }
      groups.get(stem)!.filenames.push(fn);
    }

    const pairs = Array.from(groups.values()).map((g) => ({
      stem: g.stem,
      filenames: g.filenames,
      isCompletePair: g.filenames.length === 2,
    }));

    return reply.send({ pairs });
  });
}

