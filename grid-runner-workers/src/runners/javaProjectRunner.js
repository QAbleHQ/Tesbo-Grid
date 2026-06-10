import { runPlaywrightProjectWithRuntime } from "../projectRunner.js";

export async function runJavaPlaywrightProject(payload) {
  return runPlaywrightProjectWithRuntime(payload, "java");
}
