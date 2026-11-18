# 3. Remotely managed tunnel, app-owned resources only

Status: accepted (2026-11-18)

## Context

cloudflared can read ingress rules from a local YAML file or from Cloudflare
(`config_src: cloudflare`). Users may already have tunnels and DNS records.

## Decision

Burrow creates its own remotely managed tunnel (`burrow-<random>`) and stores
ingress rules on Cloudflare. It only edits DNS records tagged with the comment
`managed-by:burrow`. Ingress rules it did not create are preserved. Importing an
existing tunnel is a V2 feature.

## Consequences

- No config file inside the container; configuration changes apply without
  restarting cloudflared.
- Burrow can never destroy records the user created by hand.
- The tunnel configuration endpoint replaces the whole document, so every write
  goes through one mutex and starts from a fresh read.
