# Burrow architecture

Burrow is a single Docker image that gives you a web UI to publish internal
services through a Cloudflare Tunnel. It is to Cloudflare Tunnel what
Nginx Proxy Manager is to nginx.

This document describes the V1 (MVP) design and the extension points kept open
for V2. Decisions with real trade-offs are recorded in [`docs/adr/`](adr/).

## 1. Components

```
                        ┌──────────────────────── burrow container (uid 1000) ─────────────────────────┐
 Browser ──HTTP:8080──▶ │  Fastify server (Node.js 22, TypeScript)                                      │
                        │   ├─ static SPA (React + Vite build)                                          │
                        │   ├─ /api/*  REST + SSE (zod-validated, session cookie + CSRF)                │
                        │   ├─ AuthService        argon2id, sessions in SQLite                          │
                        │   ├─ SecretBox          AES-256-GCM, key from BURROW_SECRET or /data/.key     │
                        │   ├─ CloudflareClient   typed fetch wrapper (retries, never logs the token)  │
                        │   ├─ TunnelService      ensure tunnel, fetch run token                        │
                        │   ├─ HostService        proxy host CRUD ➜ ingress + DNS (Reconciler)         │
                        │   ├─ Reconciler         desired state (SQLite) ⇄ actual state (Cloudflare)   │
                        │   ├─ HealthService      tunnel connections + origin reachability probes       │
                        │   └─ Supervisor ──spawn──▶ cloudflared tunnel run   (child process)           │
                        │          ▲ stdout/stderr ➜ ring buffer (2 000 lines) ➜ SSE /api/logs/stream    │
                        │   SQLite (better-sqlite3 + Drizzle)  ➜  /data/burrow.db                        │
                        └───────────────────────────────────────────────────────────────────────────────┘
                                 │ HTTPS (api.cloudflare.com/client/v4)        │ QUIC/HTTP2 outbound
                                 ▼                                             ▼
                         Cloudflare API (tunnels, DNS, zones)          Cloudflare edge
```

Everything runs in **one Node.js process** plus **one cloudflared child
process**. There is no separate init system: Node supervises cloudflared, and
Docker supervises Node (`restart: unless-stopped` + `HEALTHCHECK`).

## 2. Repository layout

```
burrow/
├─ apps/
│  ├─ server/           Fastify API, services, Drizzle schema & migrations
│  └─ web/              React + Vite + Tailwind SPA
├─ packages/
│  └─ shared/           zod schemas and TypeScript types shared by server and web
├─ docker/              entrypoint and helper scripts
├─ docs/                architecture, ADRs, Cloudflare API notes
├─ Dockerfile           multi-stage, multi-arch
├─ docker-compose.yml   example deployment
└─ .github/             CI, release, Renovate, issue/PR templates
```

`packages/shared` is the API contract: request bodies, responses and enums are
defined once with zod. The server validates with them, the web client infers
its types from them. Changing the API means changing this package first.

## 3. Data model (SQLite)

| Table | Purpose | Key columns |
|---|---|---|
| `users` | Admin accounts (one in V1, table ready for more) | `id`, `email` (unique), `password_hash` (argon2id), `created_at` |
| `sessions` | Server-side sessions | `id` (random 32 bytes, hashed with SHA-256 in DB), `user_id`, `csrf_token`, `expires_at`, `created_at` |
| `settings` | Key/value app settings | `key`, `value` (JSON). Holds `cloudflare.account_id`, `cloudflare.token` (**encrypted**), `tunnel.id`, `tunnel.name` |
| `zones` | Zones the admin enabled for use | `id` (Cloudflare zone id), `name`, `enabled` |
| `proxy_hosts` | Desired state of each published service | `id`, `subdomain`, `zone_id`, `hostname` (computed FQDN, unique), `service` (origin URL), `path`, `no_tls_verify`, `http_host_header`, `origin_server_name`, `enabled`, `dns_record_id`, `sync_status` (`pending` \| `synced` \| `error` \| `drift`), `sync_error`, `last_synced_at`, `created_at`, `updated_at` |
| `audit_log` | Who changed what (no secrets) | `id`, `user_id`, `action`, `target`, `created_at` |

V2 extension points: `tunnels` table (multi-tunnel, `proxy_hosts.tunnel_id`),
`proxy_hosts.source` (`manual` \| `docker`), `access_policies`,
`notification_channels`. Migrations are versioned with Drizzle Kit and applied
automatically at startup.

## 4. Secrets

* The Cloudflare API token is encrypted with **AES-256-GCM** before it touches
  SQLite. The key is `BURROW_SECRET` (32+ chars, derived with HKDF-SHA256) when
  set, otherwise a random key generated once into `/data/.secret` (mode 0600).
* The tunnel run token is **never stored**. It is fetched from the API when
  cloudflared starts and passed through the `TUNNEL_TOKEN` environment variable
  (not argv, so it does not show up in `ps`).
* The logger (pino) redacts `authorization`, `token`, `password`, `cookie` and
  any value matching a Cloudflare token pattern. cloudflared output is scrubbed
  the same way before it reaches the ring buffer.

## 5. Flow: adding a proxy host

```
UI                 API (HostService)                 Cloudflare
 │  POST /api/hosts  │                                    │
 │──────────────────▶│ 1. validate (zod), zone enabled?   │
 │                   │    hostname unique?                │
 │                   │ 2. insert row sync_status=pending  │
 │                   │ 3. GET  cfd_tunnel/{id}/configurations ───▶ current ingress
 │                   │ 4. merge: replace our rules, keep  │
 │                   │    foreign rules, keep catch-all   │
 │                   │    http_status:404 LAST            │
 │                   │ 5. PUT  cfd_tunnel/{id}/configurations ───▶ new version
 │                   │ 6. find CNAME by name.exact        │
 │                   │    ├ none      ➜ POST dns_records  │
 │                   │    ├ ours      ➜ PATCH if content differs
 │                   │    └ foreign   ➜ ERROR (conflict, nothing overwritten)
 │                   │ 7. on DNS failure: re-PUT ingress  │
 │                   │    without the rule (compensate)   │
 │                   │ 8. row sync_status=synced|error    │
 │◀──────────────────│ 201 + host                         │
```

* DNS record: `CNAME <hostname> → <tunnel-id>.cfargotunnel.com`, `proxied: true`,
  `ttl: 1`, `comment: "managed-by:burrow tunnel:<tunnel-id>"`. The comment is
  how Burrow recognises records it owns. Burrow never edits or deletes a DNS
  record without that comment.
* Ingress rules are ordered: more specific paths first for the same hostname,
  then by hostname, and the mandatory catch-all `{ service: "http_status:404" }`
  always last.
* Deletion runs the same steps in reverse: remove the ingress rule, then delete
  the DNS record (only if it carries our comment), then delete the row.
* All Cloudflare writes for the tunnel config go through a single in-process
  **mutex**, because the configuration endpoint replaces the whole document.

## 6. Reconciliation (idempotence)

Cloudflare is the source of truth for what exists there; SQLite is the source
of truth for what the user *wants*. The `Reconciler` runs at startup, every
5 minutes, and on demand (`POST /api/sync`).

For every enabled host it computes the desired ingress rule and CNAME, compares
them with the live config and DNS records, and:

| Situation | Action |
|---|---|
| Ingress rule missing or different | Rewrite the tunnel configuration |
| CNAME missing | Create it |
| CNAME ours but wrong target | Patch it |
| CNAME exists but not ours | Mark host `error` (conflict), do not touch |
| Ingress rule / CNAME ours but no host row | Orphan: removed (it was ours) |
| Rule in ingress that Burrow did not create | Kept untouched (foreign rule) |
| Tunnel deleted on Cloudflare | Recreate tunnel, rewrite everything, restart cloudflared |

The reconciler is a pure function `plan(desired, actual) → actions[]` plus an
executor. The pure part is unit-tested exhaustively without network.

## 7. cloudflared supervision

`Supervisor` is a small state machine:

```
stopped ──start()──▶ starting ──first "Registered tunnel connection"──▶ running
   ▲                     │                                               │
   │                 exit/crash                                      exit/crash
   │                     ▼                                               ▼
   └──stop()─────── backoff (1s, 2s, 4s … max 60s, reset after 5 min healthy)
```

* Command: `cloudflared tunnel --no-autoupdate --metrics 127.0.0.1:20241 run`
  with `TUNNEL_TOKEN` in the environment.
* Readiness: cloudflared's `/ready` endpoint on the metrics port, plus the
  connections list from the API.
* Logs: stdout/stderr lines are parsed (level, message), scrubbed, stored in a
  2 000-line ring buffer and pushed to the UI over **Server-Sent Events**
  (`GET /api/logs/stream`). SSE is simpler than WebSockets and goes through
  every reverse proxy.
* Shutdown: on SIGTERM, Node sends SIGTERM to cloudflared, waits up to 10 s,
  then SIGKILL. The image uses `tini` as PID 1 so signals and zombies are
  handled correctly.
* The binary path is configurable (`CLOUDFLARED_PATH`) so tests can use a fake
  script that prints realistic log lines.

## 8. Health

* `GET /api/health` (unauthenticated, used by Docker `HEALTHCHECK`): process
  up, DB reachable. It does **not** fail when cloudflared is down, otherwise
  Docker would restart the whole container in a loop during a Cloudflare
  outage.
* `GET /api/status` (authenticated): supervisor state, tunnel status and
  connectors (colo, version, origin IP) from the API, last reconcile result.
* Origin probes: every 60 s and on demand, each host's `service` URL is probed
  from inside the container (HTTP `HEAD`, fall back to `GET`, 5 s timeout,
  TLS verification follows `noTLSVerify`). Result: `up` / `down` + latency +
  error. This tests exactly the network path cloudflared will use.

## 9. Security

* argon2id password hashing (`@node-rs/argon2`, prebuilt for amd64 and arm64).
* Session cookie: `HttpOnly`, `SameSite=Strict`, `Secure` when served over
  HTTPS (auto-detected or forced with `BURROW_SECURE_COOKIES`), 7-day sliding
  expiry, rotated on login.
* CSRF: synchroniser token returned by `GET /api/auth/me`, required in the
  `X-CSRF-Token` header on every mutating request.
* Rate limiting: `@fastify/rate-limit`, 5 login attempts per minute per IP,
  plus a global limit on the API.
* Security headers with `@fastify/helmet` (strict CSP, the SPA has no inline
  scripts).
* Setup lock: `/api/setup` only works while no user exists.
* Least-privilege token, documented in the UI and the README:
  `Account › Cloudflare Tunnel › Edit`, `Zone › DNS › Edit`, `Zone › Zone › Read`
  (scoped to the chosen zones), `Account › Account Settings › Read`.
* The container runs as uid 1000, with a read-only root filesystem possible
  (only `/data` and `/tmp` are written).

## 10. V2 hooks

* **Docker auto-discovery**: a `DiscoveryProvider` interface produces desired
  hosts with `source = docker`. The reconciler does not care where desired
  state comes from.
* **Access applications**: a new service using the same client and reconciler
  pattern.
* **Multiple tunnels / import**: `tunnels` table, one Supervisor per tunnel.
* **OpenAPI**: shared zod schemas → `@fastify/swagger` via `fastify-type-provider-zod`.
* **Notifications**: an internal event bus already emits `host.synced`,
  `host.error`, `tunnel.down`; channels subscribe to it.
* **i18n**: all UI strings go through a single `t()` helper from day one
  (English only in V1).
