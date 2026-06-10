import { runSeleniumProject } from "./seleniumProjectRunner.js";

export async function runSeleniumJavaProject(payload) {
  return runSeleniumProject(payload, "java");
}
