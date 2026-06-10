/**
 * Playwright script execution — thin adapter over the shared @tesbox/playwright-runner package.
 */
import { config } from "./config.js";
import {
  runPlaywrightScript as sharedRunPlaywrightScript,
  extractPlaywrightTestBody,
  createExpect,
  createInstrumentedPage,
} from "@tesbox/playwright-runner";

function runtimeConfig() {
  return {
    screenshotDir: config.screenshotDir,
    videoDir: config.videoDir,
    traceDir: config.traceDir,
    headless: config.headless,
    recordVideo: config.recordVideo,
    startUrlTimeoutMs: config.startUrlTimeoutMs,
  };
}

export async function runPlaywrightScript(executionId, script, startUrl = null) {
  return sharedRunPlaywrightScript(executionId, script, startUrl, runtimeConfig());
}

export { extractPlaywrightTestBody, createExpect, createInstrumentedPage };
