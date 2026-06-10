import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { config } from "../../config.js";
import { logger } from "../../logger.js";

export function isGithubAppConfigured() {
  const g = config.github;
  return Boolean(g.appId && g.privateKey && g.appClientId && g.appName);
}

function appAuth() {
  if (!isGithubAppConfigured()) {
    throw new Error("GitHub App is not configured");
  }
  return createAppAuth({
    appId: config.github.appId,
    privateKey: config.github.privateKey,
    clientId: config.github.appClientId,
    clientSecret: config.github.appClientSecret,
  });
}

const tokenCache = new Map();

async function getInstallationToken(installationId) {
  const key = String(installationId);
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const auth = appAuth();
  const result = await auth({ type: "installation", installationId });
  tokenCache.set(key, {
    token: result.token,
    expiresAt: new Date(result.expiresAt).getTime(),
  });
  return result.token;
}

export async function installationClient(installationId) {
  const token = await getInstallationToken(installationId);
  return new Octokit({ auth: token });
}

export async function listInstallationRepos(installationId) {
  const octokit = await installationClient(installationId);
  const repos = [];
  let page = 1;
  while (true) {
    const res = await octokit.request("GET /installation/repositories", {
      per_page: 100,
      page,
    });
    repos.push(...res.data.repositories);
    if (res.data.repositories.length < 100) break;
    page += 1;
  }
  return repos.map((r) => ({
    id: r.id,
    fullName: r.full_name,
    private: r.private,
    defaultBranch: r.default_branch,
  }));
}

export async function getInstallationByOwner(owner) {
  const auth = appAuth();
  const { token } = await auth({ type: "app" });
  const octokit = new Octokit({ auth: token });
  const res = await octokit.apps.getUserInstallation({ username: owner }).catch(() => null);
  return res?.data || null;
}

export async function getInstallation(installationId) {
  const auth = appAuth();
  const { token } = await auth({ type: "app" });
  const octokit = new Octokit({ auth: token });
  const res = await octokit.apps.getInstallation({ installation_id: installationId });
  return res.data;
}

export async function getRepoTree(installationId, fullName, ref) {
  const octokit = await installationClient(installationId);
  const [owner, repo] = fullName.split("/");
  const refData = await octokit.git.getRef({ owner, repo, ref: `heads/${ref}` })
    .catch(() => null);
  const sha = refData?.data?.object?.sha;
  if (!sha) return { sha: null, tree: [] };
  const tree = await octokit.git.getTree({ owner, repo, tree_sha: sha, recursive: "1" });
  return { sha, tree: tree.data.tree || [] };
}

export async function getRepoFile(installationId, fullName, path, ref) {
  const octokit = await installationClient(installationId);
  const [owner, repo] = fullName.split("/");
  try {
    const res = await octokit.repos.getContent({ owner, repo, path, ref });
    if (Array.isArray(res.data)) return null;
    if (!("content" in res.data)) return null;
    return Buffer.from(res.data.content, res.data.encoding || "base64").toString("utf8");
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

export async function listPullRequestFiles(installationId, fullName, prNumber) {
  const octokit = await installationClient(installationId);
  const [owner, repo] = fullName.split("/");
  const res = await octokit.paginate(octokit.pulls.listFiles, {
    owner, repo, pull_number: prNumber, per_page: 100,
  });
  return res.map((f) => ({
    filename: f.filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
  }));
}

export async function createPRComment(installationId, fullName, prNumber, body) {
  const octokit = await installationClient(installationId);
  const [owner, repo] = fullName.split("/");
  const res = await octokit.issues.createComment({
    owner, repo, issue_number: prNumber, body,
  });
  return res.data.id;
}

export async function updatePRComment(installationId, fullName, commentId, body) {
  const octokit = await installationClient(installationId);
  const [owner, repo] = fullName.split("/");
  try {
    await octokit.issues.updateComment({ owner, repo, comment_id: commentId, body });
  } catch (err) {
    logger.warn("Failed to update PR comment:", err.message);
  }
}

export function buildInstallUrl(state) {
  if (!config.github.appName) return null;
  const url = new URL(`https://github.com/apps/${config.github.appName}/installations/new`);
  if (state) url.searchParams.set("state", state);
  return url.toString();
}

export async function getDefaultBranch(installationId, fullName) {
  const octokit = await installationClient(installationId);
  const [owner, repo] = fullName.split("/");
  const res = await octokit.repos.get({ owner, repo });
  return res.data.default_branch;
}

/**
 * Look up a GitHub Actions workflow by its file path (e.g. .github/workflows/foo.yml).
 * Returns null if the workflow file hasn't been merged to the default branch yet —
 * GitHub only registers a workflow_id once the file lands on the default branch.
 */
export async function getWorkflowByPath(installationId, fullName, workflowPath) {
  const octokit = await installationClient(installationId);
  const [owner, repo] = fullName.split("/");
  const res = await octokit.request("GET /repos/{owner}/{repo}/actions/workflows", {
    owner, repo, per_page: 100,
  }).catch(() => null);
  if (!res?.data?.workflows) return null;
  return res.data.workflows.find((w) => w.path === workflowPath) || null;
}

/**
 * Create or update an Actions repository secret.
 *
 * GitHub requires the value to be encrypted with the repo's libsodium
 * public key before upload. The encrypted bytes are sent base64-encoded.
 *
 * Requires GitHub App permission: "Secrets: Read & Write" on the repo.
 */
export async function createOrUpdateRepoSecret(installationId, fullName, secretName, secretValue) {
  const sodium = (await import("libsodium-wrappers")).default;
  await sodium.ready;

  const octokit = await installationClient(installationId);
  const [owner, repo] = fullName.split("/");

  const pubKey = await octokit.request(
    "GET /repos/{owner}/{repo}/actions/secrets/public-key",
    { owner, repo }
  );
  const keyBytes = sodium.from_base64(pubKey.data.key, sodium.base64_variants.ORIGINAL);
  const valueBytes = sodium.from_string(secretValue);
  const encryptedBytes = sodium.crypto_box_seal(valueBytes, keyBytes);
  const encryptedB64 = sodium.to_base64(encryptedBytes, sodium.base64_variants.ORIGINAL);

  await octokit.request(
    "PUT /repos/{owner}/{repo}/actions/secrets/{secret_name}",
    {
      owner, repo,
      secret_name: secretName,
      encrypted_value: encryptedB64,
      key_id: pubKey.data.key_id,
    }
  );
}

/**
 * Trigger a workflow_dispatch event on a GitHub Actions workflow.
 * Requires the workflow file to be merged to the default branch AND to have
 * `on: workflow_dispatch:` declared.
 *
 * GitHub's API returns 204 No Content on success and does NOT return the run ID.
 * To find the resulting run, poll the runs list after a few seconds.
 */
export async function dispatchWorkflow(installationId, fullName, { workflowId, ref, inputs = {} }) {
  const octokit = await installationClient(installationId);
  const [owner, repo] = fullName.split("/");
  await octokit.request("POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches", {
    owner, repo,
    workflow_id: workflowId,
    ref,
    inputs,
  });
}

/**
 * List the most recent workflow runs for a given workflow. Used after a
 * workflow_dispatch call to discover the run_id that GitHub just created.
 */
export async function listRecentWorkflowRuns(installationId, fullName, workflowId, limit = 5) {
  const octokit = await installationClient(installationId);
  const [owner, repo] = fullName.split("/");
  const res = await octokit.request("GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs", {
    owner, repo, workflow_id: workflowId, per_page: limit,
  });
  return res.data.workflow_runs || [];
}

export async function createFilePullRequest(installationId, fullName, {
  baseBranch,
  branchName,
  filePath,
  fileContent,
  commitMessage,
  prTitle,
  prBody,
}) {
  const octokit = await installationClient(installationId);
  const [owner, repo] = fullName.split("/");

  const baseRef = await octokit.git.getRef({ owner, repo, ref: `heads/${baseBranch}` });
  const baseSha = baseRef.data.object.sha;

  try {
    await octokit.git.createRef({ owner, repo, ref: `refs/heads/${branchName}`, sha: baseSha });
  } catch (err) {
    if (!String(err.message).includes("Reference already exists")) throw err;
  }

  // GitHub's contents API requires the existing blob's sha when the file is
  // already present on the branch (e.g., on retry after a prior partial run).
  // Omitting it yields "sha wasn't supplied"; including a stale one yields a
  // 409. Always GET first, then PUT with or without sha accordingly.
  let existingSha;
  try {
    const existing = await octokit.repos.getContent({
      owner, repo, path: filePath, ref: branchName,
    });
    if (!Array.isArray(existing.data) && existing.data.sha) {
      existingSha = existing.data.sha;
    }
  } catch (err) {
    if (err.status !== 404) throw err;
  }

  try {
    await octokit.repos.createOrUpdateFileContents({
      owner, repo,
      path: filePath,
      message: commitMessage,
      content: Buffer.from(fileContent).toString("base64"),
      branch: branchName,
      ...(existingSha ? { sha: existingSha } : {}),
    });
  } catch (err) {
    // 422 "no commit was created" — the branch already has identical content.
    // Treat as success so we still proceed to PR creation.
    const msg = String(err.message || "");
    const benign = err.status === 422 && /no commit was created|does not contain new content/i.test(msg);
    if (!benign) throw err;
  }

  try {
    const pr = await octokit.pulls.create({
      owner, repo, title: prTitle, body: prBody, head: branchName, base: baseBranch,
    });
    return { prUrl: pr.data.html_url, prNumber: pr.data.number };
  } catch (err) {
    if (String(err.message).includes("A pull request already exists")) {
      const existing = await octokit.pulls.list({ owner, repo, head: `${owner}:${branchName}`, state: "open" });
      const pr = existing.data[0];
      return { prUrl: pr?.html_url || "", prNumber: pr?.number || 0 };
    }
    throw err;
  }
}

/**
 * Read raw file content from a branch. Returns { content, sha } or null if
 * the file does not exist on that ref.
 */
export async function getFileOnBranch(installationId, fullName, { filePath, branch }) {
  const octokit = await installationClient(installationId);
  const [owner, repo] = fullName.split("/");
  try {
    const res = await octokit.repos.getContent({ owner, repo, path: filePath, ref: branch });
    if (Array.isArray(res.data) || !res.data?.content) return null;
    const content = Buffer.from(res.data.content, "base64").toString("utf8");
    return { content, sha: res.data.sha };
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

/**
 * Commit `fileContent` directly to `branch` at `filePath` (no PR). Used to
 * refresh a Tesbo-Grid-managed workflow file in place after the original PR
 * has been merged — the file's header already states "Managed by Tesbo Grid —
 * do not edit manually," so refreshing on the default branch is in-scope.
 * No-ops when the existing content matches.
 */
export async function updateFileOnBranch(installationId, fullName, {
  filePath,
  branch,
  fileContent,
  commitMessage,
}) {
  const existing = await getFileOnBranch(installationId, fullName, { filePath, branch });
  if (existing && existing.content === fileContent) {
    return { updated: false, sha: existing.sha };
  }
  const octokit = await installationClient(installationId);
  const [owner, repo] = fullName.split("/");
  const res = await octokit.repos.createOrUpdateFileContents({
    owner, repo,
    path: filePath,
    message: commitMessage,
    content: Buffer.from(fileContent).toString("base64"),
    branch,
    ...(existing?.sha ? { sha: existing.sha } : {}),
  });
  return { updated: true, sha: res.data?.content?.sha };
}
