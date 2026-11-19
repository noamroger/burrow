#!/bin/sh
# burrow-reset-password: reset the admin password from inside the container.
#
#   docker exec -it burrow burrow-reset-password [--generate] [--disable-2fa]
#
# `docker exec` runs as root by default. The database must stay owned by the
# user Burrow runs as, so the script switches to the owner of the data
# directory first (like the entrypoint does), then runs the Node script.
set -eu

DATA_DIR="${DATA_DIR:-/data}"
SCRIPT=/app/dist/cli/reset-password.js

if [ "$(id -u)" = "0" ] && [ -d "$DATA_DIR" ]; then
  OWNER="$(stat -c '%u' "$DATA_DIR")"
  GROUP="$(stat -c '%g' "$DATA_DIR")"
  if [ "$OWNER" != "0" ]; then
    exec setpriv --reuid="$OWNER" --regid="$GROUP" --clear-groups --inh-caps=-all \
      node "$SCRIPT" "$@"
  fi
fi

exec node "$SCRIPT" "$@"
