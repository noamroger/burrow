import { isApiError } from '../api/client';
import { t, type MessageKey } from '../i18n';

/** Friendly messages for error codes where the server message alone is not enough. */
const FRIENDLY: Partial<Record<string, MessageKey>> = {
  NETWORK_ERROR: 'errors.network',
  RATE_LIMITED: 'errors.rateLimited',
  CLOUDFLARE_NOT_CONFIGURED: 'errors.cloudflareNotConfigured',
  CLOUDFLARE_TOKEN_INVALID: 'errors.tokenInvalid',
  CLOUDFLARE_PERMISSION_MISSING: 'errors.permissionMissing',
  DNS_CONFLICT: 'errors.dnsConflict',
};

/** Turn anything thrown by the API client into a message safe to display. */
export function errorMessage(error: unknown): string {
  if (isApiError(error)) {
    const key = FRIENDLY[error.code];
    if (key) {
      // Keep the server detail (e.g. which permission is missing) after our explanation.
      const friendly = t(key);
      return error.message && error.code !== 'NETWORK_ERROR' && error.code !== 'RATE_LIMITED'
        ? `${friendly} ${error.message}`
        : friendly;
    }
    return error.message || t('errors.unknown');
  }
  if (error instanceof Error && error.message) return error.message;
  return t('errors.unknown');
}
