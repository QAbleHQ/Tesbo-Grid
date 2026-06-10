import { config } from "../config.js";
import { runWithDefaultProvider } from "./defaultProvider.js";

export function resolveExecutionProvider(payload) {
  return String(payload?.executionProvider || "default").trim().toLowerCase();
}

export async function runExecutionWithProvider(payload) {
  const provider = resolveExecutionProvider(payload);
  if (provider === "lambdatest") {
    if (!config.enableLambdaTestProvider) {
      throw new Error("LambdaTest provider is disabled.");
    }
    const { runWithLambdaTestProvider } = await import("./lambdaTestProvider.js");
    return runWithLambdaTestProvider(payload);
  }
  if (provider === "browserstack") {
    if (!config.enableBrowserStackProvider) {
      throw new Error("BrowserStack provider is disabled.");
    }
    const { runWithBrowserStackProvider } = await import("./browserStackProvider.js");
    return runWithBrowserStackProvider(payload);
  }
  return runWithDefaultProvider(payload);
}
