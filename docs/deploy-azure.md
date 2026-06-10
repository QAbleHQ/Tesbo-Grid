# Deploy on Azure

Reference deployment on AKS with managed datastores.

## Provision

| Need | Azure service |
|------|---------------|
| Kubernetes | AKS |
| Postgres | Azure Database for PostgreSQL — Flexible Server (databases `tesbo_grid` + `tesbo_execution`) |
| Redis | Azure Cache for Redis |
| Artifacts | Azure Blob Storage (via an S3-compatible gateway such as MinIO Gateway, or use any S3-compatible store) |
| Images | Azure Container Registry (or public GHCR images) |
| Ingress/TLS | Application Gateway Ingress Controller (AGIC) or ingress-nginx + cert-manager |

## Configure

```bash
tesbo-grid init --target kubernetes --non-interactive \
  --frontend-host grid.acme.com --backend-host api.acme.com \
  --runner-host run.acme.com --grid-domain selenium.acme.com \
  --ingress-provider azure \
  --database-url "postgres://USER:PASS@your-pg.postgres.database.azure.com:5432/tesbo_grid?sslmode=require" \
  --redis-url "rediss://your-redis.redis.cache.windows.net:6380"
```

Edit `values.generated.yaml`:

- `database.executionUrl` → the `tesbo_execution` database (keep `sslmode=require`).
- `storage`: point at your S3-compatible endpoint (`endpoint`, `forcePathStyle: true`
  for gateways), bucket, and credentials.
- `redis.kedaAddress` / `redis.kedaPassword` for autoscaling.
- `ingress.annotations`: AGIC (`kubernetes.io/ingress.class: azure/application-gateway`)
  or ingress-nginx + a cert-manager-issued TLS secret.

## Frontend image

Build with `--build-arg NEXT_PUBLIC_API_URL=https://api.acme.com`, push to ACR,
and set `image.registry`.

## Deploy

```bash
tesbo-grid up --target kubernetes --namespace tesbo-grid
```
