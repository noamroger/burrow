/**
 * One function per API route, typed with the shared contract.
 * See packages/shared/src/index.ts for the route documentation.
 */
import {
  apiTokenListSchema,
  availableTunnelListSchema,
  configImportReportSchema,
  backupRunSchema,
  backupStatusSchema,
  type BackupSettingsInput,
  driftReportSchema,
  createdApiTokenSchema,
  cloudflareSettingsSchema,
  importTunnelResultSchema,
  supervisorStatusSchema,
  tunnelListSchema,
  tunnelSummarySchema,
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
  type ConfigImportInput,
  type CreateAdminInput,
  type CreateTunnelInput,
  type ImportTunnelInput,
  type UpdateTunnelInput,
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

export const tunnelsApi = {
  list: () => api.get('/tunnels', tunnelListSchema),
  get: (id: number) => api.get(`/tunnels/${id}`, tunnelInfoSchema),
  available: () => api.get('/tunnels/available', availableTunnelListSchema),
  create: (input: CreateTunnelInput) => api.post('/tunnels', input, tunnelSummarySchema),
  import: (input: ImportTunnelInput) =>
    api.post('/tunnels/import', input, importTunnelResultSchema),
  update: (id: number, input: UpdateTunnelInput) =>
    api.patch(`/tunnels/${id}`, input, tunnelSummarySchema),
  remove: (id: number, deleteOnCloudflare: boolean) =>
    api.delete(`/tunnels/${id}?deleteOnCloudflare=${deleteOnCloudflare}`),
  action: (id: number, action: 'start' | 'stop' | 'restart') =>
    api.post(`/tunnels/${id}/${action}`, undefined, supervisorStatusSchema),
};

export const tokensApi = {
  list: () => api.get('/tokens', apiTokenListSchema),
  create: (name: string) => api.post('/tokens', { name }, createdApiTokenSchema),
  remove: (id: number) => api.delete(`/tokens/${id}`),
};

export const configApi = {
  /** Downloaded by the browser (GET with the session cookie, no CSRF needed). */
  exportUrl: '/api/config/export',
  import: (input: ConfigImportInput) => api.post('/config/import', input, configImportReportSchema),
};

export const docsUrl = '/api/docs/';

export const driftApi = {
  get: () => api.get('/drift', driftReportSchema),
  check: () => api.post('/drift/check', undefined, driftReportSchema),
  resolve: (strategy: 'revert' | 'keep') =>
    api.post('/drift/resolve', { strategy }, driftReportSchema),
  settings: (autoRepair: boolean) => api.put('/drift/settings', { autoRepair }, driftReportSchema),
};

export const backupsApi = {
  get: () => api.get('/backups', backupStatusSchema),
  save: (input: BackupSettingsInput) => api.put('/backups/settings', input, backupStatusSchema),
  run: () => api.post('/backups', undefined, backupRunSchema),
  /** Downloaded by the browser (GET with the session cookie). */
  downloadUrl: (name: string) => `/api/backups/${encodeURIComponent(name)}`,
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
