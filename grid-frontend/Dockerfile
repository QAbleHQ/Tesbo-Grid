FROM node:20-slim AS builder
WORKDIR /app

ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
ARG NEXT_PUBLIC_SELENIUM_GRID_DOMAIN
ENV NEXT_PUBLIC_SELENIUM_GRID_DOMAIN=${NEXT_PUBLIC_SELENIUM_GRID_DOMAIN}

COPY package.json package-lock.json ./
COPY grid-shared/package.json grid-shared/
COPY grid-runner-api/package.json grid-runner-api/
COPY grid-runner-workers/package.json grid-runner-workers/
COPY grid-selenium-proxy/package.json grid-selenium-proxy/
COPY grid-backend/package.json grid-backend/
COPY grid-frontend/package.json grid-frontend/

RUN npm ci --workspace=grid-frontend --include-workspace-root

COPY grid-frontend/ grid-frontend/

RUN npm run build --workspace=grid-frontend

FROM node:20-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/package.json ./
COPY --from=builder /app/grid-frontend/package.json grid-frontend/
COPY --from=builder /app/grid-frontend/.next/standalone ./
COPY --from=builder /app/grid-frontend/.next/static grid-frontend/.next/static
COPY --from=builder /app/grid-frontend/public grid-frontend/public

EXPOSE 3100
CMD ["node", "grid-frontend/server.js"]
