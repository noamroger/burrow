import type { ApiError, ErrorCode } from '@burrow/shared';
import type { FastifyError, FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { AppError } from '../lib/errors.js';

function body(code: ErrorCode, message: string, details?: unknown): ApiError {
  return details === undefined
    ? { error: { code, message } }
    : { error: { code, message, details } };
}

function codeForStatus(status: number): ErrorCode {
  if (status === 401) return 'UNAUTHORIZED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'CONFLICT';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'INTERNAL_ERROR';
  return 'VALIDATION_ERROR';
}

/** Every error leaves the API as `{ error: { code, message, details? } }`. */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | Error, req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send(
        body(
          'VALIDATION_ERROR',
          err.issues[0]
            ? `${err.issues[0].path.join('.') || 'body'}: ${err.issues[0].message}`
            : 'Invalid request',
          err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        ),
      );
    }
    if (err instanceof AppError) {
      if (err.statusCode >= 500)
        req.log.warn({ code: err.code, err: err.message }, 'request failed');
      return reply.status(err.statusCode).send(body(err.code, err.message, err.details));
    }
    const status = (err as FastifyError).statusCode;
    if (status && status < 500) {
      return reply.status(status).send(body(codeForStatus(status), err.message));
    }
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send(body('INTERNAL_ERROR', 'Internal server error'));
  });
}
