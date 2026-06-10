/**
 * Standalone Playwright script execution (one browser per run).
 * Canonical shared module used by TesboGrid workers.
 * Also mirrored (self-contained) in TesboX's Automation-Agents and Test-Runner-Agents.
 *
 * Accepts a `runtimeConfig` object so callers can inject their own config
 * without coupling to a specific config module.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const DEFAULTS = {
  screenshotDir: "./artifacts/screenshots",
  videoDir: "./artifacts/videos",
  traceDir: "./artifacts/traces",
  headless: true,
  recordVideo: true,
  startUrlTimeoutMs: 60000,
};

function cfg(runtimeConfig, key) {
  if (runtimeConfig && runtimeConfig[key] != null) return runtimeConfig[key];
  return DEFAULTS[key];
}

export async function ensureScreenshotDir(runtimeConfig) {
  await fs.mkdir(cfg(runtimeConfig, "screenshotDir"), { recursive: true });
}

export async function ensureVideoDir(runtimeConfig) {
  if (!cfg(runtimeConfig, "recordVideo")) return;
  await fs.mkdir(cfg(runtimeConfig, "videoDir"), { recursive: true });
}

export async function ensureTraceDir(runtimeConfig) {
  await fs.mkdir(cfg(runtimeConfig, "traceDir"), { recursive: true });
}

export async function navigateToStartUrl(page, startUrl, runtimeConfig) {
  const timeoutMs = Math.max(5000, Number(cfg(runtimeConfig, "startUrlTimeoutMs") || 60000));
  try {
    await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    return;
  } catch {
    await page.goto(startUrl, { waitUntil: "load", timeout: timeoutMs });
  }
}

export async function takeStandaloneScreenshot(page, id, runtimeConfig) {
  const fileName = `${id}-${Date.now()}.png`;
  const outputPath = path.join(cfg(runtimeConfig, "screenshotDir"), fileName);
  await page.screenshot({ path: outputPath, fullPage: true });
  return outputPath;
}

export function createExpect(page, recordStep) {
  return function expect(actual) {
    const meta = actual && typeof actual === "object" ? actual.__meta || {} : {};
    return {
      async toBeVisible() {
        await recordStep("assert_visible", { selector: meta.selector || null }, async () => {
          await actual.waitFor({ state: "visible", timeout: 15000 });
        });
      },
      async toContainText(expectedText) {
        await recordStep(
          "assert_text",
          { selector: meta.selector || null, expectedText: String(expectedText || "") },
          async () => {
            const actualText = await actual.innerText({ timeout: 15000 });
            if (!String(actualText || "").toLowerCase().includes(String(expectedText || "").toLowerCase())) {
              throw new Error(`Expected text to contain "${expectedText}", but got "${actualText}"`);
            }
          }
        );
      },
      async toBeEnabled() {
        await recordStep("assert_clickable", { selector: meta.selector || null }, async () => {
          const enabled = await actual.isEnabled({ timeout: 15000 });
          if (!enabled) throw new Error("Expected element to be enabled");
        });
      },
      async toHaveURL(expected) {
        await recordStep("assert_url", { expected: String(expected) }, async () => {
          const current = page.url();
          if (expected instanceof RegExp) {
            if (!expected.test(current)) {
              throw new Error(`Expected URL ${expected}, got ${current}`);
            }
            return;
          }
          const expectedString = String(expected || "");
          if (current !== expectedString) {
            throw new Error(`Expected URL "${expectedString}", got "${current}"`);
          }
        });
      },
      async toBeTruthy() {
        await recordStep("assert_truthy", {}, async () => {
          if (!actual) throw new Error(`Expected value to be truthy, but got ${JSON.stringify(actual)}`);
        });
      },
      async toBeFalsy() {
        await recordStep("assert_falsy", {}, async () => {
          if (actual) throw new Error(`Expected value to be falsy, but got ${JSON.stringify(actual)}`);
        });
      },
      async toBe(expected) {
        await recordStep("assert_equal", { expected }, async () => {
          if (actual !== expected) throw new Error(`Expected ${JSON.stringify(expected)}, but got ${JSON.stringify(actual)}`);
        });
      },
      async toEqual(expected) {
        await recordStep("assert_deep_equal", { expected }, async () => {
          if (JSON.stringify(actual) !== JSON.stringify(expected)) {
            throw new Error(`Expected deep equal ${JSON.stringify(expected)}, but got ${JSON.stringify(actual)}`);
          }
        });
      },
      async toHaveCount(expected) {
        await recordStep("assert_count", { selector: meta.selector || null, expected }, async () => {
          const count = await actual.count();
          if (count !== expected) throw new Error(`Expected count ${expected}, but got ${count}`);
        });
      },
      async toHaveText(expected) {
        await recordStep("assert_text_exact", { selector: meta.selector || null, expected: String(expected || "") }, async () => {
          const actualText = await actual.innerText({ timeout: 15000 });
          if (String(actualText || "").trim() !== String(expected || "").trim()) {
            throw new Error(`Expected text "${expected}", but got "${actualText}"`);
          }
        });
      },
      async toHaveValue(expected) {
        await recordStep("assert_value", { selector: meta.selector || null, expected: String(expected || "") }, async () => {
          const val = await actual.inputValue({ timeout: 15000 });
          if (val !== expected) throw new Error(`Expected value "${expected}", but got "${val}"`);
        });
      },
      async toBeHidden() {
        await recordStep("assert_hidden", { selector: meta.selector || null }, async () => {
          await actual.waitFor({ state: "hidden", timeout: 15000 });
        });
      },
      not: {
        async toBeVisible() {
          await recordStep("assert_not_visible", { selector: meta.selector || null }, async () => {
            await actual.waitFor({ state: "hidden", timeout: 15000 });
          });
        },
        async toBeTruthy() {
          await recordStep("assert_not_truthy", {}, async () => {
            if (actual) throw new Error(`Expected value NOT to be truthy, but got ${JSON.stringify(actual)}`);
          });
        },
        async toBeFalsy() {
          await recordStep("assert_not_falsy", {}, async () => {
            if (!actual) throw new Error(`Expected value NOT to be falsy`);
          });
        },
        async toBe(expected) {
          await recordStep("assert_not_equal", { expected }, async () => {
            if (actual === expected) throw new Error(`Expected NOT ${JSON.stringify(expected)}`);
          });
        },
        async toContainText(expectedText) {
          await recordStep("assert_not_text", { selector: meta.selector || null, expectedText: String(expectedText || "") }, async () => {
            const actualText = await actual.innerText({ timeout: 15000 });
            if (String(actualText || "").toLowerCase().includes(String(expectedText || "").toLowerCase())) {
              throw new Error(`Expected text NOT to contain "${expectedText}", but got "${actualText}"`);
            }
          });
        },
      },
    };
  };
}

function createLocatorWrapper(locator, selector, recordStep) {
  const wrapped = {
    __meta: { selector },
    first() {
      return createLocatorWrapper(locator.first(), selector, recordStep);
    },
    async click(options) {
      return recordStep("click", { selector }, async () => locator.click(options));
    },
    async fill(value, options) {
      return recordStep("type", { selector, value }, async () => locator.fill(value, options));
    },
    waitFor(options) {
      return locator.waitFor(options);
    },
    innerText(options) {
      return locator.innerText(options);
    },
    isEnabled(options) {
      return locator.isEnabled(options);
    },
  };
  return wrapped;
}

export function createInstrumentedPage(page, recordStep) {
  const keyboard = {
    async press(key, options) {
      return recordStep("press", { key: String(key || "") }, async () => page.keyboard.press(key, options));
    },
    async type(text, options) {
      return recordStep("type", { selector: "activeElement", value: String(text || "") }, async () =>
        page.keyboard.type(text, options)
      );
    },
  };
  const mouse = {
    async click(x, y, options) {
      return recordStep("mouse_click", { x, y }, async () => page.mouse.click(x, y, options));
    },
    async move(x, y, options) {
      return recordStep("mouse_move", { x, y }, async () => page.mouse.move(x, y, options));
    },
    async down(options) {
      return recordStep("mouse_down", {}, async () => page.mouse.down(options));
    },
    async up(options) {
      return recordStep("mouse_up", {}, async () => page.mouse.up(options));
    },
    async wheel(deltaX, deltaY) {
      return recordStep("scroll", { deltaX, deltaY }, async () => page.mouse.wheel(deltaX, deltaY));
    },
  };
  return new Proxy(page, {
    get(target, prop) {
      if (prop === "goto") {
        return async (url, options) =>
          recordStep("navigate", { url: String(url || "") }, async () => target.goto(url, options));
      }
      if (prop === "locator") {
        return (selector) => createLocatorWrapper(target.locator(selector), String(selector || ""), recordStep);
      }
      if (prop === "getByText") {
        return (text, options) =>
          createLocatorWrapper(target.getByText(text, options), `text=${String(text || "")}`, recordStep);
      }
      if (prop === "keyboard") return keyboard;
      if (prop === "mouse") return mouse;
      const value = target[prop];
      if (typeof value === "function") return value.bind(target);
      return value;
    },
  });
}

export function createTestStub(recordStep) {
  const stub = function test() {};
  stub.step = async function step(title, fn) {
    return recordStep("test.step", { title: String(title || "") }, fn);
  };
  stub.describe = function describe(_title, fn) {
    if (typeof fn === "function") fn();
  };
  stub.describe.serial = stub.describe;
  stub.describe.parallel = stub.describe;
  stub.describe.configure = () => {};
  stub.beforeEach = async function beforeEach(fn) {
    if (typeof fn === "function") await fn();
  };
  stub.afterEach = async function afterEach(fn) {
    if (typeof fn === "function") await fn();
  };
  stub.beforeAll = async function beforeAll(fn) {
    if (typeof fn === "function") await fn();
  };
  stub.afterAll = async function afterAll(fn) {
    if (typeof fn === "function") await fn();
  };
  stub.skip = () => {};
  stub.fixme = () => {};
  stub.fail = () => {};
  stub.slow = () => {};
  stub.only = stub;
  stub.info = () => ({ annotations: [], title: "", tags: [] });
  stub.use = () => {};
  return stub;
}

export function extractPlaywrightTestBody(script) {
  const source = String(script || "");
  const asyncTestIdx = source.search(/test\s*\([\s\S]*?async\s*\(\s*\{[^}]*\bpage\b[^}]*\}\s*\)\s*=>\s*\{/m);
  if (asyncTestIdx < 0) {
    const hasImports = /^\s*import\s+/m.test(source);
    const hasFixtureUsage = /\btest\.beforeEach\s*\(|\btest\.describe\s*\(/m.test(source);
    if (hasImports || hasFixtureUsage) {
      throw new Error(
        "Unsupported Playwright file for cloud execution: this runner supports a single self-contained test body only. " +
        "Files that rely on imports/fixtures/test.describe/beforeEach must be converted to inline script steps or executed with a full project runner."
      );
    }
    throw new Error("Unsupported script format: expected Playwright test('name', async ({ page }) => { ... })");
  }
  const arrowIdx = source.indexOf("=>", asyncTestIdx);
  if (arrowIdx < 0) throw new Error("Invalid script format: missing async test arrow");
  const braceStart = source.indexOf("{", arrowIdx);
  if (braceStart < 0) throw new Error("Invalid script format: missing test body");
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let escaped = false;
  for (let i = braceStart; i < source.length; i += 1) {
    const ch = source[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (!inDouble && !inTemplate && ch === "'") inSingle = !inSingle;
    else if (!inSingle && !inTemplate && ch === '"') inDouble = !inDouble;
    else if (!inSingle && !inDouble && ch === "`") inTemplate = !inTemplate;
    if (inSingle || inDouble || inTemplate) continue;
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(braceStart + 1, i);
      }
    }
  }
  throw new Error("Invalid script format: unterminated test body");
}

/**
 * Run a Playwright script in an isolated browser.
 * @param {string} executionId - Unique identifier for this execution
 * @param {string} script - Playwright test script source
 * @param {string|null} startUrl - Optional URL to navigate to first
 * @param {object} runtimeConfig - Config object with screenshotDir, videoDir, traceDir, headless, recordVideo, startUrlTimeoutMs
 * @returns {Promise<{status, currentUrl, logs, screenshotPath, videoPath, tracePath, errorMessage, durationMs}>}
 */
export async function runPlaywrightScript(executionId, script, startUrl = null, runtimeConfig = {}) {
  await ensureScreenshotDir(runtimeConfig);
  await ensureVideoDir(runtimeConfig);
  await ensureTraceDir(runtimeConfig);
  const startedAt = Date.now();
  const logs = [];
  const browser = await chromium.launch({ headless: cfg(runtimeConfig, "headless") });
  const contextOptions = {
    viewport: { width: 1366, height: 768 },
  };
  if (cfg(runtimeConfig, "recordVideo")) {
    contextOptions.recordVideo = {
      dir: cfg(runtimeConfig, "videoDir"),
      size: { width: 1366, height: 768 },
    };
  }
  const context = await browser.newContext(contextOptions);
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true }).catch(() => {});
  const page = await context.newPage();
  page.on("console", (msg) => {
    logs.push({
      level: msg.type(),
      message: msg.text(),
      ts: new Date().toISOString(),
    });
  });
  page.on("pageerror", (err) => {
    logs.push({
      level: "pageerror",
      message: err?.message || "Unknown page error",
      ts: new Date().toISOString(),
    });
  });
  page.on("requestfailed", (req) => {
    logs.push({
      level: "requestfailed",
      message: `${req.method()} ${req.url()} => ${req.failure()?.errorText || "failed"}`,
      ts: new Date().toISOString(),
    });
  });

  const video = page.video();
  let status = "passed";
  let errorMessage = null;
  let screenshotPath = null;
  let videoPath = null;
  let tracePath = null;
  let currentUrl = "";
  let stepCounter = 0;
  const recordStep = async (action, detail, fn) => {
    const started = Date.now();
    const stepId = `step-${++stepCounter}`;
    try {
      const result = await fn();
      const stepScreenshotPath = await takeStandaloneScreenshot(page, `${executionId}-${stepId}`, runtimeConfig).catch(() => null);
      logs.push({
        kind: "step",
        stepId,
        action,
        status: "passed",
        detail: detail || {},
        screenshotPath: stepScreenshotPath,
        durationMs: Date.now() - started,
        ts: new Date().toISOString(),
      });
      return result;
    } catch (err) {
      const stepScreenshotPath = await takeStandaloneScreenshot(page, `${executionId}-${stepId}`, runtimeConfig).catch(() => null);
      const message = err instanceof Error ? err.message : String(err);
      logs.push({
        kind: "step",
        stepId,
        action,
        status: "failed",
        detail: detail || {},
        message,
        screenshotPath: stepScreenshotPath,
        durationMs: Date.now() - started,
        ts: new Date().toISOString(),
      });
      throw err;
    }
  };
  try {
    if (startUrl) {
      await navigateToStartUrl(page, startUrl, runtimeConfig);
    }
    const body = extractPlaywrightTestBody(script);
    const AsyncFunction = Object.getPrototypeOf(async function noop() {}).constructor;
    const fn = new AsyncFunction("page", "expect", "test", body);
    const instrumentedPage = createInstrumentedPage(page, recordStep);
    const expect = createExpect(page, recordStep);
    const testStub = createTestStub(recordStep);
    await fn(instrumentedPage, expect, testStub);
    currentUrl = page.url();
    screenshotPath = await takeStandaloneScreenshot(page, executionId, runtimeConfig);
  } catch (err) {
    status = "failed";
    errorMessage = err instanceof Error ? err.message : String(err);
    currentUrl = page.url();
    screenshotPath = await takeStandaloneScreenshot(page, executionId, runtimeConfig).catch(() => null);
    logs.push({
      level: "error",
      message: errorMessage,
      ts: new Date().toISOString(),
    });
  } finally {
    await page.close().catch(() => {});
    if (video) {
      videoPath = await video.path().catch(() => null);
    }
    tracePath = path.join(cfg(runtimeConfig, "traceDir"), `${executionId}-${Date.now()}.zip`);
    await context.tracing.stop({ path: tracePath }).catch(() => {
      tracePath = null;
    });
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  return {
    status,
    currentUrl,
    logs,
    screenshotPath,
    videoPath,
    tracePath,
    errorMessage,
    durationMs: Date.now() - startedAt,
  };
}
