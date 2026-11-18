import { pino, type Logger, type LoggerOptions } from 'pino';
import { scrubSecrets } from './scrub.js';

export type { Logger };

/** Object paths pino must never print. */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  'token',
  'password',
  'secret',
  '*.token',
  '*.password',
  '*.secret',
  '*.currentPassword',
  '*.newPassword',
  'headers.authorization',
];

/**
 * Create the application logger. Besides path-based redaction, every string
 * argument is passed through {@link scrubSecrets} so a token accidentally
 * interpolated into a message is still hidden.
 */
export function createLogger(level: LoggerOptions['level'] = 'info'): Logger {
  return pino({
    level,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    hooks: {
      logMethod(args, method) {
        const cleaned = args.map((a: unknown) => (typeof a === 'string' ? scrubSecrets(a) : a));
        method.apply(this, cleaned as Parameters<typeof method>);
      },
    },
  });
}
