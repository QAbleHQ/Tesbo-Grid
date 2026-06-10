# Self-hosting Tesbo-Grid

Two supported substrates: **Docker Compose** (single VM, easiest) and
**Kubernetes via Helm** (scales horizontally). Both are driven by the same
`tesbo-grid` operator CLI.

## Prerequisites

- **Compose:** Docker Engine + Compose v2 on one host. ~4 vCPU / 8 GB is a
  comfortable starting point (Selenium browsers are memory-hungry).
- **Kubernetes:** a cluster (EKS/GKE/AKS/k3s/kind), `kubectl`, `helm`, and —
  if you want queue-based autoscaling — [KEDA](https://keda.sh) installed.
- Node.js ≥ 18 to run the setup CLI.

Run `tesbo-grid doctor` (add `--target kubernetes` for the k8s checks) to verify.

---

## Docker Compose

```bash
npm run setup            # tesbo-grid init → writes .env (generated secrets)
npm run up               # tesbo-grid up  → builds + starts, runs migrations
```

What you get: Postgres (two DBs), Redis, the backend, execution API, dashboard,
Selenium hub + chrome/firefox nodes, the auth proxy, and all five worker pools.

- Build from source (default) or use prebuilt images:
  `tesbo-grid up --prebuilt` (set `TESBO_REGISTRY`/`TESBO_IMAGE_TAG` in `.env`).
- Stop: `tesbo-grid down` (add `--volumes` to wipe data).
- Update: `tesbo-grid upgrade`.

For a real deployment, put a TLS-terminating reverse proxy (nginx, Caddy,
Traefik) in front and set `FRONTEND_URL` / `BACKEND_PUBLIC_URL` /
`RUNNER_PUBLIC_API_URL` / `SELENIUM_GRID_DOMAIN` to your public hostnames.

---

## Kubernetes (Helm)

```bash
tesbo-grid init --target kubernetes      # writes values.generated.yaml
# edit values.generated.yaml: set database.url, redis.url, hostnames, ingress
tesbo-grid up   --target kubernetes      # helm upgrade --install --wait
```

Recommended production setup:

1. **Managed Postgres** with two databases (`tesbo_grid`, `tesbo_execution`).
   Set `database.url` and `database.executionUrl`.
2. **Managed Redis**. Set `redis.url`, plus `redis.kedaAddress` /
   `redis.kedaPassword` if you enable autoscaling.
3. **S3-compatible storage** for artifacts (`storage.provider: s3`).
4. **Ingress**: pick `ingress.provider` and supply TLS. The chart routes the
   four hostnames (frontend, backend, runner, selenium grid) to their services.
5. **Frontend image**: the dashboard bakes `NEXT_PUBLIC_API_URL` at build time.
   Build/publish the frontend image with your public backend URL (see the
   per-cloud guides) so the dashboard calls the right API origin.

Migrations run automatically inside the backend and execution-api containers on
start. Bring-up is idempotent — re-running `helm upgrade --install` is safe.

The bundled in-cluster Postgres/Redis (`database.bundled.enabled`,
`redis.bundled.enabled`) exist for quick trials only — use managed datastores in
production.

---

## First login

The dashboard uses email-OTP login and auto-creates a workspace (organization)
for the first user. To send real OTP emails configure `POSTMARK_API_TOKEN`;
otherwise the OTP is written to the backend logs (fine for local/dev).

See the [configuration reference](configuration.md) for every variable.
