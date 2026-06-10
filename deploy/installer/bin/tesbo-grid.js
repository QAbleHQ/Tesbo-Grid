#!/usr/bin/env node
// tesbo-grid — operator CLI to configure and deploy a self-hosted Tesbo-Grid.
// Separate from `@tesbox/cli` (the `tesbox` test-run CLI used by end users).
import { init } from "../src/wizard.js";
import { up, down, upgrade } from "../src/orchestrate.js";
import { doctor } from "../src/doctor.js";
import { info } from "../src/util.js";

const HELP = `
  tesbo-grid — set up and run a self-hosted Tesbo-Grid

  Usage:
    tesbo-grid init       Generate config (.env for Compose, values for Helm)
    tesbo-grid up         Build/pull and start the stack (runs migrations)
    tesbo-grid down       Stop the stack
    tesbo-grid upgrade    Pull/rebuild new images and recreate
    tesbo-grid doctor     Check prerequisites (docker / kubectl / helm, ports)

  Common flags:
    --target compose|kubernetes   Deploy substrate (default: compose)
    --non-interactive             Use defaults/flags only (no prompts)
    --prebuilt                    (compose) use prebuilt images instead of building

  init flags (non-interactive):
    --registry, --image-tag, --frontend-url, --backend-url, --runner-url,
    --grid-domain, --internal-token, --postgres-password,
    --storage-provider, --s3-endpoint, --s3-region, --s3-bucket,
    --s3-access-key, --s3-secret-key
    (kubernetes) --frontend-host, --backend-host, --runner-host,
    --ingress-provider, --database-url, --redis-url, --keda-enabled

  up / down / upgrade flags:
    --release, --namespace, --values   (kubernetes)
    --volumes                          (compose down: also remove volumes)

  Examples:
    tesbo-grid init                              # interactive, Compose
    tesbo-grid up                                # build + start locally
    tesbo-grid init --target kubernetes --non-interactive \\
      --frontend-host grid.acme.com --database-url postgres://...
    tesbo-grid up --target kubernetes --namespace tesbo-grid
`;

const command = process.argv[2];
const rest = process.argv.slice(3);

async function main() {
  switch (command) {
    case "init": return init(rest);
    case "up": return up(rest);
    case "down": return down(rest);
    case "upgrade": return upgrade(rest);
    case "doctor": return doctor(rest);
    case undefined:
    case "-h":
    case "--help":
    case "help":
      info(HELP);
      return 0;
    default:
      info(`Unknown command: ${command}`);
      info(HELP);
      return 1;
  }
}

main().then((code) => process.exit(code ?? 0));
