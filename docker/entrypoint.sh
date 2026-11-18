#!/bin/sh
# Burrow container entrypoint.
# Runs under tini as the unprivileged "burrow" user (uid 1000). It only checks
# that the data directory is usable, then hands over to the command (node).
set -eu

DATA_DIR="${DATA_DIR:-/data}"

if [ ! -d "$DATA_DIR" ]; then
  echo "burrow: data directory $DATA_DIR does not exist." >&2
  echo "burrow: mount a volume there, for example: -v ./data:$DATA_DIR" >&2
  exit 1
fi

if ! ( : > "$DATA_DIR/.write-test" ) 2>/dev/null; then
  echo "burrow: cannot write to $DATA_DIR (running as uid $(id -u), gid $(id -g))." >&2
  echo "burrow: the directory is probably owned by root because Docker created it." >&2
  echo "burrow: fix it on the host with:  sudo chown -R 1000:1000 ./data" >&2
  echo "burrow: or run the container with a matching 'user:' in docker-compose.yml." >&2
  exit 1
fi
rm -f "$DATA_DIR/.write-test"

if [ ! -x "${CLOUDFLARED_PATH:-/usr/local/bin/cloudflared}" ]; then
  echo "burrow: warning: cloudflared not found at ${CLOUDFLARED_PATH:-/usr/local/bin/cloudflared}" >&2
fi

exec "$@"
