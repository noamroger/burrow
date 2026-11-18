import type { ErrorCode } from '@burrow/shared';

/**
 * An error that maps to a JSON API response
 * (`{ error: { code, message, details } }`).
 * `message` must always be safe to show to the user: never put secrets in it.
 */
export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly statusCode: number = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/** Shorthand constructors for the most common errors. */
export const errors = {
  notFound: (what = 'Resource') => new AppError('NOT_FOUND', `${what} not found`, 404),
  conflict: (message: string, details?: unknown) => new AppError('CONFLICT', message, 409, details),
  unauthorized: (message = 'Authentication required') => new AppError('UNAUTHORIZED', message, 401),
  validation: (message: string, details?: unknown) =>
    new AppError('VALIDATION_ERROR', message, 400, details),
  cloudflareNotConfigured: () =>
    new AppError(
      'CLOUDFLARE_NOT_CONFIGURED',
      'Cloudflare is not configured yet. Add an API token in Settings first.',
      400,
    ),
};

/** Extract a human readable message from anything thrown. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
