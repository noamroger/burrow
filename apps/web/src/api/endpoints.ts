/**
 * One function per API route, typed with the shared contract.
 * See packages/shared/src/index.ts for the route documentation.
 */
import {
  cloudflareSettingsSchema,
  healthResponseSchema,
  logListSchema,
  meResponseSchema,
  originHealthSchema,
  proxyHostListSchema,
  proxyHostSchema,
  setupStatusSchema,
  syncResultSchema,
  tunnelInfoSchema,
  zoneListSchema,
  zoneSchema,
  type ChangePasswordInput,
  type CreateAdminInput,
  type LoginInput,
  type MeResponse,
  type ProxyHostInput,
  type SaveTokenInput,
  type UpdateZoneInput,
} from '@burrow/shared';
import { api, isApiError } from './client';

export const setupApi = {
  status: () => api.get('/setup/status', setupStatusSchema, { skipAuthRedirect: true }),
  createAdmin: async (input: CreateAdminInput) => {
    const me = await api.post('/setup/admin', input, meResponseSchema, { skipAuthRedirect: true });
    api.setCsrfToken(me.csrfToken);
    return me;
  },
};

export const authApi = {
  /** Returns `null` instead of throwing when nobody is logged in. */
  me: async (): Promise<MeResponse | null> => {
    try {
      const me = await api.get('/auth/me', meResponseSchema, { skipAuthRedirect: true });
      api.setCsrfToken(me.csrfToken);
      return me;
    } catch (error) {
      if (isApiError(error) && error.status === 401) return null;
      throw error;
    }
  },
  login: async (input: LoginInput) => {
    const me = await api.post('/auth/login', input, meResponseSchema, { skipAuthRedirect: true });
    api.setCsrfToken(me.csrfToken);
    return me;
  },
  logout: async () => {
    await api.post('/auth/logout', undefined, undefined, { skipAuthRedirect: true });
    api.setCsrfToken(null);
  },
  changePassword: (input: ChangePasswordInput) => api.post('/auth/password', input),
};

export const cloudflareApi = {
  get: () => api.get('/cloudflare', cloudflareSettingsSchema),
  saveToken: (input: SaveTokenInput) =>
    api.put('/cloudflare/token', input, cloudflareSettingsSchema),
  removeToken: () => api.delete('/cloudflare/token'),
};

export const zonesApi = {
  list: () => api.get('/zones', zoneListSchema),
  update: (id: string, input: UpdateZoneInput) =>
    api.patch(`/zones/${encodeURIComponent(id)}`, input, zoneSchema),
};

export const tunnelApi = {
  get: () => api.get('/tunnel', tunnelInfoSchema),
  start: () => api.post('/tunnel/start'),
  stop: () => api.post('/tunnel/stop'),
  restart: () => api.post('/tunnel/restart'),
};

export const hostsApi = {
  list: () => api.get('/hosts', proxyHostListSchema),
  create: (input: ProxyHostInput) => api.post('/hosts', input, proxyHostSchema),
  update: (id: number, input: ProxyHostInput) => api.put(`/hosts/${id}`, input, proxyHostSchema),
  remove: (id: number) => api.delete(`/hosts/${id}`),
  check: (id: number) => api.post(`/hosts/${id}/check`, undefined, originHealthSchema),
};

export const syncApi = {
  last: () => api.get('/sync', syncResultSchema),
  run: () => api.post('/sync', undefined, syncResultSchema),
};

export const logsApi = {
  list: (limit = 500) => api.get(`/logs?limit=${limit}`, logListSchema),
  /** URL of the Server-Sent Events stream, consumed with EventSource. */
  streamUrl: '/api/logs/stream',
};

export const healthApi = {
  get: () => api.get('/health', healthResponseSchema, { skipAuthRedirect: true }),
};
