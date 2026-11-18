# 4. Technology stack

Status: accepted (2026-11-18)

| Area             | Choice                                      | Why                                                                                      |
| ---------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Runtime          | Node.js 22 LTS, TypeScript (strict, ESM)    | Target audience and maintainer skills                                                    |
| HTTP             | Fastify 5                                   | Fast, schema-first, good plugin ecosystem (helmet, rate-limit, cookie, static)           |
| DB               | SQLite via better-sqlite3 + Drizzle ORM     | Single file in `/data`, typed queries, versioned migrations                              |
| Validation       | zod, shared in `packages/shared`            | One contract for server and web                                                          |
| Password hashing | argon2id via `@node-rs/argon2`              | Prebuilt binaries for amd64 and arm64, no build toolchain in the image                   |
| Frontend         | React 18 + Vite + Tailwind + TanStack Query | Largest contributor pool; good DX; small bundle is enough for a dashboard                |
| Tests            | Vitest (both apps)                          | Same runner everywhere, fast, ESM-native                                                 |
| Package manager  | pnpm workspaces                             | Fast, strict, good for monorepos                                                         |
| Base image       | `node:22-bookworm-slim`                     | glibc avoids native-module surprises with better-sqlite3 on arm64; alpine was considered |
| Licence          | MIT                                         | Same as Nginx Proxy Manager, maximises adoption and contributions                        |
