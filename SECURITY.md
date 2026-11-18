# Security policy

Burrow holds a Cloudflare API token that can change your DNS and tunnels, so
we take security reports seriously.

## Supported versions

Only the latest release receives security fixes. Please update to the latest
image (`ghcr.io/noamroger/burrow:latest`) before reporting.

## Reporting a vulnerability

**Do not open a public issue, discussion or pull request.**

Report it privately through GitHub:
[**Report a vulnerability**](https://github.com/noamroger/burrow/security/advisories/new)
(Security tab → Advisories → _Report a vulnerability_).

Please include:

- the Burrow version (image tag or digest) and how it is deployed;
- a description of the issue and its impact;
- steps to reproduce or a proof of concept;
- whether the issue is already public.

Never include real tokens or secrets. Use revoked or fake ones.

If you cannot use GitHub, email **contact@noamroger.fr** with "Burrow security"
in the subject.

## What to expect

Burrow is maintained by volunteers, so these are goals, not guarantees:

- acknowledgement within **3 working days**;
- a first assessment within **7 days**;
- a fix or mitigation as fast as possible for confirmed issues, then a
  coordinated disclosure through a GitHub Security Advisory. We credit you
  unless you prefer to stay anonymous.

## Scope

In scope: the Burrow server and web UI, the Docker image (including the
bundled cloudflared and tini versions) and the release pipeline.

Out of scope: vulnerabilities in Cloudflare's services or in `cloudflared`
itself (report those to [Cloudflare](https://hackerone.com/cloudflare)), and
issues that require an attacker who already controls the host, the Docker
daemon or the `/data` volume.

## Hardening tips for users

- Do not expose the dashboard port to the Internet. Bind it to `127.0.0.1`,
  your LAN or Tailscale, or publish it through the tunnel behind
  Cloudflare Access.
- Give the Cloudflare API token only the permissions listed in the README,
  scoped to the zones you use.
- Keep the hardening options of the example `docker-compose.yml`
  (`read_only`, `cap_drop: ALL`, `no-new-privileges`).
- Set `BURROW_SECRET` if your backups of `/data` are stored somewhere less
  trusted than the host.
