export function logInfo(event, data = {}) {
  const entry = { level: "info", event, service: "selenium-proxy", ...data, ts: new Date().toISOString() };
  process.stdout.write(JSON.stringify(entry) + "\n");
}

export function logError(event, data = {}) {
  const entry = { level: "error", event, service: "selenium-proxy", ...data, ts: new Date().toISOString() };
  process.stderr.write(JSON.stringify(entry) + "\n");
}

export function logWarn(event, data = {}) {
  const entry = { level: "warn", event, service: "selenium-proxy", ...data, ts: new Date().toISOString() };
  process.stderr.write(JSON.stringify(entry) + "\n");
}
