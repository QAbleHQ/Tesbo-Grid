FROM node:20-slim
WORKDIR /app

COPY package.json package-lock.json ./
COPY grid-selenium-proxy/package.json grid-selenium-proxy/
COPY grid-shared/package.json grid-shared/
COPY grid-shared/playwrightScriptRunner.js grid-shared/
COPY grid-shared/src/ grid-shared/src/

RUN npm ci --omit=dev --ignore-scripts --workspace=grid-selenium-proxy

COPY grid-selenium-proxy/src/ grid-selenium-proxy/src/

RUN chown -R node:node /app
USER node

EXPOSE 7430
CMD ["node", "grid-selenium-proxy/src/index.js"]
