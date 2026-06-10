import test from "node:test";
import assert from "node:assert/strict";
import { generateWorkflowYaml } from "./workflowGenerator.js";

const baseArgs = {
  schedule: { id: "abcd1234", name: "Nightly" },
  suites: [],
  runAllTests: true,
  apiBaseUrl: "https://run.example.com",
  projectId: "proj-1",
  framework: "playwright",
  language: "javascript",
  browser: "",
};

function runStepLine(yaml) {
  // The line beginning the `npx -y @tesbox/cli run` invocation.
  return yaml.split("\n").find((l) => l.includes("@tesbox/cli run")) || "";
}

test("generateWorkflowYaml omits --env-from when no environment is given", () => {
  const yaml = generateWorkflowYaml(baseArgs);
  assert.ok(runStepLine(yaml).includes("@tesbox/cli run"));
  assert.ok(!yaml.includes("--env-from"), "should not emit --env-from without an environment");
});

test("generateWorkflowYaml emits --env-from with base-url convention names + variable keys", () => {
  const yaml = generateWorkflowYaml({
    ...baseArgs,
    environment: {
      baseUrl: "https://staging.example.com",
      variables: [
        { key: "API_TOKEN", value: "shh", isSecret: true },
        { key: "FEATURE_FLAG", value: "on", isSecret: false },
      ],
    },
  });
  const cmd = runStepLine(yaml);
  assert.ok(
    cmd.includes("--env-from") &&
      cmd.includes("PLAYWRIGHT_BASE_URL,TESBO_BASE_URL,API_TOKEN,FEATURE_FLAG"),
    `run command should forward all env names, got: ${cmd}`,
  );
});

test("generateWorkflowYaml still injects values into the step env: block (secrets by ref, plain inline)", () => {
  const yaml = generateWorkflowYaml({
    ...baseArgs,
    environment: {
      baseUrl: "https://staging.example.com",
      variables: [
        { key: "API_TOKEN", value: "shh", isSecret: true },
        { key: "FEATURE_FLAG", value: "on", isSecret: false },
      ],
    },
  });
  // baseUrl is yamlEscape'd (it contains ':'), so it may be quoted — assert
  // on the key + host rather than an exact unquoted match.
  const envLine = (key) => yaml.split("\n").find((l) => l.trim().startsWith(`${key}:`)) || "";
  assert.ok(envLine("PLAYWRIGHT_BASE_URL").includes("staging.example.com"));
  assert.ok(envLine("TESBO_BASE_URL").includes("staging.example.com"));
  // Secret value must never be inlined; it must be a secrets reference.
  assert.ok(yaml.includes("API_TOKEN: ${{ secrets.API_TOKEN }}"));
  assert.ok(!yaml.includes("API_TOKEN: shh"), "secret value must not be committed to YAML");
  // Non-secret value is inlined.
  assert.ok(envLine("FEATURE_FLAG").includes("on"));
});

test("generateWorkflowYaml de-duplicates and only adds base-url names when baseUrl is set", () => {
  const yaml = generateWorkflowYaml({
    ...baseArgs,
    environment: { variables: [{ key: "ONLY_VAR", value: "1" }] },
  });
  const cmd = runStepLine(yaml);
  assert.ok(cmd.includes("--env-from") && cmd.includes("ONLY_VAR"));
  assert.ok(!cmd.includes("PLAYWRIGHT_BASE_URL"), "no base-url names without baseUrl");
});
