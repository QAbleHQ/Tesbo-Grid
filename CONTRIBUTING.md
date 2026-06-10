# Contributing to Tesbo-Grid

Thanks for your interest in improving Tesbo-Grid! This document explains how to get
a development environment running and how to propose changes.

## Project layout

Tesbo-Grid is an npm-workspaces monorepo:

| Workspace | Purpose |
|-----------|---------|
| `grid-runner-api` | Execution orchestration REST API (port 7420) |
| `grid-runner-workers` | BullMQ workers that execute Playwright/Selenium tests |
| `grid-backend` | Platform backend: auth, projects, reports (port 7100) |
| `grid-frontend` | Next.js dashboard (port 3100) |
| `grid-selenium-proxy` | Auth proxy in front of Selenium Grid |
| `grid-shared` | Shared library (`@tesbox/playwright-runner`) |
| `grid-cli` | End-user test-submission CLI (`tesbox`) |
| `deploy/installer` | Operator setup CLI (`tesbo-grid`) |

## Local development

The fastest path is the bundled stack:

```bash
npm install
docker compose up -d          # Postgres, Redis, Selenium, API, workers
```

Or run individual services against your own Postgres/Redis:

```bash
npm run migrate:runner        # apply grid-runner-api migrations
npm run migrate:backend       # apply grid-backend migrations
npm run dev:runner-api
npm run dev:runner-worker
npm run dev:backend
npm run dev:frontend
```

See [docs/self-hosting.md](docs/self-hosting.md) for the full configuration reference.

## Tests

```bash
npm test                      # runs each workspace's test script
```

Please add or update tests for any behavior change. Backend/runner tests use the
Node.js built-in test runner; the frontend uses Vitest.

## Submitting changes

1. Fork and create a topic branch (`feat/...`, `fix/...`, `docs/...`).
2. Keep PRs focused and include a clear description of the motivation.
3. Ensure `npm test` passes and no secrets/credentials are committed.
4. By contributing, you agree your contributions are licensed under
   [Apache-2.0](LICENSE).

## Reporting security issues

Do **not** open public issues for vulnerabilities. See [SECURITY.md](SECURITY.md).
