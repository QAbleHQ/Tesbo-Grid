FROM node:20-slim
WORKDIR /app

COPY package.json package-lock.json ./
COPY grid-runner-api/package.json grid-runner-api/
COPY grid-shared/package.json grid-shared/
COPY grid-shared/playwrightScriptRunner.js grid-shared/
COPY grid-shared/src/ grid-shared/src/

RUN npm ci --omit=dev --ignore-scripts --workspace=grid-runner-api

COPY grid-runner-api/src/ grid-runner-api/src/
COPY grid-runner-api/instrumentation.mjs grid-runner-api/

RUN chown -R node:node /app
USER node

EXPOSE 7420
CMD ["node", "--import", "./grid-runner-api/instrumentation.mjs", "grid-runner-api/src/index.js"]
