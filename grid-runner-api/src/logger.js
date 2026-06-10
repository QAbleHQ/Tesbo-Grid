export function logInfo(event, data = {}) {
  const entry = { level: "info", event, ...data, ts: new Date().toISOString() };
  process.stdout.write(JSON.stringify(entry) + "\n");
}

export function logError(event, data = {}) {
  const entry = { level: "error", event, ...data, ts: new Date().toISOString() };
  process.stderr.write(JSON.stringify(entry) + "\n");
}
