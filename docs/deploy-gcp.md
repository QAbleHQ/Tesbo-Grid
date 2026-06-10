# Deploy on GCP

Reference deployment on GKE with managed datastores.

## Provision

| Need | GCP service |
|------|-------------|
| Kubernetes | GKE (Standard or Autopilot) |
| Postgres | Cloud SQL for PostgreSQL (databases `tesbo_grid` + `tesbo_execution`) |
| Redis | Memorystore for Redis |
| Artifacts | Cloud Storage bucket (S3 interoperability mode) |
| Images | Artifact Registry (or public GHCR images) |
| Ingress/TLS | GKE Ingress + Google-managed certificate |

## Configure

```bash
tesbo-grid init --target kubernetes --non-interactive \
  --frontend-host grid.acme.com --backend-host api.acme.com \
  --runner-host run.acme.com --grid-domain selenium.acme.com \
  --ingress-provider gcp \
  --database-url "postgres://USER:PASS@CLOUDSQL_IP:5432/tesbo_grid" \
  --redis-url "redis://MEMORYSTORE_IP:6379"
```

Edit `values.generated.yaml`:

- `database.executionUrl` → the `tesbo_execution` database.
- `storage`: `provider: s3`, set `endpoint: https://storage.googleapis.com`,
  `forcePathStyle: false`, and HMAC interop keys for `accessKey`/`secretKey`.
- Cloud SQL: prefer the Cloud SQL Auth Proxy sidecar, or use a private IP.
- `ingress.annotations`: `kubernetes.io/ingress.class: gce` and a
  `networking.gke.io/managed-certificates` reference; set `ingress.className` empty
  if using the GCE annotation style.

## Frontend image

Build with `--build-arg NEXT_PUBLIC_API_URL=https://api.acme.com` and push to
Artifact Registry; set `image.registry` to your registry path.

## Deploy

```bash
tesbo-grid up --target kubernetes --namespace tesbo-grid
```
