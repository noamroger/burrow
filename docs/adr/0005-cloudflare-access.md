# 5. Cloudflare Access for private hosts

Status: accepted (2026-11-18)

## Context

Some homelab services (a NAS, Grafana, an admin panel) must not be open to
the whole internet. Cloudflare Access puts a sign-in page in front of a
hostname at Cloudflare's edge. Users asked to set this up from Burrow instead
of the Zero Trust dashboard ("only my email can open this").

The Access API offers applications and policies. Legacy app-scoped policies
cannot be attached to new applications any more; reusable policies
(`/accounts/{id}/access/policies`) are linked to applications by id.

## Decision

- Protection is a per-host setting: on/off, allowed emails, allowed email
  domains, session length. It is stored on `proxy_hosts`.
- For each protected **hostname** Burrow owns one self-hosted application and
  one reusable `allow` policy, named `[Burrow] <hostname>`. Hosts sharing a
  hostname (different paths) are merged: union of the allowed lists, shortest
  session. Access works per hostname, and cloudflared path regexes cannot be
  translated into Access paths reliably.
- Ownership is the name prefix plus the `access.managed_hostnames` setting.
  Burrow never edits an application without the prefix, and only deletes
  prefixed applications whose hostname it manages.
- A foreign application on the same hostname is a conflict (`ACCESS_CONFLICT`):
  Burrow does not create its own, and does not publish the host.
- **Fail closed**: the application is created before the route and DNS record
  exist, and deleted only after the route is gone. A protected host whose
  application cannot be created is not published.
- The token permission `Access: Apps and Policies › Edit` is optional. The
  Access API is only called when a host is protected or an app is managed.

## Consequences

- A user who never protects a host needs no extra permission and sees no
  change.
- Editing a Burrow application or policy in the dashboard is drift: the next
  sync restores Burrow's version.
- Enabling protection on a published host can unpublish it briefly if the
  Access call fails during the sync; `HostService` then reverts the change and
  republishes it, and the user gets the error.
- Not done yet: validating the Access JWT in cloudflared
  (`originRequest.access`), which needs the team name
  (`Access: Organizations … Read`, another permission), and richer rules
  (identity provider groups, countries, service tokens).
