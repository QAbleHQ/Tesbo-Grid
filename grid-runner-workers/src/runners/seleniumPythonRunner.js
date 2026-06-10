import { runSeleniumProject } from "./seleniumProjectRunner.js";

export async function runSeleniumPythonProject(payload) {
  return runSeleniumProject(payload, "python");
}
