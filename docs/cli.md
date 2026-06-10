# CLI reference

Tesbo-Grid ships **two separate CLIs** for two audiences.

## `tesbo-grid` — operator / installer

Sets up and runs the platform. Lives in `deploy/installer`; run via
`npm run setup`/`up`/`down`/`doctor` or `node deploy/installer/bin/tesbo-grid.js <cmd>`.

| Command | What it does |
|---------|--------------|
| `init` | Interactive wizard → writes `.env` (Compose) or `values.generated.yaml` (Helm). Generates secrets. |
| `up` | `docker compose up -d` or `helm upgrade --install`; runs DB migrations; waits for health. |
| `down` | Stops the stack (`--volumes` also removes data). |
| `upgrade` | Pulls/rebuilds images and recreates. |
| `doctor` | Preflight: docker/kubectl/helm present, cluster reachable, ports free. |

Common flags: `--target compose|kubernetes`, `--non-interactive`, `--prebuilt`
(Compose, use published images). See `tesbo-grid --help` for the full flag list,
including non-interactive `init` flags (`--frontend-url`, `--database-url`,
`--ingress-provider`, …) for CI/repeatable installs.

```bash
tesbo-grid init                                   # interactive, Compose
tesbo-grid up
tesbo-grid init --target kubernetes --non-interactive \
  --frontend-host grid.acme.com --backend-host api.acme.com \
  --database-url postgres://... --redis-url rediss://...
tesbo-grid up --target kubernetes --namespace tesbo-grid
```

## `tesbox` — end-user test runner (`@tesbox/cli`)

Submits or uploads test runs against a **deployed** Tesbo-Grid. Point it at your
instance with `--api-url` / `TESBOX_API_URL` and authenticate with `--api-key`.

| Command | What it does |
|---------|--------------|
| `run` | Submit a spec glob to the managed runners. |
| `run-build` | Register a build, run your command locally, upload results — one dashboard row. |
| `grid-run` | Like `run-build` but injects `SELENIUM_REMOTE_URL` so the browser runs on the grid. |
| `upload-results` | Upload an existing report (TestNG/JUnit/pytest). |

```bash
export TESBOX_API_URL=https://api.acme.com
tesbox run-build --api-key tesbo_... -- mvn test
tesbox upload-results test-output/ --api-key tesbo_...
```

Run `tesbox --help` for the complete options reference.
