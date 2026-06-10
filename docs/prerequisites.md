# Prerequisites

What to have ready **before** you run `tesbo-grid init`. Requirements differ by
deploy path — start with the common section, then the path you're using.

## Common (both paths)

- **Node.js ≥ 18** — to run the `tesbo-grid` setup CLI (and the `tesbox` test CLI).
- **Git** — to clone the repository.
- **A strong shared secret** — the wizard generates `TESBO_INTERNAL_TOKEN` for
  you (`openssl rand -hex 32` if you set it by hand). Used for internal
  service-to-service auth.
- **Decide on hostnames** — the four public URLs the platform serves:
  dashboard, backend API, runner API, and the Selenium Grid endpoint. For a
  local trial these default to `localhost`; for anything shared you'll want real
  DNS names.

---

## Path A — Docker Compose (single VM)

The easiest path. One host runs everything.

**Software**
- **Docker Engine** + **Docker Compose v2** (`docker compose version`).

**Hardware / sizing** — Selenium browsers are the memory driver:
- Minimum to try it: **2 vCPU / 4 GB**.
- Comfortable: **4 vCPU / 8 GB+**. Each Chrome/Firefox session needs
  ~1–1.5 GB; plan capacity around how many parallel browser sessions you want
  (`SELENIUM_NODE_MAX_SESSIONS`, default 4).
- **Disk**: 20 GB+ (browser images + Postgres data + test artifacts).

**Network / ports** — these are exposed by the bundled stack (change or
firewall as needed): `3100` dashboard, `7100` backend, `7420` runner API,
`7430` selenium proxy, `4444` Selenium hub, `5433` Postgres, `6380` Redis.
Run `tesbo-grid doctor` to check they're free.

**For a real (non-localhost) deployment**, additionally:
- **DNS records** pointing at the host for your hostnames.
- A **TLS-terminating reverse proxy** in front (nginx, Caddy, Traefik) plus
  certificates (e.g. Let's Encrypt).

That's it — Postgres and Redis are bundled, so no external database is required
for the Compose path.

---

## Path B — Kubernetes (AWS / GCP / Azure)

For horizontal scale and production. You bring the cluster and datastores.

**Software (your workstation)**
- **`kubectl`** configured for your cluster (`kubectl config current-context`).
- **`helm` v3**.
- Optional: **[KEDA](https://keda.sh)** installed in the cluster if you want
  queue-depth autoscaling (`autoscaling.enabled: true`).

**Cluster**
- A running cluster: EKS / GKE / AKS, or self-managed (k3s, kubeadm). Enough
  capacity for the Selenium browser pods (memory-heavy — see sizing above).
- An **ingress controller** (nginx, ALB, GCLB, AGIC, …) and the ability to
  issue **TLS certificates** for your four hostnames (cert-manager or a
  cloud-managed cert).

**Managed datastores (recommended for production)**
- **PostgreSQL** with two databases: `tesbo_grid` (platform) and
  `tesbo_execution` (runner). RDS / Cloud SQL / Azure Flexible Server.
- **Redis** (ElastiCache / Memorystore / Azure Cache). If you enable KEDA you'll
  also provide its host:port + password (`redis.kedaAddress` / `kedaPassword`).
- *(For a quick cluster trial only, the chart can run bundled in-cluster
  Postgres/Redis — not for production.)*

**Container registry**
- Use the **public images** (`ghcr.io/qablehq/tesbo-grid/*`), or push to your
  own registry (ECR / Artifact Registry / ACR) and set `image.registry`.
- **The frontend image bakes its API URL at build time.** Build/publish the
  dashboard image with `--build-arg NEXT_PUBLIC_API_URL=https://<your backend>`
  so it calls the right origin. See the per-cloud guides.

**Artifact storage (optional but recommended)**
- An **S3-compatible bucket** (AWS S3, GCS interop, Azure via gateway, MinIO,
  DO Spaces) + access credentials, if you want screenshots/videos/traces
  persisted off-pod. Otherwise artifacts stay on the local volume.

---

## Optional integrations (any path)

Enable later by setting env — none are required to start:

| Capability | What you need |
|------------|---------------|
| Email (OTP / notifications) | A Postmark account + `POSTMARK_API_TOKEN`. Without it, OTP codes are written to the backend logs (fine for dev). |
| GitHub integration (CI triggers, sign-in) | A GitHub App: `GH_APP_ID`, client ID/secret, a private key, and a webhook secret. |
| Artifact storage | S3-compatible bucket + credentials (see above). |
| APM / tracing | A Middleware.io token (`MW_APM_ACCESS_TOKEN`). |

---

## Quick checklist

**Compose:** Docker + Compose v2 · a host with ≥4 GB RAM · (prod) DNS + TLS proxy
→ `tesbo-grid init` → `tesbo-grid doctor` → `tesbo-grid up`.

**Kubernetes:** kubectl + helm · a cluster + ingress + TLS · managed Postgres
(two DBs) + Redis · registry choice · (optional) S3 bucket + KEDA
→ `tesbo-grid init --target kubernetes` → fill `values.generated.yaml`
→ `tesbo-grid doctor --target kubernetes` → `tesbo-grid up --target kubernetes`.
