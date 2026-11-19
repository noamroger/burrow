import {
  channelInputSchema,
  type BackupRun,
  type Channel,
  type ChannelTestResult,
  type DriftReport,
  type NotificationEvent,
  type ParsedChannelInput,
  type SupervisorStatus,
  type WebhookPayload,
} from '@burrow/shared';
import { asc, eq } from 'drizzle-orm';
import { createHmac } from 'node:crypto';
import type { Logger } from 'pino';
import type { Db } from '../db/client.js';
import { notificationChannels, type NotificationChannelRow } from '../db/schema.js';
import { errorMessage, errors } from '../lib/errors.js';
import type { SecretBox } from '../lib/secretbox.js';
import { nowIso } from '../lib/time.js';
import type { HostDownEvent, HostUpEvent } from './monitoring.js';

/** What a channel stores (encrypted as a whole). */
type StoredConfig =
  | { type: 'discord'; webhookUrl: string }
  | { type: 'ntfy'; serverUrl: string; topic: string; token: string | null }
  | { type: 'webhook'; url: string; secret: string | null };

/** One message, rendered differently for each kind of channel. */
export interface Notification {
  event: NotificationEvent | 'test';
  severity: WebhookPayload['severity'];
  title: string;
  message: string;
  /** Short facts shown as fields (Discord) or lines (ntfy). */
  fields: Array<[string, string]>;
  /** Link for "click" actions (the affected hostname). */
  url?: string;
  data: Record<string, unknown>;
  at: string;
}

export interface NotificationServiceOptions {
  db: Db;
  box: SecretBox;
  logger: Logger;
  fetch?: typeof fetch;
  /** Time a tunnel may stay disconnected before it is reported down (default 60 s). */
  tunnelGraceMs?: number;
  /** Current state of a tunnel's cloudflared, to confirm an outage after the grace period. */
  tunnelState: (tunnelId: number) => SupervisorStatus['state'];
  tunnelName: (tunnelId: number) => string | undefined;
}

const COLORS: Record<Notification['severity'], number> = {
  critical: 0xb4322f,
  warning: 0xa86a12,
  info: 0x3d6a8a,
  resolved: 0x3f7d4e,
};

const NTFY: Record<Notification['severity'], { priority: number; tags: string[] }> = {
  critical: { priority: 5, tags: ['rotating_light'] },
  warning: { priority: 4, tags: ['warning'] },
  info: { priority: 3, tags: ['information_source'] },
  resolved: { priority: 3, tags: ['white_check_mark'] },
};

/** "1 h 4 min", "45 s". */
function duration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return m ? `${h} h ${m} min` : `${h} h`;
  if (m > 0) return `${m} min`;
  return `${seconds} s`;
}

/**
 * Notification channels (CRUD) and delivery. Sources call the `on…` methods;
 * every enabled channel subscribed to the event gets the message. Delivery
 * never throws: the outcome is saved on the channel (`lastSentAt`,
 * `lastError`) and logged.
 */
export class NotificationService {
  private readonly fetchImpl: typeof fetch;
  private readonly graceMs: number;
  /** Tunnels that left `running`: when, the pending timer, and whether "down" was sent. */
  private readonly tunnels = new Map<
    number,
    { since: number; timer: NodeJS.Timeout | null; notified: boolean }
  >();

  constructor(private readonly opts: NotificationServiceOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.graceMs = opts.tunnelGraceMs ?? 60_000;
  }

  /* ------------------------------ channels ------------------------------ */

  list(): Channel[] {
    return this.opts.db
      .select()
      .from(notificationChannels)
      .orderBy(asc(notificationChannels.id))
      .all()
      .map((r) => this.toApi(r));
  }

  create(body: unknown): Channel {
    const input = channelInputSchema.parse(body);
    const config = this.merge(input, null);
    const row = this.opts.db
      .insert(notificationChannels)
      .values({
        name: input.name,
        type: input.type,
        enabled: input.enabled,
        events: [...new Set(input.events)],
        configEnc: this.opts.box.encrypt(JSON.stringify(config)),
      })
      .returning()
      .get();
    return this.toApi(row);
  }

  update(id: number, body: unknown): Channel {
    const row = this.row(id);
    const input = channelInputSchema.parse(body);
    const previous = input.type === row.type ? this.config(row) : null;
    const config = this.merge(input, previous);
    this.opts.db
      .update(notificationChannels)
      .set({
        name: input.name,
        type: input.type,
        enabled: input.enabled,
        events: [...new Set(input.events)],
        configEnc: this.opts.box.encrypt(JSON.stringify(config)),
      })
      .where(eq(notificationChannels.id, id))
      .run();
    return this.toApi(this.row(id));
  }

  remove(id: number): void {
    this.row(id);
    this.opts.db.delete(notificationChannels).where(eq(notificationChannels.id, id)).run();
  }

  /** Send a test message to one channel, enabled or not. */
  async test(id: number): Promise<ChannelTestResult> {
    const row = this.row(id);
    const error = await this.deliver(row, {
      event: 'test',
      severity: 'info',
      title: 'Burrow test notification',
      message: `This channel works. Burrow will post here for: ${row.events.join(', ')}.`,
      fields: [],
      data: {},
      at: nowIso(),
    });
    return { ok: error === null, error };
  }

  private row(id: number): NotificationChannelRow {
    const row = this.opts.db
      .select()
      .from(notificationChannels)
      .where(eq(notificationChannels.id, id))
      .get();
    if (!row) throw errors.notFound('Notification channel');
    return row;
  }

  private config(row: NotificationChannelRow): StoredConfig {
    return JSON.parse(this.opts.box.decrypt(row.configEnc)) as StoredConfig;
  }

  /** New config from the input; write-only secrets left out keep their saved value. */
  private merge(input: ParsedChannelInput, previous: StoredConfig | null): StoredConfig {
    switch (input.type) {
      case 'discord': {
        const webhookUrl =
          input.config.webhookUrl ?? (previous?.type === 'discord' ? previous.webhookUrl : null);
        if (!webhookUrl) {
          throw errors.validation('Paste the Discord webhook URL.', {
            field: 'config.webhookUrl',
          });
        }
        return { type: 'discord', webhookUrl };
      }
      case 'ntfy': {
        const saved = previous?.type === 'ntfy' ? previous.token : null;
        const token = input.config.token === undefined ? saved : input.config.token || null;
        return {
          type: 'ntfy',
          serverUrl: input.config.serverUrl.replace(/\/+$/, ''),
          topic: input.config.topic,
          token,
        };
      }
      case 'webhook': {
        const saved = previous?.type === 'webhook' ? previous.secret : null;
        const secret = input.config.secret === undefined ? saved : input.config.secret || null;
        return { type: 'webhook', url: input.config.url, secret };
      }
    }
  }

  private toApi(row: NotificationChannelRow): Channel {
    let config: Channel['config'] = { hasSecret: false };
    try {
      const c = this.config(row);
      if (c.type === 'discord') {
        config = { webhookHint: `…${c.webhookUrl.slice(-6)}`, hasSecret: true };
      } else if (c.type === 'ntfy') {
        config = { serverUrl: c.serverUrl, topic: c.topic, hasSecret: c.token !== null };
      } else {
        config = { url: c.url, hasSecret: c.secret !== null };
      }
    } catch {
      // Undecryptable (instance key changed): shown without details, edit to fix.
    }
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      enabled: row.enabled,
      events: row.events,
      config,
      lastSentAt: row.lastSentAt,
      lastError: row.lastError,
      createdAt: row.createdAt,
    };
  }

  /* ------------------------------- sources ------------------------------ */

  onHostDown(e: HostDownEvent): Promise<void> {
    const name = e.hostname + e.path;
    return this.send({
      event: 'host.down',
      severity: 'critical',
      title: `${name} is down`,
      message: e.error ?? 'The service stopped responding.',
      fields: [
        ['Host', name],
        ['Since', e.since],
      ],
      url: `https://${e.hostname}`,
      data: { ...e },
      at: nowIso(),
    });
  }

  onHostUp(e: HostUpEvent): Promise<void> {
    const name = e.hostname + e.path;
    return this.send({
      event: 'host.up',
      severity: 'resolved',
      title: `${name} is back up`,
      message: `It was down for ${duration(e.durationSeconds)}.`,
      fields: [
        ['Host', name],
        ['Downtime', duration(e.durationSeconds)],
      ],
      url: `https://${e.hostname}`,
      data: { ...e },
      at: nowIso(),
    });
  }

  onDrift(report: DriftReport): Promise<void> {
    const lines = report.items.slice(0, 5).map((i) => `• ${i.detail}`);
    if (report.items.length > 5) lines.push(`…and ${report.items.length - 5} more.`);
    return this.send({
      event: 'drift.detected',
      severity: 'warning',
      title: `Cloudflare was changed outside Burrow (${report.items.length} difference${report.items.length === 1 ? '' : 's'})`,
      message: `${lines.join('\n')}\n\nOpen Burrow to revert or keep these changes.`,
      fields: [],
      data: { items: report.items, checkedAt: report.checkedAt, autoRepair: report.autoRepair },
      at: nowIso(),
    });
  }

  onBackupFailed(run: BackupRun): Promise<void> {
    return this.send({
      event: 'backup.failed',
      severity: 'warning',
      title: 'Backup failed',
      message: run.error ?? 'The backup could not be written.',
      fields: [],
      data: { ...run },
      at: nowIso(),
    });
  }

  /**
   * cloudflared state changes. A tunnel that crashed (`backoff`) and is not
   * running again after the grace period is reported down; it is reported
   * up when it connects again. Stopping it on purpose reports nothing.
   */
  onTunnelState(tunnelId: number, status: SupervisorStatus): void {
    const entry = this.tunnels.get(tunnelId);
    if (status.state === 'running') {
      if (entry?.timer) clearTimeout(entry.timer);
      this.tunnels.delete(tunnelId);
      if (entry?.notified) {
        const seconds = Math.round((Date.now() - entry.since) / 1000);
        const name = this.opts.tunnelName(tunnelId) ?? `#${tunnelId}`;
        void this.send({
          event: 'tunnel.up',
          severity: 'resolved',
          title: `Tunnel ${name} is connected again`,
          message: `It was down for ${duration(seconds)}.`,
          fields: [
            ['Tunnel', name],
            ['Downtime', duration(seconds)],
          ],
          data: { tunnelId, tunnel: name, durationSeconds: seconds },
          at: nowIso(),
        });
      }
      return;
    }
    if (status.state === 'stopped' || status.state === 'disabled') {
      if (entry?.timer) clearTimeout(entry.timer);
      this.tunnels.delete(tunnelId);
      return;
    }
    if (status.state !== 'backoff' || entry) return;
    const since = Date.now();
    const timer = setTimeout(() => {
      const current = this.tunnels.get(tunnelId);
      if (!current) return;
      current.timer = null;
      if (this.opts.tunnelState(tunnelId) === 'running') {
        this.tunnels.delete(tunnelId);
        return;
      }
      current.notified = true;
      const name = this.opts.tunnelName(tunnelId) ?? `#${tunnelId}`;
      void this.send({
        event: 'tunnel.down',
        severity: 'critical',
        title: `Tunnel ${name} is down`,
        message: `cloudflared lost its connection to Cloudflare and keeps restarting (${status.restarts} restart${status.restarts === 1 ? '' : 's'}, last exit code ${status.lastExitCode ?? 'unknown'}). Every host on this tunnel is unreachable. Check the logs on the Tunnels page.`,
        fields: [
          ['Tunnel', name],
          ['Since', new Date(since).toISOString()],
        ],
        data: { tunnelId, tunnel: name, since: new Date(since).toISOString() },
        at: nowIso(),
      });
    }, this.graceMs);
    timer.unref();
    this.tunnels.set(tunnelId, { since, timer, notified: false });
  }

  /** Stop pending tunnel timers (shutdown). */
  stop(): void {
    for (const t of this.tunnels.values()) if (t.timer) clearTimeout(t.timer);
    this.tunnels.clear();
  }

  /* ------------------------------ delivery ------------------------------ */

  /** Send to every enabled channel subscribed to the event. Never throws. */
  async send(n: Notification): Promise<void> {
    const rows = this.opts.db
      .select()
      .from(notificationChannels)
      .all()
      .filter((r) => r.enabled && n.event !== 'test' && r.events.includes(n.event));
    await Promise.all(rows.map((r) => this.deliver(r, n)));
  }

  /** Deliver to one channel and record the outcome. Returns the error, or null. */
  private async deliver(row: NotificationChannelRow, n: Notification): Promise<string | null> {
    let error: string | null = null;
    try {
      const config = this.config(row);
      const req = render(config, n);
      const res = await this.fetchImpl(req.url, {
        method: 'POST',
        headers: { 'user-agent': 'Burrow-Notifier/1', ...req.headers },
        body: req.body,
        signal: AbortSignal.timeout(10_000),
        redirect: 'error',
      });
      if (!res.ok) {
        const text = (await res.text().catch(() => '')).slice(0, 200).trim();
        error = `HTTP ${res.status}${text ? `: ${text}` : ''}`;
      } else {
        await res.body?.cancel().catch(() => undefined);
      }
    } catch (err) {
      error =
        err instanceof Error && err.name === 'TimeoutError'
          ? 'No answer within 10 seconds'
          : errorMessage(err);
    }
    this.opts.db
      .update(notificationChannels)
      .set({ lastSentAt: nowIso(), lastError: error })
      .where(eq(notificationChannels.id, row.id))
      .run();
    if (error) {
      this.opts.logger.warn(
        { channel: row.name, type: row.type, event: n.event, err: error },
        'notification not delivered',
      );
    } else {
      this.opts.logger.debug({ channel: row.name, event: n.event }, 'notification sent');
    }
    return error;
  }
}

/** Build the HTTP request for a channel. Pure: unit tested. */
export function render(
  config: StoredConfig,
  n: Notification,
): { url: string; headers: Record<string, string>; body: string } {
  const json = { 'content-type': 'application/json' };
  if (config.type === 'discord') {
    return {
      url: config.webhookUrl,
      headers: json,
      body: JSON.stringify({
        username: 'Burrow',
        allowed_mentions: { parse: [] },
        embeds: [
          {
            title: n.title.slice(0, 256),
            description: n.message.slice(0, 4000),
            color: COLORS[n.severity],
            timestamp: n.at,
            ...(n.url ? { url: n.url } : {}),
            fields: n.fields.map(([name, value]) => ({
              name,
              value: value.slice(0, 1024),
              inline: true,
            })),
            footer: { text: `Burrow · ${n.event}` },
          },
        ],
      }),
    };
  }
  if (config.type === 'ntfy') {
    const style = NTFY[n.severity];
    return {
      url: config.serverUrl,
      headers: config.token ? { ...json, authorization: `Bearer ${config.token}` } : json,
      body: JSON.stringify({
        topic: config.topic,
        title: n.title,
        message: n.message,
        priority: style.priority,
        tags: style.tags,
        ...(n.url ? { click: n.url } : {}),
      }),
    };
  }
  const payload: WebhookPayload = {
    event: n.event,
    severity: n.severity,
    title: n.title,
    message: n.message,
    at: n.at,
    data: n.data,
  };
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { ...json, 'x-burrow-event': n.event };
  if (config.secret) {
    headers['x-burrow-signature'] =
      `sha256=${createHmac('sha256', config.secret).update(body).digest('hex')}`;
  }
  return { url: config.url, headers, body };
}
