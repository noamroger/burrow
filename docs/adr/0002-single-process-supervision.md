# 2. Node.js supervises cloudflared directly

Status: accepted (2026-11-18)

## Context

The image must contain the dashboard and cloudflared. Options: s6-overlay or
supervisord managing two services, or the Node.js app spawning cloudflared.

## Decision

The Node.js app spawns `cloudflared tunnel run` as a child process, with
`tini` as PID 1. The app owns start, stop, restart with exponential backoff,
and log capture.

## Consequences

- The app knows the real state of cloudflared and can stream its logs to the UI.
- The app can restart cloudflared when the tunnel token changes.
- One process manager less in the image.
- If Node crashes, cloudflared goes down with it; Docker restarts the container.
