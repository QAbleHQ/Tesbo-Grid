FROM mcr.microsoft.com/playwright:v1.59.0-jammy
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends openjdk-17-jdk maven && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
COPY grid-runner-workers/package.json grid-runner-workers/
COPY grid-shared/package.json grid-shared/
COPY grid-shared/playwrightScriptRunner.js grid-shared/
COPY grid-shared/src/ grid-shared/src/

RUN npm ci --omit=dev --workspace=grid-runner-workers

COPY grid-runner-workers/src/ grid-runner-workers/src/
COPY grid-runner-workers/instrumentation.mjs grid-runner-workers/

EXPOSE 7411
CMD ["node", "--import", "./grid-runner-workers/instrumentation.mjs", "grid-runner-workers/src/index.js"]
