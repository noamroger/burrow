# Contributing to Burrow

Thanks for your interest in Burrow! Bug reports, docs fixes, ideas and code
are all welcome. This guide explains how to get a working dev setup and how
changes get merged.

By taking part you agree to follow our [Code of Conduct](CODE_OF_CONDUCT.md).
Security issues go through [SECURITY.md](SECURITY.md), never public issues.

## Ways to contribute

- **Report a bug** or **suggest a feature** with the issue templates.
- **Improve the docs**: README, `docs/`, network FAQ, typos. Small PRs are great.
- **Pick an issue** labelled `good first issue` or `help wanted`. Comment on it
  first so nobody duplicates the work.
- For anything large (new feature, new dependency, change of architecture),
  open an issue to discuss it **before** writing code.

## Project layout

```
apps/server/      Fastify API, services, cloudflared supervisor, Drizzle schema & migrations
apps/web/         React + Vite + Tailwind SPA
packages/shared/  zod schemas and types shared by server and web (the API contract)
docker/           container entrypoint, healthcheck, helper scripts
docs/             architecture, ADRs, Cloudflare API notes
```

Start with [`docs/architecture.md`](docs/architecture.md): it explains the
components, the data model and how a proxy host is synced to Cloudflare.

## Development setup

Requirements:

- **Node.js 22** (see `.nvmrc`; `nvm use` or `fnm use`)
- **pnpm 10**, through Corepack: `corepack enable`
- Docker (optional, to build and run the image)

```sh
git clone https://github.com/noamroger/burrow.git
cd burrow
corepack enable
pnpm install
pnpm --filter @burrow/shared build   # server and web import its dist/ output
```

### Run without a Cloudflare account

You do not need a real Cloudflare account or tunnel to work on Burrow. The
server ships two test doubles:

- a **mock Cloudflare API** (tunnels, configurations, DNS, zones, token
  verification) served locally;
- a **fake `cloudflared`** script that prints realistic log lines and behaves
  like a connected tunnel.

In three terminals:

The quickest way is one command, which starts the three parts below:

```sh
pnpm dev:mock   # then open http://localhost:5173
```

Or run each part yourself:

```sh
# 1. Mock Cloudflare API
pnpm --filter @burrow/server mock:cf

# 2. API server, pointed at the mock and the fake cloudflared
DATA_DIR=./.data \
CLOUDFLARE_API_BASE=http://127.0.0.1:8787/client/v4 \
CLOUDFLARED_PATH=./test/fixtures/fake-cloudflared.sh \
LOG_LEVEL=debug \
pnpm --filter @burrow/server dev

# 3. Web UI with hot reload (proxies /api to the server)
pnpm --filter @burrow/web dev
```

The mock listens on `http://127.0.0.1:8787` (change it with `MOCK_CF_PORT` /
`MOCK_CF_HOST`; use `MOCK_CF_HOST=0.0.0.0` when a container must reach it).
In the setup wizard, paste any token of 20+ characters; tokens containing
`invalid` are rejected, which is handy to test error paths. `CLOUDFLARED_PATH` is resolved relative to `apps/server`, where the
`dev` script runs. `.data/` is git-ignored; delete it to start from scratch.

### Run against a real Cloudflare account

Use a test zone if you can. Create an API token with the permissions listed in
the README, then start the server without `CLOUDFLARE_API_BASE` and with
`CLOUDFLARED_PATH` pointing to a real `cloudflared` binary.

### Useful commands

| Command                             | What it does                     |
| ----------------------------------- | -------------------------------- |
| `pnpm dev`                          | Run server and web in watch mode |
| `pnpm lint`                         | ESLint on the whole repo         |
| `pnpm format` / `pnpm format:check` | Prettier write / check           |
| `pnpm typecheck`                    | TypeScript in every package      |
| `pnpm test`                         | Vitest in every package          |
| `pnpm build`                        | Build shared, server and web     |

CI runs `lint`, `format:check`, `typecheck`, `test`, `build` and a Docker
build on every pull request. Run them locally before pushing.

### Build and run the Docker image

```sh
docker build -t burrow:dev .
docker run --rm -p 127.0.0.1:8080:8080 -v burrow-dev-data:/data burrow:dev
# or
docker compose -f docker-compose.dev.yml up --build
```

The image is multi-stage: TypeScript and the SPA are built once on the build
machine, then `pnpm deploy` installs production dependencies (including the
native `better-sqlite3` and `@node-rs/argon2` modules) for the target
architecture. To build both architectures you need a buildx builder with QEMU:

```sh
docker buildx build --platform linux/amd64,linux/arm64 -t burrow:dev .
```

## Making changes

### Branches and commits

- Fork, then branch from `main`: `feat/docker-discovery`, `fix/dns-conflict`...
- We use [Conventional Commits](https://www.conventionalcommits.org/):
  `type(scope): summary`, for example:
  - `feat(hosts): support path-based ingress rules`
  - `fix(supervisor): reset backoff after 5 minutes healthy`
  - `docs(readme): add Tailscale network example`
  - `chore(deps): bump fastify to 5.13`

  Types: `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`,
  `chore`. Add `!` for breaking changes (`feat(api)!: ...`).

- Keep PRs focused. One logical change per PR is easier to review.
- PRs are squash-merged, so the PR title becomes the commit message: make it
  a good conventional commit.

### Code guidelines

- TypeScript strict mode, ESM, no `any` unless justified in a comment.
- The API contract lives in `packages/shared`: change the zod schema there
  first, then the server and the web.
- **Never log secrets.** The Cloudflare token, tunnel token, session ids and
  passwords must not reach logs, errors, API responses or tests snapshots.
- Every Cloudflare write must be idempotent and safe to retry. Burrow never
  edits or deletes a DNS record it did not create (see the `managed-by:burrow`
  comment in `docs/architecture.md`).
- UI strings go through the `t()` helper so translations can be added later.
- Add tests: unit tests for logic (the reconciler planner is pure and easy to
  test), integration tests against the mock Cloudflare API for flows.

### Architecture Decision Records

Structural choices (a new dependency with a large footprint, a change in how
state is stored, a new process in the container...) are documented as ADRs in
[`docs/adr/`](docs/adr/). Copy the format of an existing one, use the next
number, and include it in your PR. ADRs are never edited after being
accepted; a new ADR supersedes an old one.

### Database migrations

The schema is defined with Drizzle in `apps/server/src/db/schema.ts`.
Migrations are versioned SQL files in `apps/server/drizzle/` and are applied
automatically when the server starts.

1. Edit `apps/server/src/db/schema.ts`.
2. Generate the migration:
   ```sh
   pnpm --filter @burrow/server db:generate
   ```
3. Review the generated SQL in `apps/server/drizzle/` (rename the file to
   something meaningful if you like) and commit it with the schema change.
4. Never edit a migration that has been released: add a new one instead.
5. Think about existing installations: new columns need a default, and data
   migrations must work on databases created by every previous release.

### Bumping cloudflared

The image embeds an official `cloudflared` release, pinned in the
`Dockerfile` with a SHA-256 checksum per architecture. The build fails if a
downloaded binary does not match.

Renovate opens a PR when a new cloudflared release is out, but it can only
change the version, not the checksums. To finish the PR (or to bump by hand):

```sh
git checkout <renovate-branch>   # or a new branch
docker/update-cloudflared.sh            # uses the version in the Dockerfile
# or: docker/update-cloudflared.sh 2026.12.0
git commit -am "chore(deps): update cloudflared checksums"
```

The script downloads both binaries (amd64, arm64), computes their checksums,
cross-checks them with the checksums published in the GitHub release notes
when the GitHub API is reachable, and rewrites the `ARG` lines. Read the
cloudflared release notes for breaking changes before merging.

`tini` is pinned the same way (`TINI_VERSION`, `TINI_SHA256_*`); take the new
checksums from the `tini-static-<arch>.sha256sum` assets of the release.

## Releases

Maintainers release by pushing a `vX.Y.Z` tag on `main`. The release workflow
builds the multi-arch image, pushes it to GHCR with SBOM and
provenance, and creates the GitHub release with generated notes.

## Questions?

Open a [discussion](https://github.com/noamroger/burrow/discussions) or ask in
your issue/PR. Thanks for helping!
