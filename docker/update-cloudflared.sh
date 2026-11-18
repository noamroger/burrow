#!/usr/bin/env bash
# Bump the pinned cloudflared version and its SHA-256 checksums in the Dockerfile.
#
# Usage: docker/update-cloudflared.sh [version]
#   version  a cloudflared release tag, e.g. 2026.11.0
#            (default: the version currently in the Dockerfile, which is what
#            you want on a Renovate PR that already bumped it)
#
# The binaries are downloaded from the official GitHub release, hashed, and
# compared with the checksums published in the release notes when the GitHub
# API is reachable.
set -euo pipefail

cd "$(dirname "$0")/.."
DOCKERFILE=Dockerfile

current=$(sed -n 's/^ARG CLOUDFLARED_VERSION=//p' "$DOCKERFILE")
version="${1:-$current}"
if [[ -z "$version" ]]; then
  echo "Could not read CLOUDFLARED_VERSION from $DOCKERFILE" >&2
  exit 1
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

notes=""
if notes=$(curl -fsSL "https://api.github.com/repos/cloudflare/cloudflared/releases/tags/${version}" 2>/dev/null); then
  :
else
  notes=""
  echo "note: could not fetch release notes, skipping the cross-check" >&2
fi

declare -A sums
for arch in amd64 arm64; do
  url="https://github.com/cloudflare/cloudflared/releases/download/${version}/cloudflared-linux-${arch}"
  echo "Downloading $url"
  curl -fsSL -o "$tmp/cloudflared-linux-${arch}" "$url"
  sum=$(sha256sum "$tmp/cloudflared-linux-${arch}" | cut -d' ' -f1)
  sums[$arch]=$sum
  echo "  sha256 ${arch}: $sum"
  if [[ -n "$notes" ]]; then
    if grep -q "$sum" <<<"$notes"; then
      echo "  matches the checksum published in the release notes"
    else
      echo "  WARNING: checksum not found in the release notes, check manually" >&2
    fi
  fi
done

sed -i \
  -e "s/^ARG CLOUDFLARED_VERSION=.*/ARG CLOUDFLARED_VERSION=${version}/" \
  -e "s/^ARG CLOUDFLARED_SHA256_AMD64=.*/ARG CLOUDFLARED_SHA256_AMD64=${sums[amd64]}/" \
  -e "s/^ARG CLOUDFLARED_SHA256_ARM64=.*/ARG CLOUDFLARED_SHA256_ARM64=${sums[arm64]}/" \
  "$DOCKERFILE"

echo "Updated $DOCKERFILE to cloudflared ${version}."
