# Deploy on AWS

Reference deployment on EKS with managed datastores. Adapt sizing to your load.

## Provision

| Need | AWS service |
|------|-------------|
| Kubernetes | EKS (managed node groups) |
| Postgres | RDS for PostgreSQL (create `tesbo_grid` + `tesbo_execution` databases) |
| Redis | ElastiCache for Redis |
| Artifacts | S3 bucket |
| Images | ECR (or use the public GHCR images) |
| Ingress/TLS | AWS Load Balancer Controller + ACM certificate |

## Configure

```bash
tesbo-grid init --target kubernetes --non-interactive \
  --frontend-host grid.acme.com --backend-host api.acme.com \
  --runner-host run.acme.com --grid-domain selenium.acme.com \
  --ingress-provider aws \
  --database-url "postgres://USER:PASS@your-rds:5432/tesbo_grid" \
  --redis-url "rediss://your-elasticache:6379"
```

Edit `values.generated.yaml`:

- `database.executionUrl`: `postgres://USER:PASS@your-rds:5432/tesbo_execution`
- `storage`: `provider: s3`, `bucket`, `region` (leave `endpoint` blank for S3),
  and either credentials or use an IRSA role on the worker pods.
- `redis.kedaAddress` / `redis.kedaPassword` if `autoscaling.enabled: true`.
- `ingress.annotations`: ALB annotations, e.g.
  `alb.ingress.kubernetes.io/scheme: internet-facing`,
  `alb.ingress.kubernetes.io/certificate-arn: <ACM ARN>`,
  and set `ingress.className: alb`.

## Frontend image

Build the dashboard with your public backend URL baked in, push to ECR, and set
`image.registry` accordingly:

```bash
docker build -f grid-frontend/Dockerfile \
  --build-arg NEXT_PUBLIC_API_URL=https://api.acme.com \
  --build-arg NEXT_PUBLIC_SELENIUM_GRID_DOMAIN=selenium.acme.com \
  -t <ecr>/tesbox-executions-frontend:<tag> .
```

## Deploy

```bash
tesbo-grid up --target kubernetes --namespace tesbo-grid
```

Point your DNS records (the four hostnames) at the ALB, and you're live.
