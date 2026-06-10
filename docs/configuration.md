# Configuration reference

All services are configured via environment variables. `tesbo-grid init`
generates these for you (`.env` for Compose, `values.generated.yaml` for Helm);
this page is the full reference for manual tuning.

Secrets you must set: a strong `TESBO_INTERNAL_TOKEN` (shared service token) and
a Postgres password. The setup CLI generates both with `crypto.randomBytes`.

## Shared / cross-service

| Variable | Default | Purpose |
|----------|---------|---------|
| `TESBO_INTERNAL_TOKEN` | — | Shared secret for internal service-to-service auth. Maps to `INTERNAL_SHARED_TOKEN` / `EXECUTION_API_SHARED_TOKEN`. |
| `POSTGRES_PASSWORD` | `postgres` | Password for the bundled Postgres (Compose). |

## grid-backend (platform API, :7100)

| Variable | Default | Purpose |
|----------|---------|---------|
| `DATABASE_URL` | **required** | Postgres URL for the `tesbo_grid` database. |
| `PORT` | `7100` | Listen port. |
| `FRONTEND_URL` | `""` | Dashboard origin (used for links + CORS). |
| `CORS_ALLOWED_ORIGINS` | — | Comma-separated allowed origins. |
| `PUBLIC_BACKEND_URL` | `http://localhost:7100` | Public URL of this API. |
| `EXECUTION_API_URL` | `http://localhost:7420` | Where to dispatch runs. |
| `RUNNER_PUBLIC_API_URL` | `http://localhost:7420` | Public runner-api URL injected into generated CI workflows. |
| `SELENIUM_PROXY_URL` | `http://localhost:7430` | For live-VNC streaming. |
| `INTERNAL_SHARED_TOKEN` / `EXECUTION_API_SHARED_TOKEN` | `""` | Internal auth (set from `TESBO_INTERNAL_TOKEN`). |
| `SESSION_DAYS` | `30` | Session cookie lifetime. |
| `SESSION_SECURE` / `SESSION_SAME_SITE` | `true` / — | Cookie flags (set `false`/`lax` for plain-HTTP local). |
| `POSTMARK_API_TOKEN` / `POSTMARK_FROM_EMAIL` | `""` | OTP/notification email (optional). |
| `GH_APP_*` | `""` | GitHub App integration (optional; disabled when blank). |

## grid-runner-api (execution API, :7420)

| Variable | Default | Purpose |
|----------|---------|---------|
| `DATABASE_URL` | **required** | Postgres URL for the `tesbo_execution` database. |
| `REDIS_URL` | `redis://localhost:6379` | BullMQ backend. |
| `QUEUE_PREFIX` / `QUEUE_NAME` | `bull` / `execution-jobs` | Queue naming. |
| `TESBO_API_URL` | `http://localhost:7100` | Backend, for key/project resolution. |
| `TESBO_UI_URL` | `http://localhost:3100` | Dashboard, for report links. |
| `INTERNAL_SHARED_TOKEN` / `EXECUTION_API_SHARED_TOKEN` | `""` | Internal auth. |
| `WEBHOOK_TIMEOUT_MS` | `10000` | Outbound webhook timeout. |

## grid-runner-workers

| Variable | Default | Purpose |
|----------|---------|---------|
| `EXECUTION_API_BASE_URL` | **required** | Callback URL to the execution API. |
| `EXECUTION_API_SHARED_TOKEN` | `""` | Internal auth for callbacks. |
| `REDIS_URL` | `redis://localhost:6379` | BullMQ backend. |
| `QUEUE_NAMES` | — | Comma-separated queues this pool consumes. |
| `QUEUE_CONCURRENCY` | `2` | Parallel jobs per worker. |
| `SUPPORTED_FRAMEWORKS` / `SUPPORTED_LANGUAGES` | — | Routing guardrails. |
| `PLAYWRIGHT_HEADLESS` | `true` | Headless browsers. |
| `SELENIUM_REMOTE_URL` | `""` | Hub URL for Selenium pools. |

## grid-selenium-proxy (:7430)

| Variable | Default | Purpose |
|----------|---------|---------|
| `DATABASE_URL` | **required** | Postgres URL for `tesbo_execution` (reads `api_keys`, `selenium_sessions`). |
| `SELENIUM_HUB_URL` | **required** | In-cluster Selenium hub `/wd/hub` URL. |
| `TESBO_API_URL` | `http://localhost:7100` | Backend, for project limits / key resolution. |
| `INTERNAL_SHARED_TOKEN` | `""` | Internal auth for live-VNC. |

## grid-frontend (build-time)

| Build arg | Purpose |
|-----------|---------|
| `NEXT_PUBLIC_API_URL` | Public backend URL the dashboard calls (baked at build). |
| `NEXT_PUBLIC_SELENIUM_GRID_DOMAIN` | Grid hostname shown in "Direct Grid URL" snippets. |

## Artifact storage (workers + backend)

S3-compatible. `SPACES_*` names are accepted as aliases for the `S3_*` names.

| Variable | Default | Purpose |
|----------|---------|---------|
| `ARTIFACT_STORAGE_PROVIDER` | `none` | `none` (local volume) or `s3`. |
| `S3_ENDPOINT` | `""` | Blank for AWS S3; set for MinIO/Spaces/GCS. |
| `S3_REGION` | `us-east-1` | Bucket region. |
| `S3_BUCKET` | `""` | Bucket name. |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | `""` | Credentials. |
| `S3_PUBLIC_BASE_URL` | `""` | Public base URL for stored artifacts (CDN/bucket). |
| `S3_FORCE_PATH_STYLE` | `false` | `true` for MinIO and similar. |
| `S3_OBJECT_ACL` | `public-read` | Set `""` for ACL-disabled buckets (AWS bucket-owner-enforced). |

## Observability (optional)

| Variable | Purpose |
|----------|---------|
| `MW_APM_ACCESS_TOKEN` / `MW_APM_SERVICE_NAME` / `MW_AGENT_SERVICE` | Middleware.io APM (no-op when unset). |
