---
name: test-gen
description: Write new unit tests and update existing ones for code changes in this repo. Invoked as `/test-gen [optional file or directory path]`. Detects the workspace (backend → node:test, frontend → vitest), generates/updates co-located `*.test.js`/`*.test.ts` files matching project conventions, then runs the tests and iterates until they pass.
---

# test-gen

Generates and updates unit tests for changed code in the Tesbo-Grid monorepo, matching the testing conventions already in use.

## When to use

Invoke when the user runs `/test-gen` — optionally with a path argument:

- `/test-gen` → scope to all uncommitted changes (`git status --porcelain` + `git diff --name-only HEAD`).
- `/test-gen path/to/file.js` → scope to a single source file.
- `/test-gen path/to/dir` → scope to all source files under that directory.

## Workspace conventions (must match exactly)

### Backend workspaces — `grid-backend`, `grid-runner-api`, `grid-runner-workers`, `grid-selenium-proxy`, `grid-shared`

- Runner: Node's built-in test runner (`node --test`). Test files are picked up via `npm test` per-workspace.
- File naming: `foo.js` → sibling `foo.test.js` in the same directory.
- Style: flat `test("name", () => {...})` calls. **Do not use `describe` for backend tests.**
- Imports:
  ```js
  import test from "node:test";
  import assert from "node:assert/strict";
  ```
- Use `assert.equal`, `assert.deepEqual`, `assert.ok`, `assert.throws`, `assert.rejects`. Don't pull in chai/jest matchers.
- ESM only (`"type": "module"`). Import paths must include the `.js` extension.

Reference example: [grid-backend/src/services/ai/rootCauseClusterer.test.js](grid-backend/src/services/ai/rootCauseClusterer.test.js).

### Frontend workspace — `grid-frontend`

- Runner: Vitest (`vitest run` via `npm test`).
- File naming: `utils.ts` → sibling `utils.test.ts`. For `.tsx` components, use `.test.tsx`.
- Style: `describe` + `it` blocks.
- Imports:
  ```ts
  import { describe, it, expect } from "vitest";
  ```

Reference example: [grid-frontend/lib/utils.test.ts](grid-frontend/lib/utils.test.ts).

## Files to skip

Don't generate tests for these — they exist but unit tests are the wrong tool:

- Anything under `migrations/`, `scripts/`, `infra/`, `deploy/`, `node_modules/`
- Entrypoints: `src/index.js`, `instrumentation.mjs`
- Config files: `*.config.{js,ts,mjs}`, `Dockerfile`, `*.yml`, `*.json`
- Pure type declarations (`*.d.ts`)
- Files that are already tests (`*.test.{js,ts,tsx}`)
- Express route wiring (`src/routes/*.js`) when they are thin pass-throughs to a service — test the service instead. If the route file contains real logic (validation, transformation, error mapping), do test it.

If a changed file is unsuitable for unit testing (e.g., it's just a SQL migration or a CLI shim), report that and skip — don't fabricate tests.

## Procedure

1. **Resolve scope.** Build the list of changed source files:
   - With a path arg: walk the path, filter to source files in a known workspace.
   - Without an arg: run `git status --porcelain` and `git diff --name-only HEAD` (parallel), union them, drop deletions, drop files in the skip list.

2. **For each target file, plan tests.** Read the file in full. Identify:
   - Every exported symbol (functions, classes, constants used externally).
   - Pure functions vs. side-effecting code. Prefer testing pure logic first.
   - Branches, edge cases, normalization rules, error paths.
   - For changed-but-existing test files: diff the source's exports against what the existing test covers; add/update tests for new or changed exports only. Don't rewrite passing tests.

3. **Write tests.**
   - Co-locate the test file next to source.
   - Match the workspace's style exactly (see above).
   - One assertion concept per test case; descriptive names.
   - Do not mock things the project doesn't already mock. Backend tests in this repo exercise real pure functions — follow that pattern. If a function has a DB dependency, test the pure helpers around it rather than mocking `pg`.
   - Do not add comments inside tests unless the assertion's intent is non-obvious.

4. **Run the tests.**
   - Backend file `<workspace>/src/foo/bar.test.js`:
     ```bash
     npm test --workspace=<workspace> -- --test-name-pattern='<...>' 2>&1 | tail -80
     ```
     Or, for a single file: `node --test <workspace>/src/foo/bar.test.js`.
   - Frontend: `npm test --workspace=grid-frontend -- <relative-path>`.

5. **Iterate on failures.** If a test fails:
   - First, read the failure carefully — is the test wrong, or did it surface a real bug in the source?
   - If the test is wrong (bad expectation, wrong import, wrong path): fix the test.
   - If it looks like a real bug: **stop and report to the user**. Do not silently change the source code to make tests pass.

6. **Report.** End with a tight summary:
   - Files written/updated (clickable links).
   - Test counts (added / updated / passed / failed).
   - Any files skipped and why.
   - Any suspected source bugs surfaced by new tests.

## Hard rules

- **Never modify source files to make tests pass.** If a test reveals a bug, surface it.
- **Never use `--no-verify`, skip hooks, or bypass `npm test` checks.**
- **Never commit.** This skill writes test files and runs them. Committing is the user's call.
- **Don't add new test dependencies.** Use what's already in each workspace's `package.json`.
- **Don't introduce a new test framework or runner config** (no jest, no mocha, no ava). If a workspace has no test script yet, report that and stop — adding test infra is a separate decision.
- **Don't write integration/e2e tests** under this skill. Unit-level only. If a change clearly needs an integration test (e.g., a new HTTP endpoint), note it in the report but don't author it here.
