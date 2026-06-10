# Upgrading

Database migrations run automatically on container start (the backend and
execution-api entrypoints run their `db/migrate.js`), so upgrades are mostly a
matter of pulling new images and recreating.

## Docker Compose

```bash
git pull                      # if building from source
tesbo-grid upgrade            # rebuild (or --prebuilt to pull new images) + recreate
```

## Kubernetes

```bash
# bump image.tag in values.generated.yaml, then:
tesbo-grid up --target kubernetes     # helm upgrade --install is idempotent
```

## Notes

- Migrations are forward-only and idempotent (tracked in `_app_api_migrations`).
  Re-running an upgrade is safe.
- Back up your Postgres databases (`tesbo_grid`, `tesbo_execution`) before major
  version bumps.
- Pin `TESBO_IMAGE_TAG` / `image.tag` to a release tag rather than `latest` for
  reproducible deploys.
