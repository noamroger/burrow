/**
 * Live cloudflared logs.
 *
 * 1. Loads the backlog with GET /api/logs?limit=500.
 * 2. Opens an EventSource on /api/logs/stream and appends `log` events.
 *    `state` events (supervisor changes) are written into the tunnel query
 *    cache so the Tunnel page updates instantly, without waiting for polling.
 * 3. Reconnection: the browser retries on its own (sending Last-Event-ID).
 *    If the stream is closed for good (server restart, 401, proxy timeout) we
 *    reopen it with exponential backoff and refetch the backlog, merging lines
 *    by their sequence number so nothing is duplicated.
 */
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  logLineSchema,
  supervisorStatusSchema,
  type LogLine,
  type TunnelInfo,
  type TunnelList,
} from '@burrow/shared';
import { z } from 'zod';
import { logsApi } from '../api/endpoints';
import { queryKeys } from '../api/queries';

export type StreamStatus = 'connecting' | 'live' | 'reconnecting';

export interface UseLogStreamOptions {
  /** Lines fetched on (re)connect. */
  backlog?: number;
  /** Maximum lines kept in memory. Matches the server ring buffer. */
  max?: number;
}

const supervisorSchema = supervisorStatusSchema.extend({
  tunnelId: z.number().int().nullable().optional(),
});

/** Merge lines by `seq`, keeping order and at most `max` lines. Exported for tests. */
export function mergeLogLines(prev: LogLine[], incoming: LogLine[], max: number): LogLine[] {
  if (incoming.length === 0) return prev;
  const last = prev.at(-1)?.seq ?? -Infinity;
  // Fast path: a single new line from the stream.
  if (incoming.length === 1 && incoming[0]!.seq > last) {
    const next = [...prev, incoming[0]!];
    return next.length > max ? next.slice(next.length - max) : next;
  }
  // The server restarted and its sequence starts over: replace everything.
  const incomingLast = incoming.at(-1)!.seq;
  if (incomingLast < (prev[0]?.seq ?? -Infinity)) return incoming.slice(-max);

  const bySeq = new Map<number, LogLine>();
  for (const line of prev) bySeq.set(line.seq, line);
  for (const line of incoming) bySeq.set(line.seq, line);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq).slice(-max);
}

export function useLogStream({ backlog = 500, max = 2000 }: UseLogStreamOptions = {}) {
  const qc = useQueryClient();
  const [lines, setLines] = useState<LogLine[]>([]);
  const [status, setStatus] = useState<StreamStatus>('connecting');

  useEffect(() => {
    let source: EventSource | null = null;
    let retryTimer: number | undefined;
    let attempt = 0;
    let disposed = false;

    const merge = (incoming: LogLine[]) => setLines((prev) => mergeLogLines(prev, incoming, max));

    const scheduleReconnect = () => {
      const delay = Math.min(30_000, 1000 * 2 ** attempt);
      attempt++;
      setStatus('reconnecting');
      retryTimer = window.setTimeout(connect, delay);
    };

    async function connect() {
      if (disposed) return;
      try {
        const { lines: initial } = await logsApi.list(backlog);
        if (disposed) return;
        merge(initial);
      } catch {
        // Not fatal: the stream may still work, and we retry on stream errors.
      }
      if (disposed) return;

      source = new EventSource(logsApi.streamUrl);
      source.onopen = () => {
        attempt = 0;
        setStatus('live');
      };
      source.addEventListener('log', (event) => {
        const parsed = logLineSchema.safeParse(safeJson((event as MessageEvent<string>).data));
        if (parsed.success) merge([parsed.data]);
      });
      source.addEventListener('state', (event) => {
        const parsed = supervisorSchema.safeParse(safeJson((event as MessageEvent<string>).data));
        if (!parsed.success) return;
        const { tunnelId, ...supervisor } = parsed.data;
        if (tunnelId != null) {
          qc.setQueryData<TunnelInfo>(queryKeys.tunnelInfo(tunnelId), (old) =>
            old ? { ...old, supervisor } : old,
          );
          qc.setQueryData<TunnelList>(queryKeys.tunnels, (old) =>
            old
              ? {
                  tunnels: old.tunnels.map((x) => (x.id === tunnelId ? { ...x, supervisor } : x)),
                }
              : old,
          );
        }
        void qc.invalidateQueries({ queryKey: queryKeys.tunnel });
      });
      source.onerror = () => {
        if (!source || source.readyState === EventSource.CLOSED) {
          source?.close();
          source = null;
          scheduleReconnect();
        } else {
          // CONNECTING: the browser is already retrying.
          setStatus('reconnecting');
        }
      };
    }

    void connect();
    return () => {
      disposed = true;
      window.clearTimeout(retryTimer);
      source?.close();
    };
  }, [backlog, max, qc]);

  return { lines, status, clear: () => setLines([]) };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
