"use client";

import Link from "next/link";
import { use, useCallback, useEffect, useMemo, useState } from "react";
import {
  Banner,
  Button,
  Card,
  CardBody,
  EmptyStateBlock,
  Field,
  FieldHint,
  FieldLabel,
  Input,
  Select,
  SelectorGroup,
  StatusChip,
} from "@/components/ui";
import {
  ApiError,
  checkGithubSetup,
  createGithubSchedule,
  deleteGithubSchedule,
  getGithubIntegration,
  getScheduleRunHistory,
  listGithubSuites,
  listProjectEnvironments,
  listProjectMembers,
  raiseGithubSetupPr,
  rescanGithubSuites,
  resyncScheduleWorkflow,
  retryScheduleSecretConfig,
  setupScheduleWorkflow,
  triggerScheduleNow,
  updateGithubSchedule,
  type GithubDiscoveredSuite,
  type GithubIntegration,
  type GithubSchedule,
  type GithubScheduleRun,
  type ProjectEnvironment,
} from "@/lib/api";
import {
  COMMON_TIMEZONES,
  DAY_LABELS,
  defaultSpec,
  describeCron,
  specToCron,
  type Frequency,
  type ScheduleSpec,
} from "@/lib/scheduleCron";

type ProjectMember = { userId: string; email: string; name: string; role: string };

type AppPermissionError = {
  message: string;
  appPermissionsUrl?: string;
  manualSetup?: { filePath: string; fileContent: string; repo: string };
};

export default function ScheduledRunsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = use(params);
  const [integration, setIntegration] = useState<GithubIntegration | null | undefined>(undefined);
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [environments, setEnvironments] = useState<ProjectEnvironment[]>([]);
  const [setupConfigured, setSetupConfigured] = useState<boolean | null>(null);
  const [prUrl, setPrUrl] = useState<string | null>(null);
  const [raisingPr, setRaisingPr] = useState(false);
  const [setupDismissed, setSetupDismissed] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [appPermissionError, setAppPermissionError] = useState<AppPermissionError | null>(null);

  const reload = useCallback(async () => {
    setLoadError("");
    try {
      const [i, m, envRes] = await Promise.all([
        getGithubIntegration(projectId),
        listProjectMembers(projectId),
        // Environments are non-critical for the page; an error here
        // shouldn't blank out the integration view.
        listProjectEnvironments(projectId).catch(() => ({ environments: [], canManage: false })),
      ]);
      setIntegration(i);
      setMembers(m);
      setEnvironments(envRes.environments);
      if (i) {
        try {
          const check = await checkGithubSetup(projectId);
          setSetupConfigured(check.configured);
        } catch {
          // Setup check is non-critical — don't fail the whole page
          setSetupConfigured(null);
        }
      }
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load GitHub state");
      setIntegration(null);
    }
  }, [projectId]);

  useEffect(() => { void reload(); }, [reload]);

  async function handleRaisePr() {
    setRaisingPr(true);
    setError("");
    setAppPermissionError(null);
    try {
      const result = await raiseGithubSetupPr(projectId);
      setPrUrl(result.prUrl);
      setSetupConfigured(false);
    } catch (err) {
      if (err instanceof ApiError && err.data?.code === "GH_APP_INSUFFICIENT_PERMISSIONS") {
        const manual = err.data.manualSetup as AppPermissionError["manualSetup"];
        setAppPermissionError({
          message: typeof err.data.detail === "string" ? err.data.detail : err.message,
          appPermissionsUrl: typeof err.data.appPermissionsUrl === "string" ? err.data.appPermissionsUrl : undefined,
          manualSetup: manual,
        });
      } else {
        setError(err instanceof Error ? err.message : "Failed to raise PR");
      }
    } finally {
      setRaisingPr(false);
    }
  }

  async function copyManualConfig() {
    if (!appPermissionError?.manualSetup) return;
    try {
      await navigator.clipboard.writeText(appPermissionError.manualSetup.fileContent);
    } catch {
      // Clipboard write can fail (no permission / non-HTTPS); silently ignore.
    }
  }

  if (integration === undefined) {
    return (
      <div className="tesbo-page-content max-w-4xl">
        <div className="h-6 w-48 animate-pulse rounded bg-[var(--glass-bg-subtle)]" />
      </div>
    );
  }

  return (
    <div className="tesbo-page-content max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-[var(--foreground)]">Scheduled Runs</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Define when Tesbo Grid should run your tests automatically — on a cron schedule or on every pull request.
        </p>
      </div>

      {error && <Banner tone="error" description={error} />}

      {loadError ? (
        <Card>
          <CardBody className="p-8">
            <Banner tone="error" description={loadError} />
            <div className="mt-4 flex justify-center">
              <Button onClick={() => void reload()}>Retry</Button>
            </div>
          </CardBody>
        </Card>
      ) : !integration ? (
        <Card>
          <CardBody className="p-8">
            <EmptyStateBlock
              title="GitHub not connected"
              description="Connect your GitHub repositories in Settings before creating scheduled runs."
            />
            <div className="mt-4 flex justify-center">
              <Link href={`/projects/${projectId}/settings#github`}>
                <Button>Go to Settings → GitHub</Button>
              </Link>
            </div>
          </CardBody>
        </Card>
      ) : (
        <>
          {/* Repo info bar */}
          <Card>
            <CardBody className="p-4">
              <div className="flex flex-wrap items-center gap-6 text-sm">
                <div>
                  <span className="text-xs uppercase tracking-wide text-[var(--muted)]">Dev repo</span>
                  {integration.devRepo ? (
                    <p className="font-medium text-[var(--foreground)]">{integration.devRepo.fullName}</p>
                  ) : (
                    <p className="text-sm text-[var(--muted)] italic">Not connected — PR triggers unavailable</p>
                  )}
                </div>
                <div>
                  <span className="text-xs uppercase tracking-wide text-[var(--muted)]">Test repo</span>
                  <p className="font-medium text-[var(--foreground)]">{integration.testRepo.fullName}</p>
                </div>
                <div className="ml-auto flex items-center gap-2">
                  <StatusChip tone="success">GitHub connected</StatusChip>
                  {integration.canManage === false && (
                    <StatusChip tone="neutral">View only</StatusChip>
                  )}
                </div>
              </div>
            </CardBody>
          </Card>

          {/* GitHub App permissions error banner */}
          {appPermissionError && (
            <Banner tone="error">
              <div className="space-y-3">
                <div>
                  <p className="text-sm font-semibold text-[var(--foreground)]">
                    GitHub App can't open a pull request on this repository
                  </p>
                  <p className="mt-1 text-sm text-[var(--muted)]">
                    {appPermissionError.message}
                  </p>
                </div>
                <ul className="text-xs text-[var(--muted)] list-disc pl-5 space-y-0.5">
                  <li><strong>Contents</strong>: Read and write</li>
                  <li><strong>Pull requests</strong>: Read and write</li>
                  <li><strong>Metadata</strong>: Read (already required)</li>
                </ul>
                <div className="flex flex-wrap gap-2">
                  {appPermissionError.appPermissionsUrl && (
                    <a href={appPermissionError.appPermissionsUrl} target="_blank" rel="noopener noreferrer">
                      <Button variant="secondary" size="sm">Update App permissions →</Button>
                    </a>
                  )}
                  <Button variant="secondary" size="sm" onClick={() => void handleRaisePr()} disabled={raisingPr}>
                    {raisingPr ? "Retrying…" : "Try again"}
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => setAppPermissionError(null)}>
                    Dismiss
                  </Button>
                </div>
                {appPermissionError.manualSetup && (
                  <details className="mt-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-primary)] p-3">
                    <summary className="cursor-pointer text-xs font-semibold text-[var(--foreground)]">
                      Or set it up manually
                    </summary>
                    <div className="mt-2 space-y-2 text-xs text-[var(--muted)]">
                      <p>
                        Create a file at{" "}
                        <code className="bg-[var(--glass-bg-subtle)] px-1 rounded">
                          {appPermissionError.manualSetup.filePath}
                        </code>{" "}
                        in the root of{" "}
                        <code className="bg-[var(--glass-bg-subtle)] px-1 rounded">
                          {appPermissionError.manualSetup.repo}
                        </code>{" "}
                        with the following content, then refresh this page:
                      </p>
                      <pre className="overflow-x-auto rounded bg-[var(--glass-bg-subtle)] p-2 text-[11px] leading-relaxed text-[var(--foreground)]">
{appPermissionError.manualSetup.fileContent}
                      </pre>
                      <Button variant="secondary" size="sm" onClick={() => void copyManualConfig()}>
                        Copy config
                      </Button>
                    </div>
                  </details>
                )}
              </div>
            </Banner>
          )}

          {/* Setup check banner */}
          {setupConfigured === false && !setupDismissed && !appPermissionError && (
            <Banner tone="info">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-[var(--foreground)]">
                    Test repo configuration missing
                  </p>
                  <p className="mt-0.5 text-sm text-[var(--muted)]">
                    {prUrl
                      ? "Tesbo Grid has opened a PR to add the required config to your test repo."
                      : `Your test repo (${integration.testRepo.fullName}) doesn't have a .tesbo-grid.json config yet.`}
                  </p>
                  {prUrl && (
                    <a
                      href={prUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-1 inline-block text-sm font-medium underline text-[var(--brand-primary)]"
                    >
                      View PR on GitHub →
                    </a>
                  )}
                </div>
                {!prUrl && (
                  <div className="flex flex-wrap gap-2">
                    <Link href={`/projects/${projectId}/integration`}>
                      <Button variant="secondary">Setup manually</Button>
                    </Link>
                    <Button onClick={handleRaisePr} disabled={raisingPr}>
                      {raisingPr ? "Raising PR…" : "Tesbo Grid will fix it"}
                    </Button>
                    <button
                      onClick={() => setSetupDismissed(true)}
                      className="text-xs text-[var(--muted)] underline self-center"
                    >
                      Dismiss
                    </button>
                  </div>
                )}
                {prUrl && (
                  <button
                    onClick={() => setSetupDismissed(true)}
                    className="text-xs text-[var(--muted)] underline self-center"
                  >
                    Dismiss
                  </button>
                )}
              </div>
            </Banner>
          )}

          {/* Schedules */}
          <Card>
            <CardBody className="p-6">
              <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                <div>
                  <h2 className="text-base font-semibold text-[var(--foreground)]">Schedules</h2>
                  <p className="text-xs text-[var(--muted)]">
                    Each schedule defines a trigger (cron or PR) and which tests to run.
                  </p>
                </div>
                {!showAddForm && integration.canManage !== false && (
                  <Button onClick={() => setShowAddForm(true)}>+ Add schedule</Button>
                )}
              </div>

              {/* Inline "Add schedule" form */}
              {showAddForm && (
                <div className="mb-6 rounded-xl border border-[var(--brand-border)] bg-[var(--brand-soft)] p-5">
                  <h3 className="text-sm font-semibold text-[var(--foreground)] mb-4">New schedule</h3>
                  <AddScheduleForm
                    projectId={projectId}
                    integration={integration}
                    members={members}
                    environments={environments}
                    onCancel={() => setShowAddForm(false)}
                    onCreated={() => { setShowAddForm(false); void reload(); }}
                  />
                </div>
              )}

              {integration.schedules.length === 0 && !showAddForm ? (
                <EmptyStateBlock
                  title="No schedules yet"
                  description={
                    integration.canManage === false
                      ? "No schedules have been configured for this project. Ask a project admin to add one."
                      : "Add a cron schedule to run tests on a fixed cadence, or a PR trigger to run tests on every pull request."
                  }
                />
              ) : (
                <ul className="space-y-2">
                  {integration.schedules.map((s) => (
                    <ScheduleRow
                      key={s.id}
                      projectId={projectId}
                      schedule={s}
                      members={members}
                      canManage={integration.canManage !== false}
                      testRepoFullName={integration.testRepo.fullName}
                      onChange={reload}
                    />
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        </>
      )}
    </div>
  );
}

// ── Add Schedule Form (inline, not a modal) ──────────────────────────────────

function AddScheduleForm({
  projectId,
  integration,
  members,
  environments,
  onCancel,
  onCreated,
}: {
  projectId: string;
  integration: GithubIntegration;
  members: ProjectMember[];
  environments: ProjectEnvironment[];
  onCancel: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [triggerType, setTriggerType] = useState<"cron" | "pr">("pr");
  const [scheduleSpec, setScheduleSpec] = useState<ScheduleSpec>(() => defaultSpec());
  const [advancedCron, setAdvancedCron] = useState<string | null>(null);
  const [testRepoRef, setTestRepoRef] = useState("main");
  const [suiteMode, setSuiteMode] = useState<"fixed" | "dynamic">("fixed");
  const [suites, setSuites] = useState<GithubDiscoveredSuite[] | null>(null);
  const [selectedSuiteIds, setSelectedSuiteIds] = useState<string[]>([]);
  const [runAllTests, setRunAllTests] = useState(false);
  const [suiteSearch, setSuiteSearch] = useState("");
  const [runAsUserId, setRunAsUserId] = useState("");
  const [environmentId, setEnvironmentId] = useState(
    environments.find((e) => e.isDefault)?.id || ""
  );
  const [scanning, setScanning] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const hasDevRepo = Boolean(integration.devRepo);
  const dynamicAvailable = hasDevRepo && Boolean(integration.aiKey);

  const loadSuites = useCallback(async (ref: string) => {
    setScanning(true);
    setError("");
    try {
      const res = await listGithubSuites(projectId, ref);
      setSuites(res.suites);
      if (res.suites.length === 0) {
        const rescan = await rescanGithubSuites(projectId, ref);
        if (rescan.count > 0) {
          const refreshed = await listGithubSuites(projectId, ref);
          setSuites(refreshed.suites);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load suites");
    } finally {
      setScanning(false);
    }
  }, [projectId]);

  useEffect(() => { void loadSuites(testRepoRef); }, [loadSuites, testRepoRef]);

  async function handleRescan() {
    setScanning(true);
    setError("");
    try {
      await rescanGithubSuites(projectId, testRepoRef);
      const refreshed = await listGithubSuites(projectId, testRepoRef);
      setSuites(refreshed.suites);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Rescan failed");
    } finally {
      setScanning(false);
    }
  }

  // Resolve the cron expression to submit. In "calendar" mode we generate
  // from the picker; in "advanced" mode the user typed a raw cron string.
  const resolvedCron =
    advancedCron !== null ? advancedCron.trim() : (specToCron(scheduleSpec) || "");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!name.trim()) { setError("Name is required"); return; }
    if (triggerType === "cron" && !resolvedCron) {
      setError(advancedCron !== null
        ? "Cron expression is required"
        : "Pick at least one day for the weekly schedule");
      return;
    }
    if (suiteMode === "fixed" && !runAllTests && selectedSuiteIds.length === 0) {
      setError("Pick at least one spec file or enable 'Run all tests'");
      return;
    }
    setSubmitting(true);
    try {
      await createGithubSchedule(projectId, {
        name: name.trim(),
        triggerType,
        cronExpression: triggerType === "cron" ? resolvedCron : undefined,
        scheduleTimezone:
          triggerType === "cron" && advancedCron === null ? scheduleSpec.timezone : null,
        testRepoRef,
        suiteMode,
        discoveredSuiteIds: suiteMode === "fixed" && !runAllTests ? selectedSuiteIds : undefined,
        runAllTests: suiteMode === "fixed" ? runAllTests : undefined,
        runAsUserId: runAsUserId || null,
        environmentId: environmentId || null,
      });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create schedule");
    } finally {
      setSubmitting(false);
    }
  }

  const suiteOptions = useMemo(() => suites || [], [suites]);
  const filteredSuiteOptions = useMemo(() => {
    const q = suiteSearch.trim().toLowerCase();
    if (!q) return suiteOptions;
    return suiteOptions.filter((s) => {
      const path = typeof s.metadata?.path === "string" ? s.metadata.path : "";
      return s.label.toLowerCase().includes(q) || path.toLowerCase().includes(q);
    });
  }, [suiteOptions, suiteSearch]);

  function toggleSuite(id: string) {
    setSelectedSuiteIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {error && <Banner tone="error" description={error} />}

      <div className="grid gap-4 sm:grid-cols-2">
        {/* Name */}
        <Field className="sm:col-span-2">
          <FieldLabel htmlFor="schedName">Schedule name</FieldLabel>
          <Input
            id="schedName"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Nightly regression"
            disabled={submitting}
            autoFocus
          />
        </Field>

        {/* Assigned member */}
        <Field>
          <FieldLabel htmlFor="schedUser">Assigned member</FieldLabel>
          <Select
            id="schedUser"
            value={runAsUserId}
            onChange={(e) => setRunAsUserId(e.target.value)}
            disabled={submitting}
          >
            <option value="">— Unassigned</option>
            {members.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.name || m.email}
              </option>
            ))}
          </Select>
          <FieldHint>The team member responsible for this schedule.</FieldHint>
        </Field>

        {/* Branch */}
        <Field>
          <FieldLabel htmlFor="schedRef">Test repo branch</FieldLabel>
          <Input
            id="schedRef"
            value={testRepoRef}
            onChange={(e) => setTestRepoRef(e.target.value)}
            disabled={submitting}
            placeholder="main"
          />
          <FieldHint>Suites are discovered on this branch of {integration.testRepo.fullName}.</FieldHint>
        </Field>
      </div>

      {/* Trigger */}
      <SelectorGroup<"cron" | "pr">
        label="When should this run?"
        value={triggerType}
        onChange={setTriggerType}
        options={[
          {
            id: "pr",
            label: hasDevRepo ? "On every PR" : "On every PR (requires dev repo)",
            description: hasDevRepo
              ? "Tests run for each push to an open pull request."
              : "Connect a development repo in Settings → GitHub to enable PR triggers.",
            disabled: !hasDevRepo,
          },
          { id: "cron", label: "Fixed schedule", description: "Tests run on a cron expression (UTC)." },
        ]}
      />

      {triggerType === "cron" && (
        <SchedulePicker
          spec={scheduleSpec}
          onChange={setScheduleSpec}
          advancedCron={advancedCron}
          onAdvancedCronChange={setAdvancedCron}
          disabled={submitting}
        />
      )}

      {/* AUT environment */}
      <Field>
        <FieldLabel htmlFor="schedEnv">Run against environment</FieldLabel>
        <Select
          id="schedEnv"
          value={environmentId}
          onChange={(e) => setEnvironmentId(e.target.value)}
          disabled={submitting}
        >
          <option value="">— None (tests must work without PLAYWRIGHT_BASE_URL)</option>
          {environments.map((env) => (
            <option key={env.id} value={env.id}>
              {env.name}{env.baseUrl ? ` — ${env.baseUrl}` : ""}{env.isDefault ? " (default)" : ""}
            </option>
          ))}
        </Select>
        <FieldHint>
          {environments.length === 0 ? (
            <>
              No environments defined yet. Add one under{" "}
              <Link className="underline" href={`/projects/${projectId}/settings`}>Settings → Environments</Link>{" "}
              so tests know which URL to hit.
            </>
          ) : (
            <>The selected environment's base URL is injected as <code>PLAYWRIGHT_BASE_URL</code> at run time.</>
          )}
        </FieldHint>
      </Field>

      {/* Suite mode */}
      <SelectorGroup<"fixed" | "dynamic">
        label="Which tests should run?"
        value={suiteMode}
        onChange={setSuiteMode}
        options={[
          {
            id: "fixed",
            label: "Selected suite",
            description: "Pick from the suites Tesbo discovered in the test repo.",
          },
          {
            id: "dynamic",
            label: "Dynamic (PR only)",
            description: "Tesbo's AI picks suites based on what changed in the PR.",
            disabled: true,
            tooltip: "Coming soon",
          },
        ]}
      />

      {suiteMode === "dynamic" && !dynamicAvailable && (
        <Banner tone="info">
          <p className="text-sm text-[var(--muted)]">
            Dynamic suite selection requires an AI key. Allocate one in{" "}
            <Link className="underline" href={`/projects/${projectId}/settings`}>Settings</Link>.
          </p>
        </Banner>
      )}

      {suiteMode === "dynamic" && dynamicAvailable && triggerType === "cron" && (
        <Banner tone="warning" description="Dynamic mode only works with PR triggers — change the trigger to On every PR." />
      )}

      {suiteMode === "fixed" && (
        <Field>
          <FieldLabel htmlFor="schedSuite">Test files</FieldLabel>
          <div className="rounded-md border border-[var(--brand-border)] bg-[var(--glass-bg-subtle)] p-3 space-y-2">
            <label className="flex items-center gap-2 text-sm font-medium cursor-pointer">
              <input
                type="checkbox"
                checked={runAllTests}
                onChange={(e) => setRunAllTests(e.target.checked)}
                disabled={submitting}
              />
              Run all tests
              <span className="text-xs text-[var(--muted)] font-normal">
                (runs every spec file in the repo)
              </span>
            </label>

            {!runAllTests && (
              <>
                <div className="flex gap-2">
                  <Input
                    id="schedSuiteSearch"
                    value={suiteSearch}
                    onChange={(e) => setSuiteSearch(e.target.value)}
                    placeholder="Search files…"
                    disabled={submitting || scanning}
                    className="flex-1"
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={handleRescan}
                    disabled={scanning || submitting}
                  >
                    {scanning ? "Scanning…" : "Re-scan"}
                  </Button>
                </div>
                <div className="max-h-64 overflow-y-auto rounded border border-[var(--brand-border)] bg-[var(--background)]">
                  {scanning && suiteOptions.length === 0 ? (
                    <div className="p-3 text-sm text-[var(--muted)]">Scanning repo…</div>
                  ) : filteredSuiteOptions.length === 0 ? (
                    <div className="p-3 text-sm text-[var(--muted)]">
                      {suiteOptions.length === 0
                        ? "No spec files found on this branch."
                        : "No files match your search."}
                    </div>
                  ) : (
                    <ul className="divide-y divide-[var(--brand-border)]">
                      {filteredSuiteOptions.map((s) => {
                        const path = typeof s.metadata?.path === "string" ? s.metadata.path : "";
                        const checked = selectedSuiteIds.includes(s.id);
                        return (
                          <li key={s.id}>
                            <label className="flex items-start gap-2 px-3 py-2 cursor-pointer hover:bg-[var(--glass-bg-subtle)]">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleSuite(s.id)}
                                disabled={submitting}
                                className="mt-0.5"
                              />
                              <span className="flex-1 min-w-0">
                                <span className="block text-sm font-medium truncate">{s.label}</span>
                                {path && path !== s.label && (
                                  <span className="block text-xs text-[var(--muted)] truncate">{path}</span>
                                )}
                              </span>
                            </label>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              </>
            )}
          </div>
          <FieldHint>
            {runAllTests
              ? `Will run every spec file discovered on `
              : `${selectedSuiteIds.length} of ${suiteOptions.length} file(s) selected on `}
            <code>{testRepoRef}</code>. Click Re-scan if you just pushed new tests.
          </FieldHint>
        </Field>
      )}

      <div className="flex justify-end gap-2 pt-1 border-t border-[var(--brand-border)]">
        <Button type="button" variant="secondary" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" disabled={submitting}>
          {submitting ? "Creating…" : "Create schedule"}
        </Button>
      </div>
    </form>
  );
}

// ── Schedule Row ─────────────────────────────────────────────────────────────

const STATUS_TONE: Record<string, "success" | "error" | "warning" | "neutral" | "info"> = {
  completed: "success",
  failed: "error",
  running: "info",
  pending: "neutral",
  recorded: "neutral",
  cancelled: "warning",
  no_suites: "warning",
};

function ScheduleRow({
  projectId,
  schedule: scheduleProp,
  members,
  canManage,
  testRepoFullName,
  onChange,
}: {
  projectId: string;
  schedule: GithubSchedule;
  members: ProjectMember[];
  canManage: boolean;
  testRepoFullName: string;
  onChange: () => void;
}) {
  // Local optimistic copy: the setup-workflow endpoint returns the updated
  // schedule, so apply it immediately instead of waiting for the parent's
  // reload — otherwise the PR-created banner and status chip lag (or never
  // appear if the reload returns stale data). Only drop the optimistic
  // value once the canonical prop catches up with a non-null status, so we
  // never flicker back to the pre-setup state.
  const [optimisticSchedule, setOptimisticSchedule] = useState<GithubSchedule | null>(null);
  const schedule = optimisticSchedule ?? scheduleProp;
  useEffect(() => {
    if (scheduleProp.workflowStatus != null) {
      setOptimisticSchedule(null);
    }
  }, [scheduleProp]);

  const [busy, setBusy] = useState(false);
  const [triggering, setTriggering] = useState(false);
  const [settingUpWorkflow, setSettingUpWorkflow] = useState(false);
  const [resyncing, setResyncing] = useState(false);
  const [retryingSecret, setRetryingSecret] = useState(false);
  const [secretRetryError, setSecretRetryError] = useState<string>("");
  const [rowError, setRowError] = useState("");
  const [setupSuccess, setSetupSuccess] = useState<{ prUrl: string; prNumber: number | null } | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [history, setHistory] = useState<GithubScheduleRun[] | null>(null);
  const [historyError, setHistoryError] = useState("");
  const [loadingHistory, setLoadingHistory] = useState(false);

  async function handleSetupWorkflow() {
    setSettingUpWorkflow(true);
    setRowError("");
    setSetupSuccess(null);
    try {
      const result = await setupScheduleWorkflow(projectId, schedule.id);
      setOptimisticSchedule(result.schedule);
      if (result.schedule.setupPrUrl) {
        setSetupSuccess({
          prUrl: result.schedule.setupPrUrl,
          prNumber: result.schedule.setupPrNumber,
        });
      } else {
        setRowError(
          "Setup workflow ran but GitHub didn't return a PR URL. Open the test repo on GitHub to confirm and refresh this page."
        );
      }
      onChange();
    } catch (err) {
      setRowError(err instanceof Error ? err.message : "Failed to set up workflow");
    } finally {
      setSettingUpWorkflow(false);
    }
  }

  async function handleResyncWorkflow() {
    setResyncing(true);
    setRowError("");
    try {
      const result = await resyncScheduleWorkflow(projectId, schedule.id);
      setOptimisticSchedule(result.schedule);
      if (!result.workflowFound) {
        setRowError("Workflow file is still missing on GitHub. Re-merge the PR or run 'Setup workflow' again.");
      }
      onChange();
    } catch (err) {
      setRowError(err instanceof Error ? err.message : "Failed to resync status");
    } finally {
      setResyncing(false);
    }
  }

  async function handleRetrySecretConfig() {
    setRetryingSecret(true);
    setSecretRetryError("");
    try {
      const result = await retryScheduleSecretConfig(projectId, schedule.id);
      setOptimisticSchedule(result.schedule);
      onChange();
    } catch (err) {
      // Backend returns a `hint` on the JSON body (e.g. "re-authorize the App")
      // so the user knows whether to retry or add the secret manually.
      const hint = err instanceof ApiError ? (err.data.hint as string | undefined) : undefined;
      const baseMessage = err instanceof Error ? err.message : "Failed to configure repo secret";
      setSecretRetryError(hint ? `${baseMessage} — ${hint}` : baseMessage);
    } finally {
      setRetryingSecret(false);
    }
  }

  const isDynamic = schedule.suiteMode === "dynamic";
  const assignedMember = members.find((m) => m.userId === schedule.runAsUserId);

  async function toggleEnabled() {
    setBusy(true);
    try {
      await updateGithubSchedule(projectId, schedule.id, { enabled: !schedule.enabled });
      onChange();
    } finally { setBusy(false); }
  }

  async function remove() {
    setBusy(true);
    try {
      await deleteGithubSchedule(projectId, schedule.id);
      onChange();
    } finally { setBusy(false); }
  }

  async function handleRunNow() {
    setTriggering(true);
    try {
      const result = await triggerScheduleNow(projectId, schedule.id);
      // GitHub Actions handles the actual execution + log streaming. Open the
      // run URL in a new tab so the user can follow logs live.
      if (result.githubActionsRunUrl) {
        window.open(result.githubActionsRunUrl, "_blank", "noopener,noreferrer");
      }
      setShowHistory(true);
      await fetchHistory();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to trigger run");
    } finally {
      setTriggering(false);
    }
  }

  async function fetchHistory() {
    setLoadingHistory(true);
    setHistoryError("");
    try {
      const { runs } = await getScheduleRunHistory(projectId, schedule.id, 20);
      setHistory(runs);
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : "Failed to load history");
    } finally {
      setLoadingHistory(false);
    }
  }

  async function toggleHistory() {
    if (!showHistory && history === null) await fetchHistory();
    setShowHistory((v) => !v);
  }

  const workflowChip = (() => {
    switch (schedule.workflowStatus) {
      case "active":
        return <StatusChip tone="success">Workflow ready</StatusChip>;
      case "pending_workflow_merge":
        return <StatusChip tone="warning">Workflow PR not merged</StatusChip>;
      case "workflow_missing":
        return <StatusChip tone="error">Workflow file missing</StatusChip>;
      case "error":
        return <StatusChip tone="error">Workflow error</StatusChip>;
      default:
        // null/unknown — most likely a schedule created before Phase 1, or a
        // failed Phase 1 PR creation. Either way, no usable workflow yet.
        return <StatusChip tone="warning">Workflow not set up</StatusChip>;
    }
  })();

  const cannotRunReason = (() => {
    if (isDynamic) return "Only available for fixed-suite schedules";
    if (schedule.workflowStatus === "active") return "Trigger this schedule immediately";
    if (schedule.workflowStatus === "pending_workflow_merge")
      return "Merge the Tesbo Grid setup PR first to enable runs";
    if (schedule.workflowStatus === "workflow_missing")
      return "Workflow file is missing — click 'Setup workflow' to re-open the PR";
    if (schedule.workflowStatus === "error")
      return "Workflow setup errored — click 'Setup workflow' to retry";
    return "No workflow file yet — click 'Setup workflow' to open the setup PR";
  })();
  const runDisabled = isDynamic || schedule.workflowStatus !== "active";

  // A schedule needs the recovery flow if it has no workflow file path, or
  // if its current state suggests the setup didn't finish.
  const needsSetup =
    !schedule.workflowFilePath ||
    schedule.workflowStatus === "workflow_missing" ||
    schedule.workflowStatus === "error" ||
    schedule.workflowStatus == null;
  const canResync =
    !needsSetup && schedule.workflowStatus !== "active";

  return (
    <li className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-secondary)]">
      <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-4">
        {/* Left: schedule info */}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-[var(--foreground)]">{schedule.name}</span>
            <StatusChip tone={schedule.enabled ? "info" : "neutral"}>
              {schedule.enabled ? "Enabled" : "Paused"}
            </StatusChip>
            {workflowChip}
          </div>
          {rowError && (
            <p className="mt-1 text-xs text-[var(--error,#c0392b)]">{rowError}</p>
          )}
          {setupSuccess && (
            <div className="mt-2">
              <Banner tone="success">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-[var(--foreground)]">
                      ✅ Setup PR created on GitHub
                    </p>
                    <p className="mt-0.5 text-sm text-[var(--muted)]">
                      Review and merge the PR to activate this schedule.
                    </p>
                    <a
                      href={setupSuccess.prUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-1 inline-block text-sm font-medium underline text-[var(--brand-primary)]"
                    >
                      {setupSuccess.prNumber
                        ? `Open PR #${setupSuccess.prNumber} on GitHub →`
                        : "Open PR on GitHub →"}
                    </a>
                  </div>
                  <button
                    onClick={() => setSetupSuccess(null)}
                    className="text-xs text-[var(--muted)] underline self-center"
                  >
                    Dismiss
                  </button>
                </div>
              </Banner>
            </div>
          )}
          {!setupSuccess && schedule.workflowStatus === "pending_workflow_merge" && schedule.setupPrUrl && (
            <div className="mt-2">
              <Banner tone="info">
                <div>
                  <p className="text-sm font-semibold text-[var(--foreground)]">
                    Setup PR created — merge to activate
                  </p>
                  <p className="mt-0.5 text-sm text-[var(--muted)]">
                    Tesbo Grid opened a pull request adding{" "}
                    <code className="bg-[var(--glass-bg-subtle)] px-1 rounded">{schedule.workflowFilePath}</code>.
                    Merge it to enable scheduled runs and the Run-now button.
                  </p>
                  <a
                    href={schedule.setupPrUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-1 inline-block text-sm font-medium underline text-[var(--brand-primary)]"
                  >
                    Review PR #{schedule.setupPrNumber} →
                  </a>
                </div>
              </Banner>
            </div>
          )}
          {/* Persistent alert for the TESBO_GRID_API_KEY repo secret.
              Independent of workflowStatus because the missing-secret state
              survives PR merge — the CLI step inside Actions exits with
              "API key required" until the secret is set on the repo. */}
          {schedule.workflowFilePath && !schedule.repoSecretConfigured && (
            <div className="mt-2">
              <Banner tone="warning">
                <div>
                  <p className="text-sm font-semibold text-[var(--foreground)]">
                    Repo secret <code className="bg-[var(--glass-bg-subtle)] px-1 rounded">TESBO_GRID_API_KEY</code> is not set
                  </p>
                  <p className="mt-0.5 text-sm text-[var(--muted)]">
                    The workflow reads this secret to authenticate the CLI. Until it&apos;s set on{" "}
                    <code className="bg-[var(--glass-bg-subtle)] px-1 rounded">{testRepoFullName}</code>,
                    every run will fail with <em>&quot;API key required&quot;</em>.
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {canManage && (
                      <Button
                        size="sm"
                        onClick={handleRetrySecretConfig}
                        disabled={retryingSecret}
                      >
                        {retryingSecret ? "Configuring…" : "Re-try secret setup"}
                      </Button>
                    )}
                    <a
                      href={`https://github.com/${testRepoFullName}/settings/secrets/actions/new?name=TESBO_GRID_API_KEY`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm font-medium underline text-[var(--brand-primary)]"
                    >
                      Add it manually on GitHub →
                    </a>
                    <Link
                      href={`/projects/${projectId}/integration#github-scheduled-runs`}
                      className="text-sm text-[var(--muted)] underline"
                    >
                      How to fix
                    </Link>
                  </div>
                  {secretRetryError && (
                    <p className="mt-2 text-xs text-[var(--error,#c0392b)]">{secretRetryError}</p>
                  )}
                </div>
              </Banner>
            </div>
          )}
          {schedule.workflowStatus === "workflow_missing" && (
            <p className="mt-1 text-xs text-[var(--muted)]">
              The workflow file{" "}
              <code className="bg-[var(--glass-bg-subtle)] px-1 rounded">{schedule.workflowFilePath}</code>{" "}
              was removed from the repo. Delete this schedule and create a new one to restore it.
            </p>
          )}
          {schedule.workflowStatusDetail && schedule.workflowStatus === "error" && (
            <p className="mt-1 text-xs text-[var(--error,#c0392b)]">{schedule.workflowStatusDetail}</p>
          )}

          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--muted)]">
            <span title={schedule.triggerType === "cron" ? `Cron: ${schedule.cronExpression} (UTC)` : undefined}>
              {schedule.triggerType === "cron"
                ? `⏱ ${describeCron(schedule.cronExpression, schedule.scheduleTimezone)}`
                : "⚡ On pull requests"}
            </span>
            <span>
              {schedule.suiteMode === "dynamic"
                ? "✦ AI dynamic selection"
                : schedule.runAllTests
                  ? "📋 All tests"
                  : schedule.selectedSuites && schedule.selectedSuites.length > 0
                    ? `📋 ${schedule.selectedSuites.length === 1
                        ? schedule.selectedSuites[0].label
                        : `${schedule.selectedSuites.length} files`}`
                    : "📋 No files selected"}
            </span>
            <span>🌿 {schedule.testRepoRef}</span>
            {schedule.environmentName && (
              <span title={schedule.environmentBaseUrl || undefined}>
                🌐 {schedule.environmentName}
              </span>
            )}
            {assignedMember && (
              <span>👤 {assignedMember.name || assignedMember.email}</span>
            )}
            {schedule.workflowStatus === "active" && schedule.setupPrUrl && schedule.setupPrNumber && (
              <a
                href={schedule.setupPrUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-[var(--foreground)]"
                title="The pull request that set up this workflow"
              >
                🔧 Set up via PR #{schedule.setupPrNumber}
              </a>
            )}
          </div>
        </div>

        {/* Right: actions */}
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <Button variant="secondary" size="sm" onClick={toggleHistory} disabled={busy}>
            {showHistory ? "Hide history" : "History"}
          </Button>
          {canManage && (
            <>
              {needsSetup && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleSetupWorkflow}
                  disabled={settingUpWorkflow}
                  title="Open a GitHub PR adding the workflow file + push the API key secret"
                >
                  {settingUpWorkflow ? "Setting up…" : "Setup workflow"}
                </Button>
              )}
              {canResync && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleResyncWorkflow}
                  disabled={resyncing}
                  title="Check GitHub directly for the workflow file (use if you merged the PR but the status didn't update)"
                >
                  {resyncing ? "Resyncing…" : "Resync status"}
                </Button>
              )}
              <Button
                variant="secondary"
                size="sm"
                onClick={handleRunNow}
                disabled={busy || triggering || runDisabled}
                title={cannotRunReason}
              >
                {triggering ? "Triggering…" : "Run now"}
              </Button>
              <Button variant="secondary" size="sm" onClick={toggleEnabled} disabled={busy}>
                {schedule.enabled ? "Pause" : "Resume"}
              </Button>

              {confirmDelete ? (
                <>
                  <Button variant="destructive" size="sm" onClick={remove} disabled={busy}>
                    {busy ? "Deleting…" : "Confirm delete"}
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => setConfirmDelete(false)} disabled={busy}>
                    Cancel
                  </Button>
                </>
              ) : (
                <Button variant="secondary" size="sm" onClick={() => setConfirmDelete(true)} disabled={busy}>
                  Delete
                </Button>
              )}
            </>
          )}
        </div>
      </div>

      {showHistory && (
        <div className="border-t border-[var(--border-subtle)] px-4 py-3 space-y-2">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wide">
              Run history
            </span>
            <button
              onClick={fetchHistory}
              disabled={loadingHistory}
              className="text-xs text-[var(--brand-primary)] underline"
            >
              {loadingHistory ? "Refreshing…" : "Refresh"}
            </button>
          </div>
          {historyError && <p className="text-xs text-[var(--error)]">{historyError}</p>}
          {loadingHistory && history === null && (
            <div className="h-4 w-full animate-pulse rounded bg-[var(--glass-bg-subtle)]" />
          )}
          {!loadingHistory && history !== null && history.length === 0 && (
            <p className="text-xs text-[var(--muted)] italic">No runs yet for this schedule.</p>
          )}
          {history && history.map((run) => (
            <RunHistoryRow key={run.id} projectId={projectId} run={run} />
          ))}
        </div>
      )}
    </li>
  );
}

// ── Calendar-style schedule picker ─────────────────────────────────────────

function SchedulePicker({
  spec,
  onChange,
  advancedCron,
  onAdvancedCronChange,
  disabled,
}: {
  spec: ScheduleSpec;
  onChange: (spec: ScheduleSpec) => void;
  advancedCron: string | null;
  onAdvancedCronChange: (cron: string | null) => void;
  disabled?: boolean;
}) {
  const isAdvanced = advancedCron !== null;
  const generatedCron = specToCron(spec);

  function toggleDay(d: number) {
    const has = spec.daysOfWeek.includes(d);
    const next = has ? spec.daysOfWeek.filter((x) => x !== d) : [...spec.daysOfWeek, d];
    onChange({ ...spec, daysOfWeek: next.sort((a, b) => a - b) });
  }

  if (isAdvanced) {
    return (
      <Field>
        <div className="flex items-center justify-between">
          <FieldLabel htmlFor="schedCron">Cron expression (UTC)</FieldLabel>
          <button
            type="button"
            className="text-xs underline text-[var(--muted)]"
            onClick={() => onAdvancedCronChange(null)}
            disabled={disabled}
          >
            Use simple picker
          </button>
        </div>
        <Input
          id="schedCron"
          value={advancedCron ?? ""}
          onChange={(e) => onAdvancedCronChange(e.target.value)}
          disabled={disabled}
          placeholder="0 6 * * *"
        />
        <FieldHint>Standard 5-field cron in UTC, e.g. <code>0 6 * * *</code> (6 am daily).</FieldHint>
      </Field>
    );
  }

  return (
    <div className="rounded-md border border-[var(--brand-border)] bg-[var(--glass-bg-subtle)] p-3 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">When should this run?</span>
        <button
          type="button"
          className="text-xs underline text-[var(--muted)]"
          onClick={() => onAdvancedCronChange(generatedCron || "0 6 * * *")}
          disabled={disabled}
        >
          Use cron expression
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Field>
          <FieldLabel htmlFor="schedFreq">Frequency</FieldLabel>
          <Select
            id="schedFreq"
            value={spec.frequency}
            onChange={(e) => onChange({ ...spec, frequency: e.target.value as Frequency })}
            disabled={disabled}
          >
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
          </Select>
        </Field>
        <Field>
          <FieldLabel htmlFor="schedTime">Time</FieldLabel>
          <Input
            id="schedTime"
            type="time"
            value={spec.time}
            onChange={(e) => onChange({ ...spec, time: e.target.value })}
            disabled={disabled}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="schedTz">Timezone</FieldLabel>
          <Select
            id="schedTz"
            value={spec.timezone}
            onChange={(e) => onChange({ ...spec, timezone: e.target.value })}
            disabled={disabled}
          >
            {/* Pre-fill the user's detected zone if it isn't in the common list */}
            {!COMMON_TIMEZONES.includes(spec.timezone) && (
              <option value={spec.timezone}>{spec.timezone}</option>
            )}
            {COMMON_TIMEZONES.map((tz) => (
              <option key={tz} value={tz}>{tz}</option>
            ))}
          </Select>
        </Field>
      </div>

      {spec.frequency === "weekly" && (
        <Field>
          <FieldLabel>Days of week</FieldLabel>
          <div className="flex flex-wrap gap-1.5">
            {DAY_LABELS.map((label, i) => {
              const active = spec.daysOfWeek.includes(i);
              return (
                <button
                  key={label}
                  type="button"
                  onClick={() => toggleDay(i)}
                  disabled={disabled}
                  className={`px-2.5 py-1 rounded-md text-xs font-medium border transition-colors ${
                    active
                      ? "border-[var(--brand-primary)] bg-[var(--brand-soft)] text-[var(--brand-primary)]"
                      : "border-[var(--brand-border)] bg-[var(--background)] text-[var(--muted)] hover:border-[var(--brand-primary)]"
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </Field>
      )}

      {spec.frequency === "monthly" && (
        <Field>
          <FieldLabel htmlFor="schedDom">Day of month</FieldLabel>
          <Select
            id="schedDom"
            value={String(spec.dayOfMonth)}
            onChange={(e) => onChange({ ...spec, dayOfMonth: Number(e.target.value) })}
            disabled={disabled}
          >
            {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
              <option key={d} value={d}>Day {d}</option>
            ))}
          </Select>
          <FieldHint>Capped at 28 to avoid skipping short months. For "last day", use a cron expression.</FieldHint>
        </Field>
      )}

      <div className="text-xs text-[var(--muted)] border-t border-[var(--brand-border)] pt-2">
        <span className="font-medium text-[var(--foreground)]">Preview:</span>{" "}
        {generatedCron ? describeCron(generatedCron, spec.timezone) : "Pick at least one day"}
        {generatedCron && (
          <span className="ml-2 font-mono">({generatedCron} UTC)</span>
        )}
      </div>
    </div>
  );
}

function RunHistoryRow({ projectId, run }: { projectId: string; run: GithubScheduleRun }) {
  const tone = STATUS_TONE[run.status] ?? "neutral";
  const date = new Date(run.createdAt).toLocaleString(undefined, {
    dateStyle: "short",
    timeStyle: "short",
  });

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-primary)] px-3 py-2 text-xs">
      <span className="text-[var(--muted)] shrink-0 w-32">{date}</span>
      <StatusChip tone={tone}>{run.status.replace("_", " ")}</StatusChip>
      <StatusChip tone={run.triggerSource === "manual" ? "info" : "neutral"}>
        {run.triggerSource === "manual" ? "Manual" : "Automated"}
      </StatusChip>
      <StatusChip tone="neutral">{run.suiteMode === "fixed" ? "Fixed" : "Dynamic"}</StatusChip>
      {run.prNumber && <span className="text-[var(--muted)]">PR #{run.prNumber}</span>}
      <div className="ml-auto flex items-center gap-3 shrink-0">
        {run.githubActionsRunUrl && (
          <a
            href={run.githubActionsRunUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--brand-primary)] underline"
            title="Open this build on GitHub Actions to view its logs"
          >
            {run.githubActionsRunNumber
              ? `Build #${run.githubActionsRunNumber} logs ↗`
              : "Console logs ↗"}
          </a>
        )}
        {run.executionRunId && (
          <Link
            href={`/projects/${projectId}/tesbo-reports/runs/${run.executionRunId}`}
            className="text-[var(--brand-primary)] underline"
          >
            View run →
          </Link>
        )}
      </div>
    </div>
  );
}
