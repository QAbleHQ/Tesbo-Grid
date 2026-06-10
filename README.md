# Tesbo-Grid

**Self-hostable distributed test-execution platform.** Run Playwright and Selenium
suites (JavaScript/TypeScript, Python, Java) at scale on your own infrastructure —
any cloud (AWS, GCP, Azure) or a single VM — with a dashboard, reports, live VNC,
and a one-command setup.

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

---

## Quickstart (single VM, ~2 minutes)

```bash
git clone https://github.com/QAbleHQ/Tesbo-Grid.git
cd tesbo-grid
npm run setup        # interactive wizard → writes .env with generated secrets
npm run up           # build + start the full stack, runs DB migrations
```

Then open the dashboard at the URL you chose (default `http://localhost:3100`).

Prefer to drive it directly? The operator CLI is `tesbo-grid`:

```bash
node deploy/installer/bin/tesbo-grid.js init      # or: npm run setup
node deploy/installer/bin/tesbo-grid.js doctor    # preflight checks
node deploy/installer/bin/tesbo-grid.js up        # start
```

Raw Docker Compose works too:

```bash
cp .env.example .env      # edit secrets/URLs
docker compose up -d
```

---

## Architecture

```
        Clients (CLI, CI/CD, RemoteWebDriver)
                      │  REST + Webhooks + WebDriver
        ┌─────────────┼───────────────────────────────┐
        ▼             ▼                                ▼
   ┌─────────┐  ┌──────────────┐              ┌────────────────┐
   │ Backend │  │ Execution API│──┐           │ Selenium Proxy │
   │ (7100)  │  │   (7420)     │  │ BullMQ    │   (7430)       │
   └────┬────┘  └──────┬───────┘  ▼           └───────┬────────┘
        │              │      ┌───────┐               │
        │              │      │ Redis │               ▼
        │              │      └───┬───┘        ┌──────────────┐
        ▼              ▼          ▼            │ Selenium Grid│
   ┌──────────┐   ┌──────────────────┐        │  hub + nodes │
   │ Postgres │   │  Worker pools    │───────▶│ (browsers)   │
   │          │   │ Playwright/Selen.│        └──────────────┘
   └──────────┘   └──────────────────┘
        ▲
   ┌────┴─────┐
   │ Frontend │ Next.js dashboard (3100)
   └──────────┘
```

| Component | Description | Port |
|-----------|-------------|------|
| `grid-frontend` | Next.js dashboard | 3100 |
| `grid-backend` | Platform API (auth, projects, reports, live VNC) | 7100 |
| `grid-runner-api` | Execution orchestration, dispatch, webhooks | 7420 |
| `grid-runner-workers` | BullMQ workers — one image per language/framework | — |
| `grid-selenium-proxy` | Auth proxy in front of Selenium Grid | 7430 |
| `grid-shared` | Shared library (`@tesbox/playwright-runner`) | — |
| `grid-cli` | End-user test-submission CLI (`tesbox`) | — |
| `deploy/installer` | Operator setup CLI (`tesbo-grid`) | — |

State lives in **PostgreSQL** (two databases: `tesbo_grid` for the platform,
`tesbo_execution` for the runner). Jobs flow through **Redis/BullMQ**. Test
artifacts (screenshots, videos, traces) go to a local volume by default, or any
**S3-compatible** store (AWS S3, GCS, MinIO, DO Spaces).

---

## Two CLIs (don't confuse them)

- **`tesbo-grid`** (operator) — sets up and runs the platform: `init`, `up`,
  `down`, `upgrade`, `doctor`. See [docs/cli.md](docs/cli.md).
- **`tesbox`** (`@tesbox/cli`, end user) — submits/uploads test runs against a
  deployed instance: `run`, `run-build`, `grid-run`, `upload-results`.

---

## Deploy on Kubernetes (AWS / GCP / Azure)

A cloud-agnostic Helm chart lives in [deploy/helm/tesbo-grid](deploy/helm/tesbo-grid):

```bash
tesbo-grid init --target kubernetes      # writes values.generated.yaml
tesbo-grid up   --target kubernetes      # helm upgrade --install + waits
```

Use a managed Postgres + Redis, point `database.url` / `redis.url` at them, set
your hostnames, and pick an ingress preset (`generic-ingress`, `aws`, `gcp`,
`azure`). KEDA-based autoscaling is optional. See the per-cloud guides:
[AWS](docs/deploy-aws.md) · [GCP](docs/deploy-gcp.md) · [Azure](docs/deploy-azure.md).

---

## Documentation

- [Self-hosting guide](docs/self-hosting.md) — Compose + Kubernetes
- [Configuration reference](docs/configuration.md) — every environment variable
- [CLI reference](docs/cli.md) — operator + end-user CLIs
- [Upgrading](docs/upgrading.md)
- [Contributing](CONTRIBUTING.md) · [Security policy](SECURITY.md)

---

## License

[Apache-2.0](LICENSE). See [NOTICE](NOTICE) for third-party attributions.
