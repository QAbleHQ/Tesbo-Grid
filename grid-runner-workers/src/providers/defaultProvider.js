import { runPlaywrightScript } from "../playwrightScriptRunner.js";
import { runPlaywrightProject } from "../projectRunner.js";
import { runPythonPlaywrightProject } from "../runners/pythonProjectRunner.js";
import { runJavaPlaywrightProject } from "../runners/javaProjectRunner.js";
import { runSeleniumPythonProject } from "../runners/seleniumPythonRunner.js";
import { runSeleniumJavaProject } from "../runners/seleniumJavaRunner.js";
import { normalizeRuntime } from "../runtimeContract.js";
import { config } from "../config.js";

export async function runWithDefaultProvider(payload) {
  const runtime = normalizeRuntime(payload);
  if (!config.supportedFrameworks.includes(runtime.framework)) {
    throw new Error(`Runtime framework ${runtime.framework} is not enabled on this worker`);
  }
  if (!config.supportedLanguages.includes(runtime.language)) {
    throw new Error(`Runtime language ${runtime.language} is not enabled on this worker`);
  }

  if (runtime.framework === "selenium") {
    if (runtime.language === "python") {
      return runSeleniumPythonProject(payload);
    }
    if (runtime.language === "java") {
      return runSeleniumJavaProject(payload);
    }
    throw new Error(`Unsupported selenium runtime language: ${runtime.language}`);
  }

  if (runtime.executionMode === "project" && (runtime.language === "javascript" || runtime.language === "typescript")) {
    return runPlaywrightProject(payload);
  }
  if (runtime.executionMode === "project" && runtime.language === "python") {
    return runPythonPlaywrightProject(payload);
  }
  if (runtime.executionMode === "project" && runtime.language === "java") {
    return runJavaPlaywrightProject(payload);
  }
  if (runtime.executionMode === "project") {
    throw new Error(`Unsupported runtime language in project mode: ${runtime.language}`);
  }
  if (runtime.language !== "javascript" && runtime.language !== "typescript") {
    throw new Error(`${runtime.language} supports project mode only`);
  }
  return runPlaywrightScript(
    String(payload.externalRef || payload.executionId || payload.jobId || ""),
    String(payload.script || ""),
    typeof payload.startUrl === "string" ? payload.startUrl : null
  );
}
