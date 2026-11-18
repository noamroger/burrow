## Summary

<!-- What does this PR change, and why? Link the issue it closes. -->

Closes #

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactoring (no behaviour change)
- [ ] Documentation
- [ ] Build, CI or Docker image
- [ ] Breaking change (users must change their setup or data)

## How was it tested?

<!-- Unit tests, mock Cloudflare API, a real tunnel, screenshots for UI changes... -->

## Checklist

- [ ] The PR title follows [Conventional Commits](https://www.conventionalcommits.org/) (e.g. `feat(hosts): add path matching`)
- [ ] `pnpm lint`, `pnpm format:check`, `pnpm typecheck` and `pnpm test` pass locally
- [ ] Tests added or updated for the change
- [ ] Documentation updated (README, `docs/`, ADR if it is a structural decision)
- [ ] Database changes come with a migration (`pnpm --filter @burrow/server db:generate`)
- [ ] No secrets (tokens, keys) in code, logs, tests or screenshots
