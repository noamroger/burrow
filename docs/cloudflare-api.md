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

## Minimum token for Burrow

- Account › **Cloudflare Tunnel** › Edit
- Account › **Account Settings** › Read
- Zone › **DNS** › Edit (only the zones you want to use)
- Zone › **Zone** › Read (same zones)
