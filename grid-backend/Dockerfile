FROM node:20-slim
WORKDIR /app

COPY package.json package-lock.json* ./
COPY grid-backend/package.json grid-backend/
# grid-backend depends on @tesbox/playwright-runner (file:../grid-shared) for
# the shared test report parsers. Copy the workspace's package.json + sources
# before `npm ci` so the file: link resolves at install time.
COPY grid-shared/package.json grid-shared/
COPY grid-shared/playwrightScriptRunner.js grid-shared/
COPY grid-shared/src/ grid-shared/src/

RUN npm ci --omit=dev --workspace=grid-backend

COPY grid-backend/src/ grid-backend/src/
COPY grid-backend/instrumentation.mjs grid-backend/

EXPOSE 7100
# Apply pending DB migrations on every container start before the API boots.
# Mirrors the grid-runner-api pattern. Migrations are idempotent (CREATE TABLE
# IF NOT EXISTS / ADD COLUMN IF NOT EXISTS) and are tracked in
# `_app_api_migrations`, so this is safe to run every boot. If a migration
# fails the container exits and the API never starts on a partial schema —
# that's intentional: it's better than silently 500-ing on read endpoints.
CMD ["sh", "-c", "node grid-backend/src/db/migrate.js && node --import ./grid-backend/instrumentation.mjs grid-backend/src/index.js"]
