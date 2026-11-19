# 6. Several tunnels and imported tunnels

Status: accepted (2026-11-19)

## Context

v0.1 managed exactly one tunnel, created by Burrow at setup. Homelabs often
have more than one site (a NAS at home, a VPS, a parent's house), each with
its own connector, and many users already have tunnels made in the dashboard
before they try Burrow.

## Decision

- A `tunnels` table replaces the `tunnel.*` settings. Each row has the
  Cloudflare id, a name, an `origin` (`created` or `imported`), a
  `run_connector` flag and the `managed_ingress` keys of that tunnel. The
  0002 migration moves the existing tunnel there and makes it the default.
- `proxy_hosts.tunnel_id` points at a row (`ON DELETE SET NULL`). `NULL` means
  "the default tunnel": hosts are reassigned to the default tunnel when it is
  (re)created, e.g. after the token was switched to another account.
- One tunnel is the **default**. New hosts go there unless another tunnel is
  chosen. The default tunnel cannot be deleted.
- **One cloudflared process per tunnel** with `run_connector` on, managed by a
  `SupervisorPool`. Tunnels whose connector runs elsewhere are only managed
  for routes and DNS. Each process gets its own metrics port (the configured
  one for the default tunnel, the next ports for the others).
- The reconciler runs every tunnel in one pass under the same mutex: DNS is
  listed once, then each tunnel's ingress is planned and written. A hostname
  that moves from tunnel A to tunnel B keeps its CNAME: A's plan skips records
  of hostnames published by another tunnel (`otherHostnames`), B's plan
  repoints the record.
- **Import** only accepts remotely managed tunnels (`config_src: cloudflare`):
  locally managed tunnels keep their routes in a file on the connector, which
  the API cannot change. Each public hostname route whose service is a URL
  and whose hostname belongs to a zone of the account becomes a proxy host.
  Unknown `originRequest` keys are kept in `proxy_hosts.origin_request_extra`
  and written back untouched. Other routes stay on the tunnel as foreign
  rules.
- The dashboard creates CNAMEs without Burrow's comment. Because the user
  explicitly asked for the import, Burrow **adopts** a record when it is a
  CNAME to that very tunnel: it adds its ownership comment. The general rule
  is unchanged: outside an import, a record without the comment is never
  touched and is reported as a conflict.
- A tunnel Burrow created is recreated if deleted on Cloudflare (as before).
  An imported tunnel is not: its hosts are marked in error, since recreating
  someone else's tunnel would silently move traffic.

## Consequences

- Several cloudflared processes share the container's CPU and memory; each
  idles at a few MB.
- The REST API keeps `GET /api/tunnel` and `POST /api/tunnel/{action}` for the
  default tunnel, so v0.1 scripts keep working.
