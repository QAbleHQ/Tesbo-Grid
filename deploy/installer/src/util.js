// Small zero-dependency helpers for the tesbo-grid operator CLI.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

export function info(msg) {
  process.stdout.write(`${msg}\n`);
}
export function step(msg) {
  process.stdout.write(`${C.cyan}▸${C.reset} ${msg}\n`);
}
export function ok(msg) {
  process.stdout.write(`${C.green}✓${C.reset} ${msg}\n`);
}
export function warn(msg) {
  process.stdout.write(`${C.yellow}!${C.reset} ${msg}\n`);
}
export function fail(msg) {
  process.stderr.write(`${C.red}✗ ${msg}${C.reset}\n`);
}
export function heading(msg) {
  process.stdout.write(`\n${C.bold}${msg}${C.reset}\n`);
}

// Generate a strong random hex secret (default 32 bytes → 64 hex chars).
export function randomSecret(bytes = 32) {
  return crypto.randomBytes(bytes).toString("hex");
}

// Locate the repo root by walking up from a start dir until docker-compose.yml
// is found. Falls back to the installer package's repo root.
export function findRepoRoot(startDir = process.cwd()) {
  let dir = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(dir, "docker-compose.yml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: installer lives at <repo>/deploy/installer/src/util.js
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "..");
}

// Run a command, inheriting stdio. Resolves with exit code (never rejects).
export function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: "inherit", ...opts });
    child.on("error", (err) => {
      fail(`Failed to launch ${cmd}: ${err.message}`);
      resolve(127);
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

// Run a command capturing stdout; resolves { code, out }. Never rejects.
export function capture(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let out = "";
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"], ...opts });
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("error", () => resolve({ code: 127, out: "" }));
    child.on("close", (code) => resolve({ code: code ?? 1, out }));
  });
}

export async function commandExists(cmd) {
  const probe = process.platform === "win32" ? "where" : "which";
  const { code } = await capture(probe, [cmd]);
  return code === 0;
}

// Minimal interactive prompt helpers built on node:readline.
function makeRl() {
  return readline.createInterface({ input: process.stdin, output: process.stdout });
}

export async function ask(question, fallback = "") {
  const rl = makeRl();
  const suffix = fallback ? ` ${C.dim}(${fallback})${C.reset}` : "";
  const answer = await new Promise((resolve) =>
    rl.question(`${question}${suffix}: `, resolve)
  );
  rl.close();
  const trimmed = answer.trim();
  return trimmed || fallback;
}

export async function choose(question, options, fallbackIndex = 0) {
  info(`\n${question}`);
  options.forEach((opt, i) => info(`  ${i + 1}) ${opt.label}`));
  const def = String(fallbackIndex + 1);
  const raw = await ask("Choose", def);
  const idx = Number.parseInt(raw, 10) - 1;
  return options[Number.isInteger(idx) && options[idx] ? idx : fallbackIndex].value;
}

export async function confirm(question, fallback = true) {
  const def = fallback ? "Y/n" : "y/N";
  const raw = (await ask(`${question} [${def}]`, "")).toLowerCase();
  if (!raw) return fallback;
  return raw === "y" || raw === "yes";
}

export { C };
