/**
 * Typed fetch wrapper for the Burrow API.
 *
 * - Sends cookies (the session lives in an HttpOnly cookie).
 * - Adds `X-CSRF-Token` to every mutating request (token from GET /api/auth/me).
 * - Turns error bodies (`{ error: { code, message } }`) into `ApiRequestError`.
 * - On 401, notifies a listener so the app can redirect to the login page.
 * - On 403 CSRF_INVALID, refreshes the token once and retries.
 * - Validates responses against the shared zod schemas. A mismatch is logged,
 *   not thrown, so a minor contract drift never blanks the UI.
 */
import { apiErrorSchema, meResponseSchema, type ErrorCode } from '@burrow/shared';
import type { ZodType } from 'zod';

/** Any zod schema whose parsed output is `T`. */
export type Schema<T> = ZodType<T, unknown>;

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export class ApiRequestError extends Error {
  constructor(
    /** HTTP status, or 0 for network failures. */
    readonly status: number,
    /** Error code from the API (`ErrorCode`), or `NETWORK_ERROR`. */
    readonly code: ErrorCode | 'NETWORK_ERROR' | (string & {}),
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

export function isApiError(error: unknown, code?: string): error is ApiRequestError {
  return error instanceof ApiRequestError && (code === undefined || error.code === code);
}

export interface RequestOptions<T> {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Schema used to check the response body. */
  schema?: Schema<T>;
  /** Do not trigger the global 401 handler (used by login, setup and `me`). */
  skipAuthRedirect?: boolean;
  signal?: AbortSignal;
}

export interface ApiClientOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
}

export class ApiClient {
  private csrfToken: string | null = null;
  private unauthorizedListener: (() => void) | null = null;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? '';
    // Bind lazily so tests can stub `globalThis.fetch` after construction.
    this.fetchImpl = options.fetch ?? ((...args) => globalThis.fetch(...args));
  }

  setCsrfToken(token: string | null): void {
    this.csrfToken = token;
  }

  getCsrfToken(): string | null {
    return this.csrfToken;
  }

  /** Register the callback run when the session expires (401). Returns an unsubscribe function. */
  onUnauthorized(listener: () => void): () => void {
    this.unauthorizedListener = listener;
    return () => {
      if (this.unauthorizedListener === listener) this.unauthorizedListener = null;
    };
  }

  async request<T = void>(
    path: string,
    options: RequestOptions<T> = {},
    retried = false,
  ): Promise<T> {
    const method = options.method ?? 'GET';
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (MUTATING.has(method) && this.csrfToken) headers['X-CSRF-Token'] = this.csrfToken;

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/api${path}`, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        credentials: 'same-origin',
        signal: options.signal,
      });
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
      throw new ApiRequestError(0, 'NETWORK_ERROR', 'Cannot reach the Burrow server.');
    }

    if (response.status === 204) return undefined as T;

    const payload: unknown = await response.json().catch(() => undefined);

    if (!response.ok) {
      const parsed = apiErrorSchema.safeParse(payload);
      const error = parsed.success
        ? new ApiRequestError(
            response.status,
            parsed.data.error.code,
            parsed.data.error.message,
            parsed.data.error.details,
          )
        : new ApiRequestError(
            response.status,
            'INTERNAL_ERROR',
            `Request failed with status ${response.status}.`,
          );

      if (response.status === 401) {
        this.csrfToken = null;
        if (!options.skipAuthRedirect) this.unauthorizedListener?.();
      }

      if (response.status === 403 && error.code === 'CSRF_INVALID' && !retried) {
        await this.refreshCsrfToken();
        return this.request(path, options, true);
      }
      throw error;
    }

    if (options.schema) {
      const parsed = options.schema.safeParse(payload);
      if (parsed.success) return parsed.data;
      console.warn(
        `[burrow] Response of ${method} ${path} does not match the API contract`,
        parsed.error.issues,
      );
    }
    return payload as T;
  }

  /** Fetch a fresh CSRF token from GET /api/auth/me. */
  async refreshCsrfToken(): Promise<void> {
    const me = await this.request('/auth/me', { schema: meResponseSchema, skipAuthRedirect: true });
    this.csrfToken = me.csrfToken;
  }

  get<T>(
    path: string,
    schema?: Schema<T>,
    options: Omit<RequestOptions<T>, 'schema' | 'method'> = {},
  ) {
    return this.request<T>(path, { ...options, schema });
  }

  post<T = void>(
    path: string,
    body?: unknown,
    schema?: Schema<T>,
    options: Omit<RequestOptions<T>, 'schema' | 'method' | 'body'> = {},
  ) {
    return this.request<T>(path, { ...options, method: 'POST', body, schema });
  }

  put<T = void>(path: string, body?: unknown, schema?: Schema<T>) {
    return this.request<T>(path, { method: 'PUT', body, schema });
  }

  patch<T = void>(path: string, body?: unknown, schema?: Schema<T>) {
    return this.request<T>(path, { method: 'PATCH', body, schema });
  }

  delete<T = void>(path: string) {
    return this.request<T>(path, { method: 'DELETE' });
  }
}

/** The client used by the app. Tests create their own instances. */
export const api = new ApiClient();
