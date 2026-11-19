/**
 * TanStack Query hooks. Components never call `fetch` directly: they use these
 * hooks, which share caching, polling and invalidation rules.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  OriginHealth,
  ProxyHost,
  ProxyHostInput,
  ProxyHostList,
  UpdateTunnelInput,
} from '@burrow/shared';
import {
  authApi,
  cloudflareApi,
  healthApi,
  hostsApi,
  setupApi,
  syncApi,
  tunnelApi,
  tunnelsApi,
  tokensApi,
  configApi,
  driftApi,
  dockerApi,
  maintenanceApi,
  backupsApi,
  zonesApi,
} from './endpoints';

export const queryKeys = {
  setupStatus: ['setup', 'status'] as const,
  me: ['auth', 'me'] as const,
  cloudflare: ['cloudflare'] as const,
  zones: ['zones'] as const,
  tunnel: ['tunnel'] as const,
  tunnels: ['tunnels'] as const,
  tunnelInfo: (id: number) => ['tunnels', id] as const,
  availableTunnels: ['tunnels', 'available'] as const,
  hosts: ['hosts'] as const,
  sync: ['sync'] as const,
  logs: ['logs'] as const,
  health: ['health'] as const,
  tokens: ['tokens'] as const,
  drift: ['drift'] as const,
  backups: ['backups'] as const,
  docker: ['docker'] as const,
  maintenancePage: ['maintenance', 'page'] as const,
};

/** Polling intervals (ms). */
export const POLL = { hosts: 15_000, tunnel: 10_000 } as const;

/* ---------------------------- setup & auth ---------------------------- */

export function useSetupStatus() {
  return useQuery({ queryKey: queryKeys.setupStatus, queryFn: setupApi.status, staleTime: 30_000 });
}

export function useMe() {
  return useQuery({ queryKey: queryKeys.me, queryFn: authApi.me, staleTime: 5 * 60_000 });
}

export function useCreateAdmin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: setupApi.createAdmin,
    onSuccess: (me) => {
      qc.setQueryData(queryKeys.me, me);
      return qc.invalidateQueries({ queryKey: queryKeys.setupStatus });
    },
  });
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: authApi.login,
    onSuccess: (me) => {
      qc.setQueryData(queryKeys.me, me);
      return qc.invalidateQueries({ queryKey: queryKeys.setupStatus });
    },
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: authApi.logout,
    onSettled: () => {
      // Drop every cached resource: nothing should survive a logout.
      qc.removeQueries({
        predicate: (q) => q.queryKey[0] !== 'setup' && q.queryKey[0] !== 'health',
      });
      qc.setQueryData(queryKeys.me, null);
    },
  });
}

export function useChangePassword() {
  return useMutation({ mutationFn: authApi.changePassword });
}

/* ----------------------------- cloudflare ----------------------------- */

export function useCloudflareSettings(enabled = true) {
  return useQuery({ queryKey: queryKeys.cloudflare, queryFn: cloudflareApi.get, enabled });
}

export function useSaveToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: cloudflareApi.saveToken,
    onSuccess: (settings) => {
      qc.setQueryData(queryKeys.cloudflare, settings);
      void qc.invalidateQueries({ queryKey: queryKeys.setupStatus });
      void qc.invalidateQueries({ queryKey: queryKeys.zones });
      void qc.invalidateQueries({ queryKey: queryKeys.tunnel });
    },
  });
}

export function useRemoveToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: cloudflareApi.removeToken,
    onSuccess: () => qc.invalidateQueries(),
  });
}

/* -------------------------------- zones ------------------------------- */

export function useZones(enabled = true) {
  return useQuery({
    queryKey: queryKeys.zones,
    queryFn: zonesApi.list,
    enabled,
    select: (d) => d.zones,
  });
}

export function useUpdateZone() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      zonesApi.update(id, { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.zones }),
  });
}

/* ------------------------------- tunnel ------------------------------- */

export function useTunnel() {
  return useQuery({
    queryKey: queryKeys.tunnel,
    queryFn: tunnelApi.get,
    refetchInterval: POLL.tunnel,
  });
}

export function useTunnelAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (action: 'start' | 'stop' | 'restart') => tunnelApi[action](),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.tunnel }),
  });
}

/* ------------------------------ tunnels ------------------------------- */

export function useTunnels() {
  return useQuery({
    queryKey: queryKeys.tunnels,
    queryFn: tunnelsApi.list,
    refetchInterval: POLL.tunnel,
    select: (d) => d.tunnels,
  });
}

export function useTunnelInfo(id: number | undefined) {
  return useQuery({
    queryKey: queryKeys.tunnelInfo(id ?? 0),
    queryFn: () => tunnelsApi.get(id!),
    enabled: id !== undefined,
    refetchInterval: POLL.tunnel,
  });
}

export function useAvailableTunnels(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.availableTunnels,
    queryFn: tunnelsApi.available,
    enabled,
    select: (d) => d.tunnels,
  });
}

/** Refresh everything that depends on the tunnel list. */
function invalidateTunnels(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: queryKeys.tunnels });
  void qc.invalidateQueries({ queryKey: queryKeys.tunnel });
  void qc.invalidateQueries({ queryKey: queryKeys.hosts });
  void qc.invalidateQueries({ queryKey: queryKeys.zones });
}

export function useCreateTunnel() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: tunnelsApi.create, onSuccess: () => invalidateTunnels(qc) });
}

export function useImportTunnel() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: tunnelsApi.import, onSuccess: () => invalidateTunnels(qc) });
}

export function useUpdateTunnel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: number; input: UpdateTunnelInput }) =>
      tunnelsApi.update(id, input),
    onSuccess: () => invalidateTunnels(qc),
  });
}

export function useDeleteTunnel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, deleteOnCloudflare }: { id: number; deleteOnCloudflare: boolean }) =>
      tunnelsApi.remove(id, deleteOnCloudflare),
    onSuccess: () => invalidateTunnels(qc),
  });
}

export function useTunnelControl() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: number; action: 'start' | 'stop' | 'restart' }) =>
      tunnelsApi.action(id, action),
    onSuccess: (_s, { id }) => {
      void qc.invalidateQueries({ queryKey: queryKeys.tunnelInfo(id) });
      void qc.invalidateQueries({ queryKey: queryKeys.tunnels });
      void qc.invalidateQueries({ queryKey: queryKeys.tunnel });
    },
  });
}

/* ------------------------------- drift -------------------------------- */

export function useDrift() {
  return useQuery({ queryKey: queryKeys.drift, queryFn: driftApi.get, refetchInterval: 60_000 });
}

export function useCheckDrift() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: driftApi.check,
    onSuccess: (report) => {
      qc.setQueryData(queryKeys.drift, report);
      void qc.invalidateQueries({ queryKey: queryKeys.hosts });
    },
  });
}

export function useResolveDrift() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: driftApi.resolve,
    onSuccess: (report) => {
      qc.setQueryData(queryKeys.drift, report);
      invalidateTunnels(qc);
    },
  });
}

export function useDriftSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: driftApi.settings,
    onSuccess: (report) => qc.setQueryData(queryKeys.drift, report),
  });
}

/* ----------------------------- maintenance ---------------------------- */

export function useMaintenancePage() {
  return useQuery({ queryKey: queryKeys.maintenancePage, queryFn: maintenanceApi.page });
}

export function useSaveMaintenancePage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: maintenanceApi.savePage,
    onSuccess: (page) => qc.setQueryData(queryKeys.maintenancePage, page),
  });
}

export function useHostMaintenance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      input,
    }: {
      id: number;
      input: Parameters<typeof maintenanceApi.setHost>[1];
    }) => maintenanceApi.setHost(id, input),
    onSettled: () => void qc.invalidateQueries({ queryKey: queryKeys.hosts }),
  });
}

/* ------------------------------- docker ------------------------------- */

export function useDocker() {
  return useQuery({ queryKey: queryKeys.docker, queryFn: dockerApi.get, refetchInterval: 30_000 });
}

function useDockerMutation<T>(fn: (arg: T) => ReturnType<typeof dockerApi.get>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (status) => {
      qc.setQueryData(queryKeys.docker, status);
      void qc.invalidateQueries({ queryKey: queryKeys.hosts });
    },
  });
}

export function useDockerScan() {
  return useDockerMutation<void>(() => dockerApi.scan());
}

export function useDockerSettings() {
  return useDockerMutation<boolean>(dockerApi.setEnabled);
}

/* ------------------------------- backups ------------------------------ */

export function useBackups() {
  return useQuery({ queryKey: queryKeys.backups, queryFn: backupsApi.get });
}

export function useSaveBackups() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: backupsApi.save,
    onSuccess: (status) => qc.setQueryData(queryKeys.backups, status),
  });
}

export function useRunBackup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: backupsApi.run,
    onSettled: () => void qc.invalidateQueries({ queryKey: queryKeys.backups }),
  });
}

/* ------------------------------ API tokens ---------------------------- */

export function useApiTokens() {
  return useQuery({ queryKey: queryKeys.tokens, queryFn: tokensApi.list, select: (d) => d.tokens });
}

export function useCreateApiToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: tokensApi.create,
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.tokens }),
  });
}

export function useDeleteApiToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: tokensApi.remove,
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.tokens }),
  });
}

/* ---------------------------- configuration --------------------------- */

export function useImportConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: configApi.import,
    onSuccess: (report) => {
      if (!report.dryRun) invalidateTunnels(qc);
    },
  });
}

/* -------------------------------- hosts ------------------------------- */

export function useHosts() {
  return useQuery({
    queryKey: queryKeys.hosts,
    queryFn: hostsApi.list,
    refetchInterval: POLL.hosts,
    select: (d) => d.hosts,
  });
}

function upsertHost(list: ProxyHostList | undefined, host: ProxyHost): ProxyHostList | undefined {
  if (!list) return list;
  const exists = list.hosts.some((h) => h.id === host.id);
  return {
    hosts: exists ? list.hosts.map((h) => (h.id === host.id ? host : h)) : [...list.hosts, host],
  };
}

export function useSaveHost() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id?: number; input: ProxyHostInput }) =>
      id === undefined ? hostsApi.create(input) : hostsApi.update(id, input),
    onSuccess: (host) => {
      qc.setQueryData<ProxyHostList>(queryKeys.hosts, (old) => upsertHost(old, host));
      void qc.invalidateQueries({ queryKey: queryKeys.hosts });
      void qc.invalidateQueries({ queryKey: queryKeys.zones });
    },
  });
}

export function useDeleteHost() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => hostsApi.remove(id),
    onSuccess: (_void, id) => {
      qc.setQueryData<ProxyHostList>(queryKeys.hosts, (old) =>
        old ? { hosts: old.hosts.filter((h) => h.id !== id) } : old,
      );
      void qc.invalidateQueries({ queryKey: queryKeys.zones });
    },
  });
}

export function useCheckHost() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => hostsApi.check(id),
    onSuccess: (health: OriginHealth, id) => {
      qc.setQueryData<ProxyHostList>(queryKeys.hosts, (old) =>
        old ? { hosts: old.hosts.map((h) => (h.id === id ? { ...h, health } : h)) } : old,
      );
    },
  });
}

/* -------------------------------- sync -------------------------------- */

export function useRunSync() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: syncApi.run,
    onSuccess: (result) => {
      qc.setQueryData(queryKeys.sync, result);
      void qc.invalidateQueries({ queryKey: queryKeys.hosts });
      void qc.invalidateQueries({ queryKey: queryKeys.tunnel });
    },
  });
}

/* -------------------------------- health ------------------------------- */

export function useHealth() {
  return useQuery({
    queryKey: queryKeys.health,
    queryFn: healthApi.get,
    staleTime: 5 * 60_000,
    retry: false,
  });
}
