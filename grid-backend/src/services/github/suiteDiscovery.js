import { query } from "../../db/database.js";
import { logger } from "../../logger.js";
import { getRepoTree } from "./client.js";

const TEST_FILE_RE = /\.(spec|test)\.(ts|tsx|js|jsx|mjs|cjs|py|java)$/;

export const RUN_ALL_GLOB = "**/*.{spec,test}.{ts,tsx,js,jsx,mjs,cjs,py,java}";

export async function discoverSuitesForIntegration({ integrationId, installationId, testRepoFullName, repoRef }) {
  const { sha, tree } = await getRepoTree(installationId, testRepoFullName, repoRef);
  if (!sha) {
    logger.warn(`Suite discovery: ref ${repoRef} not found on ${testRepoFullName}`);
    return [];
  }

  const blobs = tree.filter((t) => t.type === "blob");
  const suites = blobs
    .filter((b) => TEST_FILE_RE.test(b.path))
    .map((b) => ({
      suiteKey: `file:${b.path}`,
      suiteLabel: b.path.split("/").pop(),
      suiteKind: "spec-file",
      metadata: { path: b.path },
    }));

  await replaceSuites({ integrationId, repoRef, sha, suites });
  return suites;
}

async function replaceSuites({ integrationId, repoRef, sha, suites }) {
  for (const s of suites) {
    await query(
      `INSERT INTO github_repo_suites
         (integration_id, repo_ref, head_sha, suite_key, suite_label, suite_kind, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       ON CONFLICT (integration_id, repo_ref, suite_key) DO UPDATE
         SET head_sha = EXCLUDED.head_sha,
             suite_label = EXCLUDED.suite_label,
             suite_kind = EXCLUDED.suite_kind,
             metadata = EXCLUDED.metadata,
             discovered_at = now()`,
      [integrationId, repoRef, sha, s.suiteKey, s.suiteLabel, s.suiteKind, JSON.stringify(s.metadata || {})]
    );
  }
  // Remove suites whose source files were deleted in this scan. Suites for
  // files that still exist keep their UUIDs so existing schedules' references
  // remain valid.
  const currentKeys = suites.map((s) => s.suiteKey);
  await query(
    `DELETE FROM github_repo_suites
     WHERE integration_id = $1 AND repo_ref = $2
       AND NOT (suite_key = ANY($3::text[]))`,
    [integrationId, repoRef, currentKeys]
  );
}

export async function listSuitesForIntegration(integrationId, repoRef) {
  const result = await query(
    `SELECT id, repo_ref, head_sha, suite_key, suite_label, suite_kind, metadata, discovered_at
     FROM github_repo_suites
     WHERE integration_id = $1 AND repo_ref = $2
     ORDER BY suite_label`,
    [integrationId, repoRef]
  );
  return result.rows;
}
