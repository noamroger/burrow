/**
 * Notifications: Burrow posts a message to Discord, ntfy or any webhook when
 * a tunnel goes down, a service stops answering, someone changes Burrow's
 * resources in the Cloudflare dashboard, or a backup fails.
 *
 * Secrets (the Discord webhook URL, the ntfy access token, the webhook signing
 * secret) are write-only: the API never returns them, and omitting them on
 * update keeps the saved value.
 */
import { z } from 'zod';

export const NOTIFICATION_EVENTS = [
  'tunnel.down',
  'tunnel.up',
  'host.down',
  'host.up',
  'drift.detected',
  'backup.failed',
] as const;
export const notificationEventSchema = z.enum(NOTIFICATION_EVENTS);
export type NotificationEvent = z.infer<typeof notificationEventSchema>;

export const CHANNEL_TYPES = ['discord', 'ntfy', 'webhook'] as const;
export const channelTypeSchema = z.enum(CHANNEL_TYPES);
export type ChannelType = z.infer<typeof channelTypeSchema>;

const httpUrl = z
  .string()
  .trim()
  .max(1000)
  .url()
  .refine((v) => /^https?:\/\//i.test(v), 'Use an http:// or https:// URL');

export const discordConfigSchema = z.object({
  /** Server settings › Integrations › Webhooks › Copy webhook URL. Write-only. */
  webhookUrl: httpUrl
    .refine((v) => /\/api\/webhooks\/\d+\/[\w-]+/.test(v), 'This is not a Discord webhook URL')
    .optional(),
});

export const ntfyConfigSchema = z.object({
  /** `https://ntfy.sh` or a self-hosted server. */
  serverUrl: httpUrl.default('https://ntfy.sh'),
  topic: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{1,64}$/, 'Letters, digits, - and _ only (64 max)'),
  /** Access token for protected topics. Write-only; empty string removes it. */
  token: z.string().trim().max(200).optional(),
});

export const webhookConfigSchema = z.object({
  url: httpUrl,
  /** Signs the body: `X-Burrow-Signature: sha256=<hex HMAC>`. Write-only; empty string removes it. */
  secret: z.string().max(200).optional(),
});

const base = {
  name: z.string().trim().min(1).max(64),
  enabled: z.boolean().default(true),
  events: z.array(notificationEventSchema).min(1, 'Pick at least one event'),
};

/** POST /api/notifications/channels, PUT /api/notifications/channels/:id */
export const channelInputSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('discord'), config: discordConfigSchema }),
  z.object({ ...base, type: z.literal('ntfy'), config: ntfyConfigSchema }),
  z.object({ ...base, type: z.literal('webhook'), config: webhookConfigSchema }),
]);
export type ChannelInput = z.input<typeof channelInputSchema>;
export type ParsedChannelInput = z.output<typeof channelInputSchema>;

/** A channel as the API returns it: no secret, only whether one is saved. */
export const channelSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  type: channelTypeSchema,
  enabled: z.boolean(),
  events: z.array(notificationEventSchema),
  config: z.object({
    /** Discord: end of the webhook URL, to recognise it. */
    webhookHint: z.string().optional(),
    serverUrl: z.string().optional(),
    topic: z.string().optional(),
    url: z.string().optional(),
    /** A write-only secret is saved (Discord URL, ntfy token, webhook secret). */
    hasSecret: z.boolean(),
  }),
  lastSentAt: z.string().nullable(),
  /** Error of the last delivery, null when it worked. */
  lastError: z.string().nullable(),
  createdAt: z.string(),
});
export type Channel = z.infer<typeof channelSchema>;

/** GET /api/notifications -> 200 */
export const channelListSchema = z.object({ channels: z.array(channelSchema) });
export type ChannelList = z.infer<typeof channelListSchema>;

/** POST /api/notifications/channels/:id/test -> 200 (also when delivery failed) */
export const channelTestResultSchema = z.object({
  ok: z.boolean(),
  error: z.string().nullable(),
});
export type ChannelTestResult = z.infer<typeof channelTestResultSchema>;

/**
 * Body of a generic webhook (`POST`, `application/json`). Headers:
 * `X-Burrow-Event: <event>` and, with a secret, `X-Burrow-Signature`.
 */
export const webhookPayloadSchema = z.object({
  event: z.union([notificationEventSchema, z.literal('test')]),
  severity: z.enum(['critical', 'warning', 'info', 'resolved']),
  title: z.string(),
  message: z.string(),
  at: z.string(),
  /** Event details: hostname, tunnel, error, duration… */
  data: z.record(z.unknown()),
});
export type WebhookPayload = z.infer<typeof webhookPayloadSchema>;
