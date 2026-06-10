// `tesbo-grid doctor` — preflight checks for the chosen deploy target.
import net from "node:net";
import { commandExists, capture, heading, ok, warn, fail, info } from "./util.js";

function flagVal(argv, name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
}

function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

export async function doctor(argv) {
  const target = flagVal(argv, "target", "compose");
  heading(`Preflight checks (${target})`);
  let problems = 0;

  if (target === "compose") {
    if (await commandExists("docker")) {
      ok("docker found");
      const { code, out } = await capture("docker", ["compose", "version"]);
      if (code === 0) ok(`docker compose: ${out.trim().split("\n")[0]}`);
      else { fail("`docker compose` not available (need Compose v2)"); problems += 1; }
      const ping = await capture("docker", ["info"]);
      if (ping.code === 0) ok("docker daemon reachable");
      else { fail("docker daemon not reachable — is Docker running?"); problems += 1; }
    } else {
      fail("docker not found — install Docker Engine + Compose v2");
      problems += 1;
    }
    for (const port of [3100, 7100, 7420, 7430, 4444, 5433, 6380]) {
      const free = await portFree(port);
      if (free) ok(`port ${port} free`);
      else warn(`port ${port} is in use (a previous stack may already be running)`);
    }
  } else {
    for (const tool of ["kubectl", "helm"]) {
      if (await commandExists(tool)) ok(`${tool} found`);
      else { fail(`${tool} not found`); problems += 1; }
    }
    const ctx = await capture("kubectl", ["config", "current-context"]);
    if (ctx.code === 0) ok(`kube context: ${ctx.out.trim()}`);
    else { fail("no kube context — configure kubectl for your cluster"); problems += 1; }
    const nodes = await capture("kubectl", ["get", "nodes", "--no-headers"]);
    if (nodes.code === 0) ok(`cluster reachable (${nodes.out.trim().split("\n").filter(Boolean).length} node(s))`);
    else { fail("cluster not reachable"); problems += 1; }
  }

  if (problems === 0) { info("\nAll checks passed."); return 0; }
  fail(`\n${problems} problem(s) found. Resolve them before \`tesbo-grid up\`.`);
  return 1;
}
