// `tesbo-grid up | down | upgrade` — orchestrates Docker Compose or Helm.
//
// Migrations run automatically inside the backend/execution-api containers on
// start (their entrypoints run db/migrate.js), so `up` just brings the stack
// up and reports health.
import fs from "node:fs";
import path from "node:path";
import { run, findRepoRoot, heading, info, ok, warn, fail, step } from "./util.js";

function flagVal(argv, name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
}
function hasFlag(argv, name) {
  return argv.includes(`--${name}`);
}

function composeFiles(repoRoot, argv) {
  const files = ["-f", path.join(repoRoot, "docker-compose.yml")];
  // Use prebuilt images when --prebuilt is passed or no source build is wanted.
  if (hasFlag(argv, "prebuilt")) {
    files.push("-f", path.join(repoRoot, "docker-compose.images.yml"));
  }
  return files;
}

function helmArgs(repoRoot, argv) {
  const release = flagVal(argv, "release", "tesbo-grid");
  const namespace = flagVal(argv, "namespace", "tesbo-grid");
  const chart = path.join(repoRoot, "deploy", "helm", "tesbo-grid");
  const values = flagVal(argv, "values", path.join(repoRoot, "values.generated.yaml"));
  return { release, namespace, chart, values };
}

export async function up(argv) {
  const repoRoot = findRepoRoot();
  const target = flagVal(argv, "target", "compose");
  heading(`Starting Tesbo-Grid (${target})`);

  if (target === "kubernetes") {
    const { release, namespace, chart, values } = helmArgs(repoRoot, argv);
    if (!fs.existsSync(values)) {
      fail(`Values file not found: ${values}. Run \`tesbo-grid init --target kubernetes\` first.`);
      return 1;
    }
    step(`helm upgrade --install ${release} (ns: ${namespace})`);
    return run("helm", [
      "upgrade", "--install", release, chart,
      "--namespace", namespace, "--create-namespace",
      "-f", values, "--wait", "--timeout", "10m",
    ]);
  }

  const envPath = path.join(repoRoot, ".env");
  if (!fs.existsSync(envPath)) {
    fail(`No .env found at ${envPath}. Run \`tesbo-grid init\` first.`);
    return 1;
  }
  const files = composeFiles(repoRoot, argv);
  if (hasFlag(argv, "prebuilt")) {
    step("Pulling prebuilt images");
    const pullCode = await run("docker", ["compose", ...files, "pull"]);
    if (pullCode !== 0) warn("Image pull reported issues; continuing.");
  }
  step("docker compose up -d");
  const code = await run("docker", ["compose", ...files, "up", "-d", ...(hasFlag(argv, "prebuilt") ? [] : ["--build"])]);
  if (code === 0) {
    ok("Stack is up. Dashboard: check FRONTEND_URL from your .env (default http://localhost:3100).");
  }
  return code;
}

export async function down(argv) {
  const repoRoot = findRepoRoot();
  const target = flagVal(argv, "target", "compose");
  heading(`Stopping Tesbo-Grid (${target})`);
  if (target === "kubernetes") {
    const { release, namespace } = helmArgs(repoRoot, argv);
    return run("helm", ["uninstall", release, "--namespace", namespace]);
  }
  const args = ["compose", ...composeFiles(repoRoot, argv), "down"];
  if (hasFlag(argv, "volumes")) args.push("-v");
  return run("docker", args);
}

export async function upgrade(argv) {
  const repoRoot = findRepoRoot();
  const target = flagVal(argv, "target", "compose");
  heading(`Upgrading Tesbo-Grid (${target})`);
  if (target === "kubernetes") {
    return up(argv); // helm upgrade --install is idempotent
  }
  const files = composeFiles(repoRoot, argv);
  if (hasFlag(argv, "prebuilt")) {
    step("Pulling latest images");
    await run("docker", ["compose", ...files, "pull"]);
  } else {
    step("Rebuilding images");
    await run("docker", ["compose", ...files, "build"]);
  }
  step("Recreating containers");
  return run("docker", ["compose", ...files, "up", "-d"]);
}
