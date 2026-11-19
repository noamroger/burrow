#!/bin/sh
# Burrow container entrypoint (runs under tini).
#
# Two ways to start:
#
# 1. As root (the default). The entrypoint makes sure the data directory
#    belongs to PUID:PGID (default 1000:1000), fixing it once if Docker created
#    it as root, then drops privileges with setpriv and runs itself again as
#    that user. Node and cloudflared never run as root.
#
# 2. As a non-root user (`user:` in docker-compose.yml, `docker run --user`).
#    Nothing is changed: the entrypoint only checks that the data directory is
#    writable and explains how to fix it if not.
set -eu

DATA_DIR="${DATA_DIR:-/data}"
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

die() {
  for line in "$@"; do echo "burrow: $line" >&2; done
  exit 1
}

if [ ! -d "$DATA_DIR" ]; then
  die "data directory $DATA_DIR does not exist." \
      "mount a volume there, for example: -v ./data:$DATA_DIR"
fi

if [ "$(id -u)" = "0" ]; then
  case "$PUID:$PGID" in
    *[!0-9:]* | :* | *: ) die "PUID and PGID must be numeric ids (got PUID=$PUID, PGID=$PGID)." ;;
  esac
  if [ "$PUID" = "0" ] || [ "$PGID" = "0" ]; then
    die "refusing to run as root: PUID and PGID must not be 0."
  fi

  # Fix ownership only when it is wrong, so a normal restart touches nothing.
  # The first time (empty directory created by Docker, or PUID/PGID changed)
  # the whole tree is handed over to the new owner.
  if [ "$(stat -c '%u:%g' "$DATA_DIR")" != "$PUID:$PGID" ]; then
    echo "burrow: setting owner of $DATA_DIR to $PUID:$PGID" >&2
    if ! chown -R "$PUID:$PGID" "$DATA_DIR" 2>/dev/null; then
      echo "burrow: warning: could not change the owner of $DATA_DIR" \
           "(missing CHOWN capability, or a network share with root squashing)." >&2
    fi
  fi

  # The image's "burrow" user is uid 1000; any other PUID gets a writable HOME.
  if [ "$PUID" = "1000" ]; then
    export HOME=/home/burrow
  else
    export HOME=/tmp
  fi

  # Docker discovery: when the Docker socket is mounted, join its group so
  # the unprivileged user can read it. A socket owned by root's group (gid 0)
  # is not joined: use a docker-socket-proxy (DOCKER_HOST=tcp://...) instead.
  GROUPS_OPT="--clear-groups"
  DOCKER_SOCK="${DOCKER_HOST:-unix:///var/run/docker.sock}"
  DOCKER_SOCK="${DOCKER_SOCK#unix://}"
  if [ -S "$DOCKER_SOCK" ]; then
    SOCK_GID="$(stat -c '%g' "$DOCKER_SOCK")"
    if [ "$SOCK_GID" != "0" ]; then
      GROUPS_OPT="--groups=$SOCK_GID"
    else
      echo "burrow: warning: $DOCKER_SOCK belongs to group 0; Docker discovery will not be able" \
           "to read it. Use a docker-socket-proxy and DOCKER_HOST=tcp://... instead." >&2
    fi
  fi

  if ! setpriv --reuid="$PUID" --regid="$PGID" "$GROUPS_OPT" --inh-caps=-all \
         true 2>/dev/null; then
    die "cannot switch to uid $PUID (the container lacks the SETUID/SETGID capabilities)." \
        "if you use 'cap_drop: [ALL]', add:  cap_add: [CHOWN, SETUID, SETGID]" \
        "or run the container directly as a non-root user with  user: \"$PUID:$PGID\""
  fi
  exec setpriv --reuid="$PUID" --regid="$PGID" "$GROUPS_OPT" --inh-caps=-all \
    "$0" "$@"
fi

# From here on we run as the unprivileged user.
if ! ( : > "$DATA_DIR/.write-test" ) 2>/dev/null; then
  die "cannot write to $DATA_DIR (running as uid $(id -u), gid $(id -g))." \
      "fix the owner on the host with:  sudo chown -R $(id -u):$(id -g) ./data" \
      "or remove 'user:' from docker-compose.yml and let Burrow fix it (see PUID/PGID)."
fi
rm -f "$DATA_DIR/.write-test"

if [ ! -x "${CLOUDFLARED_PATH:-/usr/local/bin/cloudflared}" ]; then
  echo "burrow: warning: cloudflared not found at ${CLOUDFLARED_PATH:-/usr/local/bin/cloudflared}" >&2
fi

exec "$@"
