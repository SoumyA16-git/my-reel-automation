import { randomBytes, createHmac } from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { ValidatedSession } from './session.js';

/** CSRF token header name. */
export const CSRF_HEADER = 'x-csrf-token';

/** Length of CSRF tokens in bytes. */
const TOKEN_BYTES = 32;

/**
 * Generate a CSRF token from the session's CSRF secret.
 * Uses HMAC-SHA256(secret, nonce) so tokens are unguessable but verifiable.
 */
export function generateCsrfToken(csrfSecret: string): string {
  const nonce = randomBytes(TOKEN_BYTES).toString('hex');
  const mac = createHmac('sha256', csrfSecret).update(nonce).digest('hex');
  return `${nonce}.${mac}`;
}

/**
 * Validate a CSRF token against the session's CSRF secret.
 * Returns true if the token is valid.
 */
export function validateCsrfToken(csrfSecret: string, token: string): boolean {
  if (!token || typeof token !== 'string') return false;

  const dotIndex = token.indexOf('.');
  if (dotIndex === -1) return false;

  const nonce = token.slice(0, dotIndex);
  const mac = token.slice(dotIndex + 1);

  if (!nonce || !mac) return false;

  const expectedMac = createHmac('sha256', csrfSecret).update(nonce).digest('hex');

  // Constant-time comparison to avoid timing attacks
  if (expectedMac.length !== mac.length) return false;

  let mismatch = 0;
  for (let i = 0; i < expectedMac.length; i++) {
    mismatch |= expectedMac.charCodeAt(i) ^ mac.charCodeAt(i);
  }

  return mismatch === 0;
}

/**
 * Fastify preHandler to enforce CSRF on state-changing requests.
 * Must be used after session validation (session should be on request).
 */
export async function csrfProtect(
  request: FastifyRequest & { session?: ValidatedSession },
  reply: FastifyReply,
): Promise<void> {
  // Skip safe methods
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;

  const session = request.session;
  if (!session) {
    // Should have been caught by requireAuth first
    return reply.status(401).send({
      code: 'UNAUTHORIZED',
      message: 'Authentication required',
      requestId: request.id,
    });
  }

  const csrfToken = request.headers[CSRF_HEADER];
  if (typeof csrfToken !== 'string' || !validateCsrfToken(session.csrfSecret, csrfToken)) {
    return reply.status(403).send({
      code: 'CSRF_INVALID',
      message: 'Invalid or missing CSRF token',
      requestId: request.id,
    });
  }
}

