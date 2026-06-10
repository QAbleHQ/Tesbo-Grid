import { runPlaywrightProjectWithRuntime } from "../projectRunner.js";

export async function runPythonPlaywrightProject(payload) {
  return runPlaywrightProjectWithRuntime(payload, "python");
}
