// Set NEXT_PUBLIC_API_URL at build time to your deployed grid-backend URL.
// Falls back to localhost for local development.
const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:7100";

type RequestInitWithBody = Omit<RequestInit, "body"> & { body?: unknown };
type ApiErrorBody = { error?: string; detail?: string } & Record<string, unknown>;

function formatApiError(status: number, body: ApiErrorBody): string {
  const msg = body.error || String(status);
  const detail = typeof body.detail === "string" ? body.detail.trim() : "";
  if (detail) return `${msg}: ${detail}`;
  return msg;
}

export class ApiError extends Error {
  status: number;
  data: ApiErrorBody;
  constructor(status: number, data: ApiErrorBody) {
    super(formatApiError(status, data));
    this.name = "ApiError";
    this.status = status;
    this.data = data;
  }
}

export async function api<T = unknown>(
  path: string,
  options: RequestInitWithBody = {}
): Promise<T> {
  const { body, ...rest } = options;
  const headers: HeadersInit = {
    "Content-Type": "application/json",
    ...(rest.headers as Record<string, string>),
  };
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...rest,
      headers,
      credentials: "include",
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Network request failed";
    const looksLikeCorsOrNetwork =
      msg === "Failed to fetch" ||
      msg === "Load failed" ||
      msg.includes("NetworkError") ||
      msg.includes("network");
    if (looksLikeCorsOrNetwork) {
      throw new Error(
        `${msg} — browser blocked or could not reach the API. Confirm NEXT_PUBLIC_API_URL and that the backend allows this origin in CORS_ALLOWED_ORIGINS.`
      );
    }
    throw e instanceof Error ? e : new Error(String(e));
  }
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as ApiErrorBody;
    throw new ApiError(res.status, err);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// --- Auth ---

export async function authMe(): Promise<{ userId: string } | null> {
  try {
    return await api<{ userId: string }>("/api/auth/me");
  } catch {
    return null;
  }
}

export async function requestOtp(email: string): Promise<void> {
  await api("/api/auth/otp/request", { method: "POST", body: { email } });
}

export async function verifyOtp(
  email: string,
  code: string
): Promise<{ ok: boolean; userId: string }> {
  return api("/api/auth/otp/verify", { method: "POST", body: { email, code } });
}

export async function logout(): Promise<void> {
  await api("/api/auth/logout", { method: "POST" });
}

// --- Onboarding ---

export interface OnboardingResponse {
  organizationId: string;
  projectId: string;
  projectKey: string;
}

export interface CreateWorkspaceResponse {
  organizationId: string;
}

export async function createWorkspace(data: {
  orgName: string;
}): Promise<CreateWorkspaceResponse> {
  return api<CreateWorkspaceResponse>("/api/onboarding/workspace", {
    method: "POST",
    body: data,
  });
}

export async function createOrgAndProject(data: {
  orgName: string;
  projectKey: string;
  projectName: string;
  projectDescription?: string;
  framework: ProjectFramework;
  language: ProjectLanguage;
  defaultBrowser: ProjectBrowser;
}): Promise<OnboardingResponse> {
  return api<OnboardingResponse>("/api/onboarding/org-and-project", {
    method: "POST",
    body: data,
  });
}

export async function seedDemoProject(): Promise<{ projectId: string; alreadyExists?: boolean }> {
  return api<{ projectId: string; alreadyExists?: boolean }>(
    "/api/onboarding/seed-demo",
    { method: "POST" }
  );
}

// --- Workspace ---

export interface WorkspaceInfo {
  id: string;
  name: string;
  slug: string;
  role?: string;
  createdAt: string;
}

export interface WorkspaceMember {
  userId: string;
  email: string;
  name: string;
  role: string;
  joinedAt: string;
}

export async function getWorkspace(): Promise<WorkspaceInfo | null> {
  return api<WorkspaceInfo | null>("/api/workspace");
}

export async function listWorkspaceMembers(): Promise<WorkspaceMember[]> {
  return api<WorkspaceMember[]>("/api/workspace/members");
}

export async function addWorkspaceMember(data: {
  email?: string;
  userId?: string;
  role?: string;
}): Promise<void> {
  await api("/api/workspace/members", { method: "POST", body: data });
}

export async function removeWorkspaceMember(userId: string): Promise<void> {
  await api(`/api/workspace/members/${userId}`, { method: "DELETE" });
}

// --- Workspace AI Keys ---

export interface WorkspaceAiKey {
  id: string;
  name: string;
  provider: "openai" | "anthropic";
  defaultModel?: string;
  active: boolean;
  maskedKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceAiProjectAllocation {
  projectId: string;
  projectKey: string;
  projectName: string;
  workspaceAiKeyId: string;
}

export interface WorkspaceAiKeysResponse {
  keys: WorkspaceAiKey[];
  projects: WorkspaceAiProjectAllocation[];
}

export async function listWorkspaceAiKeys(): Promise<WorkspaceAiKeysResponse> {
  return api<WorkspaceAiKeysResponse>("/api/workspace/ai-keys");
}

export async function createWorkspaceAiKey(data: {
  name: string;
  provider: "openai" | "anthropic";
  apiKey: string;
  defaultModel?: string;
}): Promise<WorkspaceAiKey> {
  return api<WorkspaceAiKey>("/api/workspace/ai-keys", {
    method: "POST",
    body: data,
  });
}

export async function deleteWorkspaceAiKey(keyId: string): Promise<void> {
  await api(`/api/workspace/ai-keys/${keyId}`, { method: "DELETE" });
}

export async function allocateWorkspaceAiKeyToProject(data: {
  projectId: string;
  workspaceAiKeyId?: string;
}): Promise<void> {
  await api("/api/workspace/ai-keys/allocations", {
    method: "POST",
    body: data,
  });
}

// --- Workspace Invitations ---

export interface WorkspaceInvitation {
  id: string;
  email: string;
  role: string;
  expiresAt: string;
  createdAt: string;
}

export async function listWorkspaceInvitations(): Promise<
  WorkspaceInvitation[]
> {
  return api<WorkspaceInvitation[]>("/api/workspace/invitations");
}

export async function createWorkspaceInvitation(data: {
  email: string;
  role?: string;
}): Promise<WorkspaceInvitation> {
  return api<WorkspaceInvitation>("/api/workspace/invitations", {
    method: "POST",
    body: data,
  });
}

export async function revokeWorkspaceInvitation(id: string): Promise<void> {
  await api(`/api/workspace/invitations/${id}`, { method: "DELETE" });
}

// --- Projects ---

export type ProjectFramework = "playwright" | "selenium";
export type ProjectLanguage = "javascript" | "typescript" | "python" | "java";
export type ProjectBrowser = "chrome" | "firefox" | "edge";

export interface ProjectStackSettings {
  framework?: ProjectFramework;
  language?: ProjectLanguage;
  defaultBrowser?: ProjectBrowser;
  // Per-project Selenium session concurrency cap. Null/undefined or 0 means
  // "no per-project cap — only the cluster's node capacity applies". Any
  // other non-negative integer is the hard cap enforced by the
  // grid-selenium-proxy at session-create time.
  maxConcurrentSessions?: number | null;
  // Other settings keys are tolerated but unspecified.
  [key: string]: unknown;
}

export interface ProjectSummary {
  id: string;
  key: string;
  name: string;
  description: string;
  settings?: ProjectStackSettings | null;
  isDemo: boolean;
  role: string;
  linkedTesboxProjects: number;
  createdAt: string;
}

export interface ProjectDetail {
  id: string;
  key: string;
  name: string;
  description: string | null;
  settings?: ProjectStackSettings | null;
  role: string;
  organizationId: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProjectResponse {
  id: string;
  key: string;
  name: string;
  description: string;
  settings?: ProjectStackSettings | null;
  createdAt: string;
  initialApiKey?: { key: string; id?: string; name?: string };
}

export async function listProjects(): Promise<ProjectSummary[]> {
  return api<ProjectSummary[]>("/api/projects");
}

export async function createProject(data: {
  key?: string;
  name: string;
  description?: string;
  framework: ProjectFramework;
  language: ProjectLanguage;
  defaultBrowser: ProjectBrowser;
}): Promise<CreateProjectResponse> {
  return api<CreateProjectResponse>("/api/projects", {
    method: "POST",
    body: data,
  });
}

export async function getProject(id: string): Promise<ProjectDetail> {
  return api<ProjectDetail>(`/api/projects/${id}`);
}

export async function updateProject(
  id: string,
  data: {
    name?: string;
    description?: string;
    settings?: ProjectStackSettings | string;
    // For projects whose settings still lack framework/language/defaultBrowser,
    // pass `lockMissingStackKeys: true` so the backend writes the stack keys
    // (only the absent ones; existing values stay immutable).
    lockMissingStackKeys?: boolean;
  }
): Promise<void> {
  await api(`/api/projects/${id}`, { method: "PATCH", body: data });
}

export async function deleteProject(id: string): Promise<void> {
  await api(`/api/projects/${id}`, { method: "DELETE" });
}

// --- Live Selenium sessions ---

export type SeleniumSessionStatus =
  | "queued"
  | "active"
  | "ended"
  | "abandoned"
  | "failed";

export interface SeleniumSession {
  id: string;
  seleniumId: string | null;
  requestId: string | null;
  projectId: string;
  apiKeyId: string | null;
  startedAt: string | null;
  queuedAt: string | null;
  endedAt: string | null;
  // Updated whenever the proxy captures a WebDriver command for this
  // session. Used as the source-of-truth for "is this still live?" — falls
  // back to startedAt for rows from before the schema change.
  lastActivityAt: string | null;
  status: SeleniumSessionStatus;
  durationMs: number | null;
  endReason: string | null;
  browser: string | null;
  browserVersion: string | null;
  platform: string | null;
  build: string | null;
  name: string | null;
  tags: string[];
  liveAvailable: boolean;
  // True iff the proxy has already discovered which selenium-node holds
  // this session (i.e. selenium_sessions.node_uri is populated). When
  // false, the dashboard can still attempt the live viewer — the proxy
  // does a lazy discovery on connect — but a small "discovering node…"
  // hint while we wait avoids a confusing-looking close on slow hubs.
  nodeUriKnown?: boolean;
  // Public URL of the recorded session video. Populated by grid-backend
  // for completed sessions when artifact storage (DO Spaces) is set up
  // and the `selenium-node` video sidecar has finished its upload. Null
  // for live sessions or when the deployment doesn't enable recordings.
  videoUrl: string | null;
}

// Per-status totals across the project (date/build filters applied, status
// filter NOT applied). Lets the dashboard's metric cards reflect reality
// instead of just the rows visible on the active tab.
export interface SeleniumSessionsCounts {
  queued: number;
  active: number;
  ended: number;
  abandoned: number;
  failed: number;
}

export interface SeleniumSessionsResponse {
  sessions: SeleniumSession[];
  count: number;
  counts?: SeleniumSessionsCounts;
}

// `status` accepts a single value, an array, or one of the group aliases
// "live" / "completed" — the runner-api expands the aliases server-side so
// the dashboard doesn't have to keep its mapping in sync.
export type SeleniumSessionStatusFilter =
  | SeleniumSessionStatus
  | SeleniumSessionStatus[]
  | "live"
  | "completed";

function serialiseStatus(value: SeleniumSessionStatusFilter): string {
  if (Array.isArray(value)) return value.join(",");
  return value;
}

export async function listSeleniumSessions(
  projectId: string,
  filters: {
    status?: SeleniumSessionStatusFilter;
    build?: string;
    limit?: number;
    // ISO 8601 timestamp or YYYY-MM-DD date. The Completed tab uses
    // `from`/`to` to slice history without paginating through thousands of
    // rows on busy projects.
    from?: string;
    to?: string;
  } = {}
): Promise<SeleniumSessionsResponse> {
  const params = new URLSearchParams();
  if (filters.status) params.set("status", serialiseStatus(filters.status));
  if (filters.build) params.set("build", filters.build);
  if (filters.limit) params.set("limit", String(filters.limit));
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  const qs = params.toString();
  return api<SeleniumSessionsResponse>(
    `/api/projects/${projectId}/selenium-sessions${qs ? `?${qs}` : ""}`
  );
}

export async function getSeleniumSession(
  projectId: string,
  seleniumId: string
): Promise<{ session: SeleniumSession }> {
  return api<{ session: SeleniumSession }>(
    `/api/projects/${projectId}/selenium-sessions/${encodeURIComponent(seleniumId)}`
  );
}

export interface SeleniumSessionCommand {
  id: string;
  sequence: number;
  occurredAt: string;
  method: string;
  path: string;
  command: string | null;
  status: number | null;
  durationMs: number | null;
  requestBody: string | null;
  responseBody: string | null;
  error: string | null;
}

export async function getSeleniumSessionCommands(
  projectId: string,
  seleniumId: string,
  options: { since?: number; limit?: number } = {}
): Promise<{ seleniumId: string; commands: SeleniumSessionCommand[] }> {
  const params = new URLSearchParams();
  if (options.since) params.set("since", String(options.since));
  if (options.limit) params.set("limit", String(options.limit));
  const qs = params.toString();
  return api<{ seleniumId: string; commands: SeleniumSessionCommand[] }>(
    `/api/projects/${projectId}/selenium-sessions/${encodeURIComponent(
      seleniumId
    )}/commands${qs ? `?${qs}` : ""}`
  );
}

export interface SeleniumSessionLinkedTest {
  id: string;
  runId: string;
  name: string | null;
  fullTitle: string | null;
  spec: string | null;
  status: string | null;
  durationMs: number | null;
  errorMessage: string | null;
  screenshotUrl: string | null;
  videoUrl: string | null;
  traceUrl: string | null;
  createdAt: string | null;
}

export async function getSeleniumSessionTests(
  projectId: string,
  seleniumId: string
): Promise<{ seleniumId: string; tests: SeleniumSessionLinkedTest[] }> {
  return api<{ seleniumId: string; tests: SeleniumSessionLinkedTest[] }>(
    `/api/projects/${projectId}/selenium-sessions/${encodeURIComponent(
      seleniumId
    )}/tests`
  );
}

// Build the WebSocket URL the noVNC viewer should connect to. Mirrors the
// API_BASE convention but switches the protocol so cookie auth still works
// (browsers send cookies on same-origin WS upgrades).
export function buildSeleniumLiveVncUrl(
  projectId: string,
  seleniumId: string
): string {
  const base = (() => {
    if (typeof window === "undefined") return "";
    if (process.env.NEXT_PUBLIC_API_URL) return process.env.NEXT_PUBLIC_API_URL;
    return "http://localhost:7100";
  })();
  const url = new URL(base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/api/projects/${projectId}/selenium-sessions/${encodeURIComponent(
    seleniumId
  )}/vnc`;
  return url.toString();
}

// --- Project Members ---

export async function listProjectMembers(
  projectId: string
): Promise<
  { userId: string; email: string; name: string; role: string; joinedAt: string }[]
> {
  return api(`/api/projects/${projectId}/members`);
}

export async function addProjectMember(
  projectId: string,
  data: { userId: string; role: string }
): Promise<void> {
  await api(`/api/projects/${projectId}/members`, {
    method: "POST",
    body: data,
  });
}

export async function removeProjectMember(
  projectId: string,
  userId: string
): Promise<void> {
  await api(`/api/projects/${projectId}/members/${userId}`, {
    method: "DELETE",
  });
}

export interface ProjectInvitation {
  id: string;
  email: string;
  role: string;
  expiresAt: string;
  createdAt: string;
}

export async function listProjectInvitations(
  projectId: string
): Promise<ProjectInvitation[]> {
  return api<ProjectInvitation[]>(`/api/projects/${projectId}/invitations`);
}

export async function createProjectInvitation(
  projectId: string,
  data: { email: string; role?: string }
): Promise<{ mode: "member_added" | "invited"; invitation?: ProjectInvitation }> {
  return api<{ mode: "member_added" | "invited"; invitation?: ProjectInvitation }>(
    `/api/projects/${projectId}/invitations`,
    {
      method: "POST",
      body: data,
    }
  );
}

export async function revokeProjectInvitation(
  projectId: string,
  invitationId: string
): Promise<void> {
  await api(`/api/projects/${projectId}/invitations/${invitationId}`, {
    method: "DELETE",
  });
}

// --- Execution API Keys ---

export interface ExecutionApiKey {
  id: string;
  name: string;
  project_id: string;
  scopes: string[];
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  masked: string;
}

export async function listExecutionApiKeys(
  projectId: string
): Promise<{ keys: ExecutionApiKey[] }> {
  return api<{ keys: ExecutionApiKey[] }>(
    `/api/projects/${projectId}/apikeys`
  );
}

export async function createExecutionApiKey(
  projectId: string,
  name: string
): Promise<{ key: string; id: string; name: string }> {
  return api<{ key: string; id: string; name: string }>(
    `/api/projects/${projectId}/apikeys`,
    { method: "POST", body: { name } }
  );
}

export async function revokeExecutionApiKey(
  projectId: string,
  keyId: string
): Promise<void> {
  await api(`/api/projects/${projectId}/apikeys/${keyId}`, {
    method: "DELETE",
  });
}

// --- Report Runs ---

export interface ReportRun {
  id: string;
  executionRunId: string | null;
  runName: string;
  sourceType: string;
  status: string;
  totalTests: number;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  aiAnalysisEnabled?: boolean;
  releaseRiskScore?: number | null;
  releaseRiskLevel?: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" | null;
  releaseRiskBreakdown?: Record<string, unknown> | null;
  releaseRiskUpdatedAt?: string | null;
  publicShareEnabled?: boolean;
  publicShareToken?: string | null;
}

export interface ReportTest {
  id: string;
  spec: string;
  name: string;
  fullTitle: string;
  status: string;
  durationMs: number | null;
  errorMessage: string | null;
  errorStack: string | null;
  attempt: number | null;
  projectName: string | null;
  tags: string[];
  traceUrl: string | null;
  screenshotUrl: string | null;
  videoUrl: string | null;
  steps: { description: string }[];
  createdAt: string;
  aiAnalysisStatus: "PENDING" | "COMPLETED" | "ERROR" | "NEEDS_REVIEW" | null;
  aiAnalysisCategory: "ACTUAL_BUG" | "FEATURE_CHANGE" | "SCRIPT_ISSUE" | "ENVIRONMENT_ISSUE" | null;
  aiAnalysisSummary: string | null;
  aiAnalysisConfidence: number | null;
  aiAnalysisModel: string | null;
  aiAnalysisUpdatedAt: string | null;
  aiAnalysisPromptVersion?: string | null;
  isProbableRegression?: boolean;
  regressionConfidence?: number | null;
  regressionPassStreakBeforeFail?: number | null;
  regressionFirstSeenRunId?: string | null;
  regressionHint?: string | null;
  // Selenium session correlation. Populated by the backend when the test
  // framework tagged its WebDriver session with `tesbo:options.build` /
  // `tesbo:options.name` (or when the heuristic fallback picked a
  // session). All four fields are null on tests that couldn't be
  // correlated — typically Playwright runs or Selenium suites that
  // don't pass the env-driven capabilities through.
  seleniumSessionId?: string | null;
  // Latest known status. We re-hydrate this on every fetch from the
  // runner-api so the dashboard can decide between "Live VNC" and
  // "Session recording" without a second round-trip.
  seleniumSessionStatus?:
    | "queued"
    | "active"
    | "ended"
    | "abandoned"
    | "failed"
    | null;
  // True iff status === 'active' AND the proxy has discovered the upstream
  // node. The "Live VNC" pill only renders in this exact state — a session
  // that's queued but not yet on a node has no VNC port to tunnel to.
  seleniumSessionLiveAvailable?: boolean;
  // Public URL of the session's recorded mp4. Set only after the session
  // has ended AND the selenium-node uploader sidecar finished; null
  // otherwise (live sessions or deployments without artifact storage).
  seleniumSessionVideoUrl?: string | null;
}

export interface ReportRunsResponse {
  runs: ReportRun[];
  total: number;
  page: number;
  limit: number;
}

export interface ReportRunDetail extends ReportRun {
  tests: ReportTest[];
}

export interface SpecIntelligenceItem {
  spec: string;
  totalExecutions: number;
  passed: number;
  failed: number;
  skipped: number;
  avgDurationMs: number | null;
  failureRate: number;
  lastStatus: string | null;
  lastSeenAt: string | null;
  actualBugFailures: number;
  featureChangeFailures: number;
  scriptIssueFailures: number;
  environmentIssueFailures: number;
}

export interface SpecIntelligenceResponse {
  specs: SpecIntelligenceItem[];
  total: number;
  page: number;
  limit: number;
}

export interface SpecRunIntelligenceItem {
  runId: string;
  runName: string;
  runStatus: string;
  startedAt: string | null;
  totalExecutions: number;
  passed: number;
  failed: number;
  skipped: number;
  avgDurationMs: number | null;
  failureRate: number;
}

export interface SpecFailingTestItem {
  testName: string;
  failed: number;
  passed: number;
  totalExecutions: number;
  failureRate: number;
  lastFailedAt: string | null;
}

export interface SpecPeerComparisonItem {
  spec: string;
  passed: number;
  failed: number;
}

export interface SpecIntelligenceDetailResponse {
  spec: string;
  summary: {
    totalExecutions: number;
    passed: number;
    failed: number;
    skipped: number;
    avgDurationMs: number | null;
    failureRate: number;
    lastSeenAt: string | null;
    actualBugFailures: number;
    featureChangeFailures: number;
    scriptIssueFailures: number;
    environmentIssueFailures: number;
    totalTestCases: number;
    flakyTestCases: number;
    combinedSpecFlakyRatio: number;
  } | null;
  runs: SpecRunIntelligenceItem[];
  topFailingTests: SpecFailingTestItem[];
  peerSpecComparison: SpecPeerComparisonItem[];
  testCaseFlakiness: {
    testName: string;
    totalExecutions: number;
    passed: number;
    failed: number;
    skipped: number;
    flakyRatio: number;
    flaky: boolean;
  }[];
}

export interface TestIntelligenceItem {
  spec: string;
  testName: string;
  totalExecutions: number;
  passed: number;
  failed: number;
  skipped: number;
  avgDurationMs: number | null;
  failureRate: number;
  flaky: boolean;
  lastStatus: string | null;
  lastSeenAt: string | null;
  actualBugFailures: number;
  featureChangeFailures: number;
  scriptIssueFailures: number;
  environmentIssueFailures: number;
  latestErrorMessage: string | null;
  probableRegression?: boolean;
  flakyScore?: number | null;
  flakyTrendSlope?: number | null;
  likelyFlakyReason?: string | null;
}

export interface TestIntelligenceResponse {
  tests: TestIntelligenceItem[];
  total: number;
  page: number;
  limit: number;
}

export interface TestIntelligenceDetailResponse {
  spec: string;
  testName: string;
  summary: {
    totalExecutions: number;
    passed: number;
    failed: number;
    skipped: number;
    avgDurationMs: number | null;
    failureRate: number;
    flaky: boolean;
    lastSeenAt: string | null;
    actualBugFailures: number;
    featureChangeFailures: number;
    scriptIssueFailures: number;
    environmentIssueFailures: number;
    latestErrorMessage: string | null;
    probableRegressions?: number;
  } | null;
  runs: {
    runId: string;
    runName: string;
    runStatus: string;
    startedAt: string | null;
    testStatus: string;
    durationMs: number | null;
    errorMessage: string | null;
    aiAnalysisCategory: "ACTUAL_BUG" | "FEATURE_CHANGE" | "SCRIPT_ISSUE" | "ENVIRONMENT_ISSUE" | null;
    aiAnalysisSummary: string | null;
    aiAnalysisConfidence: number | null;
    steps: { description: string }[];
    isProbableRegression?: boolean;
    regressionConfidence?: number | null;
    regressionPassStreakBeforeFail?: number | null;
    regressionHint?: string | null;
  }[];
}

export type FailureCategoryHint =
  | "ACTUAL_BUG"
  | "FEATURE_CHANGE"
  | "SCRIPT_ISSUE"
  | "ENVIRONMENT_ISSUE"
  | null;

export interface RunCluster {
  id: string;
  clusterKey: string;
  title: string;
  summary: string | null;
  errorType: string | null;
  categoryHint: FailureCategoryHint;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  testCount: number;
  avgMatchConfidence: number | null;
}

export interface RunClusterTest {
  id: string;
  spec: string | null;
  name: string | null;
  fullTitle: string | null;
  status: string;
  durationMs: number | null;
  attempt: number | null;
  projectName: string | null;
  aiAnalysisCategory: FailureCategoryHint;
  aiAnalysisSummary: string | null;
  matchConfidence: number | null;
  errorPreview: string | null;
}

export interface RunClusterDetail {
  id: string;
  clusterKey: string;
  title: string;
  summary: string | null;
  errorType: string | null;
  categoryHint: FailureCategoryHint;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  occurrenceCount: number;
  testCount: number;
  avgMatchConfidence: number | null;
  sampleErrorMessage: string | null;
  sampleErrorStack: string | null;
  tests: RunClusterTest[];
}

export interface RunRiskResponse {
  score: number | null;
  level: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" | null;
  breakdown: Record<string, unknown> | null;
  updatedAt: string | null;
}

export interface FlakyTestsResponse {
  tests: {
    spec: string;
    testName: string;
    flakyScore: number;
    trendSlope: number | null;
    likelyFlakyReason: string | null;
    updatedAt: string;
  }[];
  total: number;
  page: number;
  limit: number;
}

export interface RegressionsResponse {
  regressions: {
    runId: string;
    runName: string;
    runStatus: string;
    startedAt: string | null;
    spec: string;
    testName: string;
    confidence: number | null;
    passStreakBeforeFail: number | null;
    hint: string | null;
  }[];
  total: number;
  page: number;
  limit: number;
}

export interface QualityOverviewResponse {
  runs: {
    totalRuns: number;
    avgRiskScore: number | null;
    maxRiskScore: number | null;
  };
  clusters: {
    totalClusters: number;
    totalOccurrences: number;
  };
  flakiness: {
    avgFlakyScore: number | null;
    highFlakyTests: number;
  };
  regressions: {
    probableRegressions: number;
  };
}

export async function listReportRuns(
  projectId: string,
  page = 1,
  limit = 20
): Promise<ReportRunsResponse> {
  return api<ReportRunsResponse>(
    `/api/projects/${projectId}/tesbo-reports/runs?page=${page}&limit=${limit}`
  );
}

export async function getReportRun(
  projectId: string,
  runId: string
): Promise<ReportRunDetail> {
  return api<ReportRunDetail>(
    `/api/projects/${projectId}/tesbo-reports/runs/${runId}`
  );
}

// Fetch the WebDriver command tail captured for the Selenium session that
// produced this test. Returns the canonical { commands } payload from the
// runner-api. Throws if the test has no linked session — the run-detail
// page should only call this for tests where `seleniumSessionId` is set.
export async function getReportTestSessionCommands(
  projectId: string,
  runId: string,
  testId: string,
  options: { since?: number; limit?: number } = {}
): Promise<{ seleniumId: string; commands: SeleniumSessionCommand[] }> {
  const params = new URLSearchParams();
  if (options.since) params.set("since", String(options.since));
  if (options.limit) params.set("limit", String(options.limit));
  const qs = params.toString();
  return api<{ seleniumId: string; commands: SeleniumSessionCommand[] }>(
    `/api/projects/${projectId}/tesbo-reports/runs/${runId}/tests/${encodeURIComponent(
      testId
    )}/session-commands${qs ? `?${qs}` : ""}`
  );
}

export async function getRunClusters(
  projectId: string,
  runId: string
): Promise<{ clusters: RunCluster[] }> {
  return api<{ clusters: RunCluster[] }>(
    `/api/projects/${projectId}/tesbo-reports/runs/${runId}/clusters`
  );
}

export async function getRunCluster(
  projectId: string,
  runId: string,
  clusterId: string
): Promise<RunClusterDetail> {
  return api<RunClusterDetail>(
    `/api/projects/${projectId}/tesbo-reports/runs/${runId}/clusters/${clusterId}`
  );
}

export async function getRunRisk(
  projectId: string,
  runId: string
): Promise<RunRiskResponse> {
  return api<RunRiskResponse>(
    `/api/projects/${projectId}/tesbo-reports/runs/${runId}/risk`
  );
}

// Public sharing API functions
export async function toggleRunPublicShare(
  projectId: string,
  runId: string,
  enabled: boolean
): Promise<{ enabled: boolean; publicUrl: string | null }> {
  return api<{ enabled: boolean; publicUrl: string | null }>(
    `/api/projects/${projectId}/tesbo-reports/runs/${runId}/public-share`,
    {
      method: "PATCH",
      body: JSON.stringify({ enabled }),
    }
  );
}

export async function getPublicRun(token: string): Promise<ReportRunDetail & { isPublicView?: boolean }> {
  return api<ReportRunDetail & { isPublicView?: boolean }>(`/api/public/runs/${token}`);
}

export async function getSpecIntelligence(
  projectId: string,
  page = 1,
  limit = 50
): Promise<SpecIntelligenceResponse> {
  return api<SpecIntelligenceResponse>(
    `/api/projects/${projectId}/tesbo-reports/spec-intelligence?page=${page}&limit=${limit}`
  );
}

export async function getSpecIntelligenceDetail(
  projectId: string,
  spec: string,
  runLimit = 25
): Promise<SpecIntelligenceDetailResponse> {
  return api<SpecIntelligenceDetailResponse>(
    `/api/projects/${projectId}/tesbo-reports/spec-intelligence/detail?spec=${encodeURIComponent(spec)}&runLimit=${runLimit}`
  );
}

export async function getTestIntelligence(
  projectId: string,
  page = 1,
  limit = 50
): Promise<TestIntelligenceResponse> {
  return api<TestIntelligenceResponse>(
    `/api/projects/${projectId}/tesbo-reports/test-intelligence?page=${page}&limit=${limit}`
  );
}

export async function getFlakyTests(
  projectId: string,
  page = 1,
  limit = 50,
  minScore = 0
): Promise<FlakyTestsResponse> {
  return api<FlakyTestsResponse>(
    `/api/projects/${projectId}/tesbo-reports/flaky-tests?page=${page}&limit=${limit}&minScore=${minScore}`
  );
}

export async function getTestIntelligenceDetail(
  projectId: string,
  spec: string,
  testName: string,
  runLimit = 30
): Promise<TestIntelligenceDetailResponse> {
  return api<TestIntelligenceDetailResponse>(
    `/api/projects/${projectId}/tesbo-reports/test-intelligence/detail?spec=${encodeURIComponent(spec)}&testName=${encodeURIComponent(testName)}&runLimit=${runLimit}`
  );
}

export async function getRegressions(
  projectId: string,
  page = 1,
  limit = 50
): Promise<RegressionsResponse> {
  return api<RegressionsResponse>(
    `/api/projects/${projectId}/tesbo-reports/regressions?page=${page}&limit=${limit}`
  );
}

export async function getQualityOverview(
  projectId: string
): Promise<QualityOverviewResponse> {
  return api<QualityOverviewResponse>(
    `/api/projects/${projectId}/tesbo-reports/quality-overview`
  );
}

// --- Project Access Key (tesbo_) ---

export async function getProjectAccessKey(
  projectId: string
): Promise<{ ingestionApiKey: string | null }> {
  return api<{ ingestionApiKey: string | null }>(
    `/api/projects/${projectId}/access-key`
  );
}

export async function rotateProjectAccessKey(
  projectId: string
): Promise<{ ingestionApiKey: string }> {
  return api<{ ingestionApiKey: string }>(
    `/api/projects/${projectId}/access-key/rotate`,
    { method: "POST" }
  );
}

// --- Project Alerts ---

export type AlertMetric = "pass_ratio" | "failure_rate" | "flaky_tests";
export type AlertOperator = "below" | "above";
export type AlertChannel = "email" | "in_app" | "slack";
export type AlertUnit = "%" | "tests";

export interface ProjectAlert {
  id: string;
  name: string;
  metric: AlertMetric;
  operator: AlertOperator;
  threshold: number;
  unit: AlertUnit;
  channel: AlertChannel;
  recipients: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectAlertEvent {
  id: string;
  alertId: string | null;
  ruleTitle: string;
  summary: string;
  severity: "Low" | "Medium" | "High";
  runId: string | null;
  runName: string | null;
  metric: AlertMetric;
  observedValue: number | null;
  threshold: number | null;
  triggeredAt: string;
}

export type AlertInput = {
  name: string;
  metric: AlertMetric;
  operator: AlertOperator;
  threshold: number;
  unit: AlertUnit;
  channel: AlertChannel;
  recipients: string[];
  enabled: boolean;
};

export async function listProjectAlerts(
  projectId: string
): Promise<{ alerts: ProjectAlert[] }> {
  return api<{ alerts: ProjectAlert[] }>(`/api/projects/${projectId}/alerts`);
}

export async function createProjectAlert(
  projectId: string,
  data: AlertInput
): Promise<{ alert: ProjectAlert }> {
  return api<{ alert: ProjectAlert }>(`/api/projects/${projectId}/alerts`, {
    method: "POST",
    body: data,
  });
}

export async function updateProjectAlert(
  projectId: string,
  alertId: string,
  data: Partial<AlertInput>
): Promise<{ alert: ProjectAlert }> {
  return api<{ alert: ProjectAlert }>(
    `/api/projects/${projectId}/alerts/${alertId}`,
    { method: "PATCH", body: data }
  );
}

export async function deleteProjectAlert(
  projectId: string,
  alertId: string
): Promise<void> {
  await api(`/api/projects/${projectId}/alerts/${alertId}`, {
    method: "DELETE",
  });
}

export async function listProjectAlertEvents(
  projectId: string,
  limit = 50
): Promise<{ events: ProjectAlertEvent[] }> {
  return api<{ events: ProjectAlertEvent[] }>(
    `/api/projects/${projectId}/alerts/events?limit=${limit}`
  );
}

// --- Bridge Links ---

export interface BridgeLink {
  id: string;
  tesboxProjectId: string;
  executeProjectId: string;
  executeProjectKey: string;
  executeApiKeyId: string;
  executeApiKeyName: string;
  executeApiKeyMasked: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  tesboxProjectName: string;
  tesboxProjectCode: string;
}

export async function listProjectLinks(
  projectId: string
): Promise<BridgeLink[]> {
  return api<BridgeLink[]>(`/api/projects/${projectId}/links`);
}

// --- GitHub Integration ---

export interface GithubStatus {
  configured: boolean;
  appName: string | null;
}

export interface GithubRepo {
  id: string | number;
  fullName: string;
  private?: boolean;
  defaultBranch?: string;
}

export interface GithubScheduleSelectedSuite {
  id: string;
  key: string;
  label: string;
  kind: string;
  path: string | null;
}

export interface GithubSchedule {
  id: string;
  name: string;
  triggerType: "cron" | "pr";
  cronExpression: string | null;
  scheduleTimezone: string | null;
  testRepoRef: string;
  suiteMode: "fixed" | "dynamic";
  discoveredSuiteIds: string[];
  runAllTests: boolean;
  selectedSuites: GithubScheduleSelectedSuite[];
  enabled: boolean;
  lastFiredAt: string | null;
  nextFireAt: string | null;
  createdAt: string;
  runAsUserId: string | null;
  runAsUserName: string | null;
  runAsUserEmail: string | null;
  environmentId: string | null;
  environmentName: string | null;
  environmentBaseUrl: string | null;
  workflowFilePath: string | null;
  workflowStatus: "pending_workflow_merge" | "active" | "workflow_missing" | "error" | "paused" | null;
  workflowStatusDetail: string | null;
  setupPrUrl: string | null;
  setupPrNumber: number | null;
  setupPrMergedAt: string | null;
  repoSecretConfigured: boolean;
}

export interface ProjectEnvironmentVariable {
  key: string;
  value: string;
  isSecret: boolean;
}

export interface ProjectEnvironment {
  id: string;
  projectId: string;
  name: string;
  baseUrl: string | null;
  variables: ProjectEnvironmentVariable[];
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export async function listProjectEnvironments(
  projectId: string
): Promise<{ environments: ProjectEnvironment[]; canManage: boolean }> {
  return api(`/api/projects/${projectId}/environments`);
}

export async function createProjectEnvironment(
  projectId: string,
  data: {
    name: string;
    baseUrl?: string | null;
    variables?: ProjectEnvironmentVariable[];
    isDefault?: boolean;
  }
): Promise<ProjectEnvironment> {
  return api(`/api/projects/${projectId}/environments`, { method: "POST", body: data });
}

export async function updateProjectEnvironment(
  projectId: string,
  environmentId: string,
  data: Partial<{
    name: string;
    baseUrl: string | null;
    variables: ProjectEnvironmentVariable[];
    isDefault: boolean;
  }>
): Promise<ProjectEnvironment> {
  return api(`/api/projects/${projectId}/environments/${environmentId}`, {
    method: "PATCH",
    body: data,
  });
}

export async function deleteProjectEnvironment(
  projectId: string,
  environmentId: string
): Promise<void> {
  await api(`/api/projects/${projectId}/environments/${environmentId}`, { method: "DELETE" });
}

export interface GithubIntegration {
  id: string;
  projectId: string;
  installationId: string;
  accountLogin: string;
  devRepo: { id: string; fullName: string } | null;
  testRepo: { id: string; fullName: string };
  webhookUrl: string;
  createdAt: string;
  schedules: GithubSchedule[];
  aiKey: { id: string; name: string; provider: string } | null;
  viewerRole?: "owner" | "admin" | "member" | string;
  canManage?: boolean;
}

export interface GithubDiscoveredSuite {
  id: string;
  key: string;
  label: string;
  kind: string;
  metadata: Record<string, unknown>;
  discoveredAt: string;
}

export async function getGithubStatus(): Promise<GithubStatus> {
  return api<GithubStatus>("/api/github/status");
}

export async function getGithubAppInstallUrl(projectId: string): Promise<{ url: string | null }> {
  return api<{ url: string | null }>(`/api/github/app-install-url?projectId=${encodeURIComponent(projectId)}`);
}

export async function listGithubInstallationRepos(installationId: string): Promise<{ repos: GithubRepo[] }> {
  return api<{ repos: GithubRepo[] }>(`/api/github/installations/${installationId}/repos`);
}

export async function findGithubInstallationByOwner(
  owner: string
): Promise<{ installation: { id: string; accountLogin: string } | null }> {
  return api<{ installation: { id: string; accountLogin: string } | null }>(
    `/api/github/installation-by-owner?owner=${encodeURIComponent(owner)}`
  );
}

export async function getGithubIntegration(projectId: string): Promise<GithubIntegration | null> {
  return api<GithubIntegration | null>(`/api/github/integrations/${projectId}`);
}

export async function createGithubIntegration(data: {
  projectId: string;
  installationId: string;
  devRepo?: { id: string | number; fullName: string; defaultBranch?: string } | null;
  testRepo: { id: string | number; fullName: string; defaultBranch?: string };
}): Promise<GithubIntegration> {
  return api<GithubIntegration>("/api/github/integrations", { method: "POST", body: data });
}

export async function deleteGithubIntegration(projectId: string): Promise<void> {
  await api(`/api/github/integrations/${projectId}`, { method: "DELETE" });
}

export async function rescanGithubSuites(projectId: string, ref = "main"): Promise<{ ref: string; count: number }> {
  return api<{ ref: string; count: number }>(
    `/api/github/integrations/${projectId}/suites/rescan`,
    { method: "POST", body: { ref } }
  );
}

export async function listGithubSuites(
  projectId: string,
  ref = "main"
): Promise<{ ref: string; suites: GithubDiscoveredSuite[] }> {
  return api<{ ref: string; suites: GithubDiscoveredSuite[] }>(
    `/api/github/integrations/${projectId}/suites?ref=${encodeURIComponent(ref)}`
  );
}

export async function createGithubSchedule(
  projectId: string,
  data: {
    name: string;
    triggerType: "cron" | "pr";
    cronExpression?: string;
    scheduleTimezone?: string | null;
    testRepoRef?: string;
    suiteMode: "fixed" | "dynamic";
    discoveredSuiteIds?: string[];
    runAllTests?: boolean;
    runAsUserId?: string | null;
    environmentId?: string | null;
  }
): Promise<GithubSchedule> {
  return api<GithubSchedule>(`/api/github/integrations/${projectId}/schedules`, {
    method: "POST",
    body: data,
  });
}

export async function updateGithubSchedule(
  projectId: string,
  scheduleId: string,
  data: Partial<{
    name: string;
    cronExpression: string;
    scheduleTimezone: string | null;
    discoveredSuiteIds: string[];
    runAllTests: boolean;
    testRepoRef: string;
    enabled: boolean;
    runAsUserId: string | null;
    environmentId: string | null;
  }>
): Promise<GithubSchedule> {
  return api<GithubSchedule>(`/api/github/integrations/${projectId}/schedules/${scheduleId}`, {
    method: "PATCH",
    body: data,
  });
}

export async function deleteGithubSchedule(projectId: string, scheduleId: string): Promise<void> {
  await api(`/api/github/integrations/${projectId}/schedules/${scheduleId}`, { method: "DELETE" });
}

export interface GithubScheduleRun {
  id: string;
  triggerSource: "manual" | "automated";
  suiteMode: "fixed" | "dynamic";
  prNumber: number | null;
  headSha: string | null;
  executionRunId: string | null;
  status: "pending" | "running" | "recorded" | "completed" | "failed" | "cancelled" | "no_suites";
  selectedTests: { suites: { id: string; key: string; label: string }[] } | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  githubActionsRunId: string | null;
  githubActionsRunUrl: string | null;
  githubActionsRunNumber: number | null;
}

export async function triggerScheduleNow(
  projectId: string,
  scheduleId: string
): Promise<{
  ok: boolean;
  runLogId: string | null;
  githubActionsRunUrl?: string | null;
  githubActionsRunId?: string | null;
}> {
  return api(
    `/api/github/integrations/${projectId}/schedules/${scheduleId}/trigger`,
    { method: "POST" }
  );
}

export async function setupScheduleWorkflow(
  projectId: string,
  scheduleId: string
): Promise<{ schedule: GithubSchedule; workflowFilePath: string }> {
  return api(
    `/api/github/integrations/${projectId}/schedules/${scheduleId}/setup-workflow`,
    { method: "POST" }
  );
}

export async function resyncScheduleWorkflow(
  projectId: string,
  scheduleId: string
): Promise<{ schedule: GithubSchedule; workflowFound: boolean }> {
  return api(
    `/api/github/integrations/${projectId}/schedules/${scheduleId}/resync-workflow`,
    { method: "POST" }
  );
}

export async function retryScheduleSecretConfig(
  projectId: string,
  scheduleId: string
): Promise<{ schedule: GithubSchedule }> {
  return api(
    `/api/github/integrations/${projectId}/schedules/${scheduleId}/retry-secret-config`,
    { method: "POST" }
  );
}

export async function getScheduleRunHistory(
  projectId: string,
  scheduleId: string,
  limit = 20
): Promise<{ runs: GithubScheduleRun[] }> {
  return api<{ runs: GithubScheduleRun[] }>(
    `/api/github/integrations/${projectId}/schedules/${scheduleId}/runs?limit=${limit}`
  );
}

export async function checkGithubSetup(
  projectId: string
): Promise<{ configured: boolean; testRepo: string }> {
  return api<{ configured: boolean; testRepo: string }>(
    `/api/github/integrations/${projectId}/setup-check`
  );
}

export async function raiseGithubSetupPr(
  projectId: string
): Promise<{ prUrl: string; prNumber: number }> {
  return api<{ prUrl: string; prNumber: number }>(
    `/api/github/integrations/${projectId}/raise-setup-pr`,
    { method: "POST" }
  );
}
