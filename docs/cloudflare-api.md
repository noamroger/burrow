# Cloudflare API notes

Checked against the official API reference (developers.cloudflare.com/api) on
**2026-11-18**. Base URL: `https://api.cloudflare.com/client/v4`, auth with
`Authorization: Bearer <token>`. Every response is wrapped in
`{ success, errors[], messages[], result, result_info? }`.

## Tunnels (`cfd_tunnel`)

Permission for all of them: **Cloudflare Tunnel Write** (also accepted:
"Cloudflare One Connectors Write", "Cloudflare One Connector: cloudflared Write").

| Purpose     | Request                                                                                                  | Notes                                                                                                                                                                                                                    |
| ----------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| List        | `GET /accounts/{account_id}/cfd_tunnel?name=&is_deleted=false&per_page=`                                 | `result[]` of tunnels: `id`, `name`, `status` (`inactive`\|`degraded`\|`healthy`\|`down`), `config_src`, `created_at`, `deleted_at`, `conns_active_at`, `conns_inactive_at`. `connections` is deprecated (always empty). |
| Create      | `POST /accounts/{account_id}/cfd_tunnel` body `{ name, config_src: "cloudflare" }`                       | `config_src: "cloudflare"` = remotely managed. No `tunnel_secret` needed.                                                                                                                                                |
| Get         | `GET /accounts/{account_id}/cfd_tunnel/{tunnel_id}`                                                      |                                                                                                                                                                                                                          |
| Delete      | `DELETE /accounts/{account_id}/cfd_tunnel/{tunnel_id}`                                                   |                                                                                                                                                                                                                          |
| Run token   | `GET /accounts/{account_id}/cfd_tunnel/{tunnel_id}/token`                                                | `result` is a **string**. Passed to cloudflared via `TUNNEL_TOKEN`.                                                                                                                                                      |
| Get config  | `GET /accounts/{account_id}/cfd_tunnel/{tunnel_id}/configurations`                                       | `result: { tunnel_id, version, config: { ingress[], originRequest } , source }`                                                                                                                                          |
| Put config  | `PUT /accounts/{account_id}/cfd_tunnel/{tunnel_id}/configurations` body `{ config: { ingress: [...] } }` | **Replaces the whole document.** Last rule must be a catch-all with no hostname, e.g. `{ "service": "http_status:404" }`.                                                                                                |
| Connections | `GET /accounts/{account_id}/cfd_tunnel/{tunnel_id}/connections`                                          | `result[]` of connectors: `id`, `arch`, `version`, `run_at`, `config_version`, `conns[]` with `colo_name`, `opened_at`, `origin_ip`, `client_version`.                                                                   |

Ingress rule fields: `hostname`, `service` (`http://…`, `https://…`,
`tcp://…`, `ssh://…`, `http_status:404`…), `path` (regex), `originRequest`
(`noTLSVerify`, `httpHostHeader`, `originServerName`, `connectTimeout`,
`http2Origin`, `disableChunkedEncoding`, `access`, …).

## DNS records

Permission: **DNS Write** (Zone).

| Purpose     | Request                                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| List / find | `GET /zones/{zone_id}/dns_records?type=CNAME&name.exact=<fqdn>` (also `comment.startswith=managed-by:burrow`)                               |
| Create      | `POST /zones/{zone_id}/dns_records` body `{ type: "CNAME", name, content: "<tunnel_id>.cfargotunnel.com", proxied: true, ttl: 1, comment }` |
| Update      | `PATCH /zones/{zone_id}/dns_records/{record_id}`                                                                                            |
| Delete      | `DELETE /zones/{zone_id}/dns_records/{record_id}`                                                                                           |

## Zones and accounts

| Purpose       | Request                                                                                                          | Permission                        |
| ------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| List zones    | `GET /zones?per_page=50&page=`                                                                                   | Zone › Zone › Read                |
| List accounts | `GET /accounts`                                                                                                  | Account › Account Settings › Read |
| Verify token  | `GET /user/tokens/verify` (user-owned token) or `GET /accounts/{account_id}/tokens/verify` (account-owned token) | none                              |

## Access (Zero Trust): applications and reusable policies

Permission: **Access: Apps and Policies Write** (Account), shown as
"Account › Access: Apps and Policies › Edit" in the token UI. Optional:
Burrow only calls these endpoints once a host is protected.

| Purpose        | Request                                                     | Notes                                                                                                              |
| -------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| List apps      | `GET /accounts/{account_id}/access/apps`                    | Paginated. Each app has `id`, `name`, `type`, `domain`, `destinations[]`, `session_duration`, `aud`, `policies[]`. |
| Create app     | `POST /accounts/{account_id}/access/apps`                   | Body below. `domain` is required; `destinations` supersedes the deprecated `self_hosted_domains`.                  |
| Replace app    | `PUT /accounts/{account_id}/access/apps/{app_id}`           | Full body, same as create.                                                                                         |
| Delete app     | `DELETE /accounts/{account_id}/access/apps/{app_id}`        | The reusable policy survives: delete it afterwards.                                                                |
| List policies  | `GET /accounts/{account_id}/access/policies`                | Reusable policies: `id`, `name`, `decision`, `include[]`, `exclude[]`, `require[]`, `app_count`.                   |
| Create policy  | `POST /accounts/{account_id}/access/policies`               | `{ name, decision: "allow", include: [...], exclude: [], require: [] }`.                                           |
| Replace policy | `PUT /accounts/{account_id}/access/policies/{policy_id}`    |                                                                                                                    |
| Delete policy  | `DELETE /accounts/{account_id}/access/policies/{policy_id}` | Fails while an application still uses it.                                                                          |

Self-hosted application body Burrow sends:

```json
{
  "name": "[Burrow] nas.example.com",
  "type": "self_hosted",
  "domain": "nas.example.com",
  "destinations": [{ "type": "public", "uri": "nas.example.com" }],
  "session_duration": "24h",
  "app_launcher_visible": false,
  "policies": [{ "id": "<policy uuid>", "precedence": 1 }]
}
```

Rule shapes used in `include`: `{ "email": { "email": "me@example.com" } }`
and `{ "email_domain": { "domain": "example.com" } }`. `decision` can be
`allow`, `deny`, `non_identity` or `bypass`; Burrow only writes `allow`.

Notes:

- **Legacy (app-scoped) policies cannot be attached to new applications**:
  Burrow uses reusable policies (`/access/policies`) and links them by id.
  `policies` also accepts plain id strings or inline objects, but reusable
  and inline policies are mutually exclusive.
- Access needs a Zero Trust organization (team name) on the account. It is
  created the first time someone opens Zero Trust in the dashboard.
- A self-hosted app on a hostname protects every path of it. Access picks the
  most specific application when several match.

## Minimum token for Burrow

- Account › **Cloudflare Tunnel** › Edit
- Account › **Account Settings** › Read
- Zone › **DNS** › Edit (only the zones you want to use)
- Zone › **Zone** › Read (same zones)
- Optional: Account › **Access: Apps and Policies** › Edit (private hosts)
