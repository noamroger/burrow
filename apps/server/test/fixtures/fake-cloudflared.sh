#!/bin/sh
# A stand-in for cloudflared, used by the test suite and for local development
# with the mock Cloudflare API. It prints realistic log lines and then idles.
#
# Behaviour switches (environment variables):
#   FAKE_CLOUDFLARED_CRASH=1         exit with code 1 before connecting
#   FAKE_CLOUDFLARED_CRASH_FILE=path exit with code 1 before connecting while this file exists
#   FAKE_CLOUDFLARED_IGNORE_TERM=1   ignore SIGTERM (forces the supervisor to SIGKILL)
#   FAKE_CLOUDFLARED_LEAK_TOKEN=1    print the tunnel token (to test log scrubbing)
#   FAKE_CLOUDFLARED_DELAY=seconds   delay before connections register (default 0.2)

if [ "$1" = "--version" ] || [ "$1" = "version" ]; then
  echo "cloudflared version 2026.11.0 (built 2026-11-01-1200 UTC)"
  exit 0
fi

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }

if [ -z "$TUNNEL_TOKEN" ]; then
  echo "$(ts) ERR \"cloudflared tunnel run\" requires the ID or name of the tunnel to run as the last command line argument or in the configuration file." >&2
  exit 1
fi

echo "$(ts) INF Starting tunnel tunnelID=6ff42ae2-765d-4adf-8112-31c55c1551ef" >&2
echo "$(ts) INF Version 2026.11.0 (Checksum 0000000000000000)" >&2
echo "$(ts) INF GOOS: linux, GOVersion: go1.24.0, GoArch: amd64" >&2
echo "$(ts) INF Generated Connector ID: 9e0c7a2c-2b4c-4f5d-9a6e-0c1d2e3f4a5b" >&2
echo "$(ts) INF Initial protocol quic" >&2
echo "$(ts) INF Starting metrics server on 127.0.0.1:20241/metrics" >&2

if [ -n "$FAKE_CLOUDFLARED_LEAK_TOKEN" ]; then
  echo "$(ts) DBG using token=$TUNNEL_TOKEN" >&2
  echo "$(ts) DBG raw $TUNNEL_TOKEN" >&2
fi

if [ -n "$FAKE_CLOUDFLARED_CRASH" ] || { [ -n "$FAKE_CLOUDFLARED_CRASH_FILE" ] && [ -f "$FAKE_CLOUDFLARED_CRASH_FILE" ]; }; then
  echo "$(ts) ERR Failed to dial a quic connection error=\"failed to dial to edge with quic: timeout: no recent network activity\"" >&2
  echo "$(ts) FTL Couldn't start tunnel error=\"simulated crash\"" >&2
  exit 1
fi

if [ -n "$FAKE_CLOUDFLARED_IGNORE_TERM" ]; then
  trap '' TERM
else
  trap 'echo "$(ts) INF Initiating graceful shutdown due to signal terminated ..." >&2; exit 0' TERM INT
fi

sleep "${FAKE_CLOUDFLARED_DELAY:-0.2}"
i=0
for colo in cdg01 ams01 cdg07 fra02; do
  echo "$(ts) INF Registered tunnel connection connIndex=$i connection=1a2b3c4d-0000-4000-8000-00000000000$i event=0 ip=198.41.192.$((i + 7)) location=$colo protocol=quic" >&2
  i=$((i + 1))
done

while true; do
  sleep 1 &
  wait $!
done
