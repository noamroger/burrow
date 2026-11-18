# syntax=docker/dockerfile:1.7
#
# Burrow: one image with the dashboard, the API and a supervised cloudflared.
#
# Multi-arch (linux/amd64, linux/arm64):
#   docker buildx build --platform linux/amd64,linux/arm64 -t burrow:dev .
#
# Stages:
#   cloudflared  download and verify the official cloudflared and tini binaries
#   build        install all deps, build shared + server + web (runs natively
#                on the build host, output is architecture independent)
#   prod-deps    production-only node_modules for the TARGET architecture
#                (native modules: better-sqlite3, @node-rs/argon2)
#   runtime      small final image, non-root, tini as PID 1

# Base image. Renovate keeps the tag (and adds a digest) up to date.
# node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee (2026-11-18)
ARG NODE_IMAGE=node:22-bookworm-slim

# cloudflared is pinned AND verified. When bumping the version, update both
# checksums with: docker/update-cloudflared.sh <version>
# renovate: datasource=github-releases depName=cloudflare/cloudflared
ARG CLOUDFLARED_VERSION=2026.11.0
ARG CLOUDFLARED_SHA256_AMD64=51f7c68b57ed7269164075d7e789efce5b59355982f06392deeb037d982a51fd
ARG CLOUDFLARED_SHA256_ARM64=abe54a006acf9faf2d19ee9d953cb0d0804e92f59c5382a162e57b84d086f56f

# tini (PID 1), static build from the official release, pinned and verified.
# Checksums are the ones published next to each release asset (*.sha256sum).
# renovate: datasource=github-releases depName=krallin/tini
ARG TINI_VERSION=v0.19.0
ARG TINI_SHA256_AMD64=c5b0666b4cb676901f90dfcb37106783c5fe2077b04590973b885950611b30ee
ARG TINI_SHA256_ARM64=eae1d3aa50c48fb23b8cbdf4e369d0910dfc538566bfd09df89a774aa84a48b9

# pnpm version comes from the "packageManager" field of package.json (corepack).

# ---------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS cloudflared
ARG TARGETARCH
ARG CLOUDFLARED_VERSION
ARG CLOUDFLARED_SHA256_AMD64
ARG CLOUDFLARED_SHA256_ARM64
ARG TINI_VERSION
ARG TINI_SHA256_AMD64
ARG TINI_SHA256_ARM64
ADD https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-${TARGETARCH} /tmp/cloudflared
ADD https://github.com/krallin/tini/releases/download/${TINI_VERSION}/tini-static-${TARGETARCH} /tmp/tini
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
# The slim base image has no ca-certificates package. cloudflared (Go) needs a
# system CA bundle to reach HTTPS origins, so we export the Mozilla root store
# that ships with Node.js. It is refreshed whenever the Node base image is.
RUN case "${TARGETARCH}" in \
      amd64) cf_sum="${CLOUDFLARED_SHA256_AMD64}"; tini_sum="${TINI_SHA256_AMD64}" ;; \
      arm64) cf_sum="${CLOUDFLARED_SHA256_ARM64}"; tini_sum="${TINI_SHA256_ARM64}" ;; \
      *) echo "Unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
 && echo "${cf_sum}  /tmp/cloudflared" | sha256sum -c - \
 && echo "${tini_sum}  /tmp/tini" | sha256sum -c - \
 && mkdir -p /out/usr/local/bin /out/usr/bin /out/etc/ssl/certs \
 && install -m 0755 /tmp/cloudflared /out/usr/local/bin/cloudflared \
 && install -m 0755 /tmp/tini /out/usr/bin/tini \
 && node -e "process.stdout.write(require('node:tls').rootCertificates.join('\\n') + '\\n')" \
      > /out/etc/ssl/certs/ca-certificates.crt

# ---------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true
WORKDIR /src
RUN corepack enable
# Manifests first, so the dependency layer is cached when only sources change.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
# --ignore-scripts: no dependency needs an install script here. better-sqlite3
# (>= 12) ships N-API prebuilds for every platform we target, @node-rs/argon2
# and esbuild use per-platform optional packages. Skipping scripts avoids a
# pointless node-gyp rebuild (and the need for python/make/g++ in the image).
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store \
 && pnpm install --frozen-lockfile --ignore-scripts
COPY . .
RUN pnpm --filter @burrow/shared build \
 && pnpm --filter @burrow/server build \
 && pnpm --filter @burrow/web build

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS prod-deps
ARG TARGETARCH
ENV PNPM_HOME=/pnpm \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true
# better-sqlite3 and @node-rs/argon2 ship prebuilt binaries for linux-x64 and
# linux-arm64 (glibc), so no compiler toolchain is needed (see --ignore-scripts
# in the build stage).
WORKDIR /src
RUN corepack enable
COPY --from=build /src/package.json /src/pnpm-lock.yaml /src/pnpm-workspace.yaml ./
COPY --from=build /src/packages/shared ./packages/shared
COPY --from=build /src/apps/server ./apps/server
# "pnpm deploy" builds a self-contained directory with the server, its
# workspace dependencies (@burrow/shared, already built) and production
# node_modules compiled for the target architecture. --legacy keeps pnpm 10
# working without enabling inject-workspace-packages for the whole repo.
# Then drop what is not needed at runtime: sources, tests, dev scripts, the
# migrations source dir (the build copies them to dist/drizzle) and the SQLite
# amalgamation + C++ sources of better-sqlite3 and its prebuilt binaries for
# other platforms (~25 MB; only prebuilds/linux-<arch>.node is kept).
RUN --mount=type=cache,id=pnpm-store-${TARGETARCH},target=/pnpm/store \
    pnpm config set store-dir /pnpm/store \
 && rm -rf packages/shared/node_modules apps/server/node_modules \
 && pnpm --filter @burrow/server deploy --prod --legacy --ignore-scripts /out \
 && rm -rf /out/src /out/test /out/mock /out/scripts /out/drizzle /out/tsconfig*.json \
          /out/vitest.config.* /out/drizzle.config.* /out/.turbo \
 && find /out/node_modules/.pnpm -type d -path '*/node_modules/better-sqlite3' \
      -exec rm -rf '{}/deps' '{}/src' \; \
 && case "${TARGETARCH}" in amd64) sqlite_abi=linux-x64 ;; *) sqlite_abi="linux-${TARGETARCH}" ;; esac \
 && find /out/node_modules/.pnpm -type f -path '*/better-sqlite3/prebuilds/*.node' \
      ! -name "${sqlite_abi}.node" -delete

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime

ARG VERSION=dev
ARG CLOUDFLARED_VERSION
LABEL org.opencontainers.image.title="Burrow" \
      org.opencontainers.image.description="A friendly web UI to publish your homelab services through Cloudflare Tunnel." \
      org.opencontainers.image.source="https://github.com/noamroger/burrow" \
      org.opencontainers.image.url="https://github.com/noamroger/burrow" \
      org.opencontainers.image.documentation="https://github.com/noamroger/burrow#readme" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}" \
      io.github.noamroger.burrow.cloudflared-version="${CLOUDFLARED_VERSION}"

# The base image ships a "node" user with uid 1000; rename it to "burrow".
RUN groupmod --new-name burrow node \
 && usermod --login burrow --home /home/burrow --move-home node \
 && mkdir -p /data /app \
 && chown burrow:burrow /data

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    CLOUDFLARED_PATH=/usr/local/bin/cloudflared \
    WEB_DIST_DIR=/app/web \
    BURROW_VERSION=${VERSION} \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt

WORKDIR /app
# cloudflared, tini (PID 1: forwards signals, reaps zombies) and the CA bundle.
COPY --from=cloudflared /out/ /
COPY --from=prod-deps --chown=root:root /out /app
COPY --from=build --chown=root:root /src/apps/web/dist /app/web
COPY --chmod=0755 docker/entrypoint.sh /usr/local/bin/burrow-entrypoint
COPY --chmod=0755 docker/healthcheck.mjs /usr/local/bin/burrow-healthcheck.mjs

USER 1000:1000
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "/usr/local/bin/burrow-healthcheck.mjs"]

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/burrow-entrypoint"]
CMD ["node", "dist/index.js"]
