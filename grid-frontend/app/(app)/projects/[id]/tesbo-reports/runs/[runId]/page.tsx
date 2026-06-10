"use client";

import { useEffect, useState, useMemo, useRef, use } from "react";
import Link from "next/link";
import {
  getReportRun,
  getRunClusters,
  getRunCluster,
  getReportTestSessionCommands,
  toggleRunPublicShare,
  type ReportRunDetail,
  type ReportTest,
  type RunCluster,
  type RunClusterDetail,
  type FailureCategoryHint,
  type SeleniumSessionCommand,
} from "@/lib/api";
import {
  Banner,
  Button,
  Card,
  CardBody,
  ErrorBlock,
  MetricCard,
  Modal,
  PageSkeleton,
  StatusChip,
} from "@/components/ui";

type StatusFilter = "all" | "Passed" | "Failed" | "Skipped";
type RunTab = "clusters" | "tests";

const RUN_TONE: Record<string, "success" | "error" | "warning" | "neutral"> = {
  COMPLETED: "success",
  FAILED: "error",
  IN_PROGRESS: "warning",
  CANCELLED: "neutral",
  TIMED_OUT: "neutral",
};

const RUN_LABEL: Record<string, string> = {
  COMPLETED: "Completed",
  FAILED: "Failed",
  IN_PROGRESS: "In Progress",
  CANCELLED: "Cancelled",
  TIMED_OUT: "Timed Out",
};

const TEST_TONE: Record<string, "success" | "error" | "neutral"> = {
  Passed: "success",
  Failed: "error",
  Skipped: "neutral",
};

const TEST_LABEL: Record<string, string> = {
  Passed: "PASS",
  Failed: "FAIL",
  Skipped: "SKIP",
};

const AI_CATEGORY_DISPLAY: Record<string, { tone: "error" | "warning" | "info" | "neutral"; label: string }> = {
  ACTUAL_BUG:         { tone: "error",   label: "Actual bug" },
  FEATURE_CHANGE:     { tone: "warning", label: "Feature change" },
  SCRIPT_ISSUE:       { tone: "warning", label: "Script issue" },
  ENVIRONMENT_ISSUE:  { tone: "info",    label: "Environment issue" },
};

function aiChipProps(test: ReportTest, aiEnabled: boolean): { tone: "error" | "warning" | "info" | "ai" | "neutral"; label: string } {
  if (test.status !== "Failed") return { tone: "neutral", label: "N/A" };
  if (!aiEnabled) return { tone: "neutral", label: "AI key required" };
  if (test.aiAnalysisCategory && AI_CATEGORY_DISPLAY[test.aiAnalysisCategory]) {
    return AI_CATEGORY_DISPLAY[test.aiAnalysisCategory];
  }
  if (test.aiAnalysisStatus === "PENDING") return { tone: "ai", label: "Analyzing…" };
  if (test.aiAnalysisStatus === "NEEDS_REVIEW") return { tone: "warning", label: "Needs review" };
  if (test.aiAnalysisStatus === "ERROR") return { tone: "error", label: "Analysis error" };
  return { tone: "neutral", label: "Not analyzed" };
}

function formatDuration(ms: number | null) {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

function formatTime(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
}

function DistributionRing({ passed, failed, skipped, total }: { passed: number; failed: number; skipped: number; total: number }) {
  if (total === 0) return null;
  const pPct = (passed / total) * 100;
  const fPct = (failed / total) * 100;
  const sPct = (skipped / total) * 100;

  const passEnd = pPct;
  const failEnd = passEnd + fPct;

  const gradient = [
    `var(--success) 0% ${passEnd}%`,
    `var(--error) ${passEnd}% ${failEnd}%`,
    `var(--muted) ${failEnd}% 100%`,
  ].join(", ");

  const passRateText = Math.round((passed / total) * 100);

  return (
    <div
      className="relative h-28 w-28 shrink-0 rounded-full"
      style={{
        background: `conic-gradient(${gradient})`,
      }}
    >
      <div className="absolute inset-3 flex flex-col items-center justify-center rounded-full bg-[var(--surface)]">
        <span className="text-lg font-bold tabular-nums text-[var(--foreground)]">
          {passRateText}%
        </span>
        <span className="text-[10px] text-[var(--muted)]">pass rate</span>
      </div>
    </div>
  );
}

function DistributionBar({ passed, failed, skipped, total }: { passed: number; failed: number; skipped: number; total: number }) {
  if (total === 0) return null;
  return (
    <div className="flex h-2 w-full overflow-hidden rounded-full bg-[var(--surface-tertiary)]">
      {passed > 0 && (
        <div className="h-full" style={{ width: `${(passed / total) * 100}%`, backgroundColor: "var(--success)" }} />
      )}
      {failed > 0 && (
        <div className="h-full" style={{ width: `${(failed / total) * 100}%`, backgroundColor: "var(--error)" }} />
      )}
      {skipped > 0 && (
        <div className="h-full" style={{ width: `${(skipped / total) * 100}%`, backgroundColor: "var(--muted)" }} />
      )}
    </div>
  );
}

export default function RunDetailPage({
  params,
}: {
  params: Promise<{ id: string; runId: string }>;
}) {
  const { id, runId } = use(params);
  const [run, setRun] = useState<ReportRunDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [search, setSearch] = useState("");
  const [clusters, setClusters] = useState<RunCluster[]>([]);
  const [tab, setTab] = useState<RunTab>("clusters");
  // Prefer the tests tab when a run has nothing to cluster — but only flip
  // once on the initial load so the user is free to switch back.
  const tabInitializedRef = useRef(false);
  const [publicShareLoading, setPublicShareLoading] = useState(false);
  const [publicShareUrl, setPublicShareUrl] = useState<string | null>(null);

  const loadRun = () => {
    setLoading(true);
    setError(null);
    Promise.all([
      getReportRun(id, runId),
      getRunClusters(id, runId).catch(() => ({ clusters: [] as RunCluster[] })),
    ])
      .then(([runData, clusterData]) => {
        setRun(runData);
        setClusters(clusterData.clusters || []);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load run"))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadRun();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, runId]);

  useEffect(() => {
    if (loading || tabInitializedRef.current) return;
    tabInitializedRef.current = true;
    if (clusters.length === 0) setTab("tests");
  }, [loading, clusters.length]);

  const filteredTests = useMemo(() => {
    if (!run) return [];
    let tests = run.tests;
    if (filter !== "all") {
      tests = tests.filter((t) => t.status === filter);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      tests = tests.filter(
        (t) =>
          t.name?.toLowerCase().includes(q) ||
          t.spec?.toLowerCase().includes(q) ||
          t.fullTitle?.toLowerCase().includes(q),
      );
    }
    return tests;
  }, [run, filter, search]);

  if (loading) {
    return (
      <div className="space-y-6">
        <Link
          href={`/projects/${id}/tesbo-reports/runs`}
          className="text-sm text-[var(--brand-primary)] hover:underline"
        >
          &larr; Back to runs
        </Link>
        <PageSkeleton rows={8} />
      </div>
    );
  }

  if (error || !run) {
    return (
      <div className="space-y-4">
        <Link
          href={`/projects/${id}/tesbo-reports/runs`}
          className="text-sm text-[var(--brand-primary)] hover:underline"
        >
          &larr; Back to runs
        </Link>
        <ErrorBlock
          title="Failed to load run"
          message={error || "Run not found"}
          retry={loadRun}
        />
      </div>
    );
  }

  const filterCounts = {
    all: run.tests.length,
    Passed: run.passed,
    Failed: run.failed,
    Skipped: run.skipped,
  };

  const aiSummary = run.tests.reduce(
    (acc, test) => {
      if (test.status !== "Failed") return acc;
      if (test.aiAnalysisCategory === "ACTUAL_BUG") acc.actualBugs += 1;
      else if (test.aiAnalysisCategory === "FEATURE_CHANGE") acc.featureChanges += 1;
      else if (test.aiAnalysisCategory === "SCRIPT_ISSUE") acc.scriptIssues += 1;
      else if (test.aiAnalysisCategory === "ENVIRONMENT_ISSUE") acc.environmentIssues += 1;
      else if (test.aiAnalysisStatus === "PENDING") acc.pending += 1;
      else if (test.aiAnalysisStatus === "ERROR") acc.errors += 1;
      else acc.unclassified += 1;
      return acc;
    },
    { actualBugs: 0, featureChanges: 0, scriptIssues: 0, environmentIssues: 0, pending: 0, errors: 0, unclassified: 0 },
  );

  const runTone = RUN_TONE[run.status] ?? "neutral";
  const runLabel = RUN_LABEL[run.status] ?? run.status;
  const riskTone =
    run.releaseRiskLevel === "CRITICAL" || run.releaseRiskLevel === "HIGH"
      ? "error"
      : run.releaseRiskLevel === "MEDIUM"
        ? "warning"
        : "success";

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <Link
          href={`/projects/${id}/tesbo-reports/runs`}
          className="text-sm text-[var(--brand-primary)] hover:underline"
        >
          &larr; Back to runs
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold text-[var(--foreground)]">{run.runName}</h1>
          <StatusChip tone={runTone} live={run.status === "IN_PROGRESS"}>
            {runLabel}
          </StatusChip>
        </div>
        <p className="mt-1 text-sm text-[var(--muted)]">
          {formatTime(run.startedAt || run.createdAt)}
          {run.completedAt && ` — ${formatTime(run.completedAt)}`}
        </p>
      </div>

      {/* Summary: ring + metric cards */}
      <div className="flex flex-col sm:flex-row gap-5">
        {run.totalTests > 0 && (
          <Card>
            <CardBody className="flex items-center gap-5 py-4 px-5">
              <DistributionRing
                passed={run.passed}
                failed={run.failed}
                skipped={run.skipped}
                total={run.totalTests}
              />
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full bg-[var(--success)]" />
                  <span className="text-sm text-[var(--foreground)]">
                    <span className="font-semibold tabular-nums">{run.passed}</span> passed
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full bg-[var(--error)]" />
                  <span className="text-sm text-[var(--foreground)]">
                    <span className="font-semibold tabular-nums">{run.failed}</span> failed
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full bg-[var(--muted)]" />
                  <span className="text-sm text-[var(--foreground)]">
                    <span className="font-semibold tabular-nums">{run.skipped}</span> skipped
                  </span>
                </div>
              </div>
            </CardBody>
          </Card>
        )}

        <div className="grid flex-1 gap-3 grid-cols-2 sm:grid-cols-3">
          <SummaryCard
            label="Total Tests"
            value={String(run.totalTests)}
            icon={
              <svg className="h-4 w-4 text-[var(--muted)]" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 0 1 0 3.75H5.625a1.875 1.875 0 0 1 0-3.75Z" />
              </svg>
            }
          />
          <SummaryCard
            label="Duration"
            value={formatDuration(run.durationMs)}
            icon={
              <svg className="h-4 w-4 text-[var(--muted)]" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
              </svg>
            }
          />
          <SummaryCard
            label="Pass Rate"
            value={run.totalTests > 0 ? `${Math.round((run.passed / run.totalTests) * 100)}%` : "—"}
            color={run.totalTests > 0 && run.passed === run.totalTests ? "var(--success)" : undefined}
            icon={
              <svg className="h-4 w-4 text-[var(--muted)]" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 0 1 3 19.875v-6.75ZM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V8.625ZM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V4.125Z" />
              </svg>
            }
          />
          <SummaryCard
            label="Release Risk"
            value={
              run.releaseRiskScore != null
                ? `${run.releaseRiskScore}/100`
                : "—"
            }
            color={
              run.releaseRiskLevel
                ? riskTone === "error"
                  ? "var(--error)"
                  : riskTone === "warning"
                    ? "var(--warning)"
                    : "var(--success)"
                : undefined
            }
            icon={
              <StatusChip tone={riskTone}>
                {run.releaseRiskLevel || "N/A"}
              </StatusChip>
            }
          />
        </div>
      </div>

      {/* Distribution bar */}
      {run.totalTests > 0 && (
        <DistributionBar
          passed={run.passed}
          failed={run.failed}
          skipped={run.skipped}
          total={run.totalTests}
        />
      )}

      {/* AI Analysis */}
      {run.failed > 0 && (
        <Card>
          <CardBody className={`py-4 px-5 ${aiSummary.actualBugs > 0 ? "tesbo-ai-accent" : ""}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <svg className="h-5 w-5 text-[var(--ai-primary)]" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904 9 18.75l-2.844.813a1.125 1.125 0 0 0 0 2.124L9 22.5l.813 2.844a1.125 1.125 0 0 0 2.124 0L12.75 22.5l2.844-.813a1.125 1.125 0 0 0 0-2.124L12.75 18.75l-.813-2.846a1.125 1.125 0 0 0-2.124 0Z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 6.75V3m0 3.75V10.5m0-3.75h3.75m-3.75 0H12.75M4.5 8.25V6m0 2.25v2.25m0-2.25H2.25m2.25 0h2.25" />
                </svg>
                <div>
                  <p className="text-sm font-semibold text-[var(--foreground)]">AI Analysis Summary</p>
                  <p className="text-xs text-[var(--muted)]">
                    Failed tests classified by root cause
                  </p>
                </div>
              </div>
              {!run.aiAnalysisEnabled && (
                <span className="text-xs text-[var(--muted)]">
                  Add a workspace AI key and allocate it to this project to enable analysis.
                </span>
              )}
            </div>
            <div className="mt-3 flex flex-wrap gap-3">
              {aiSummary.actualBugs > 0 && (
                <StatusChip tone="error">
                  {aiSummary.actualBugs} actual bug{aiSummary.actualBugs !== 1 && "s"}
                </StatusChip>
              )}
              {aiSummary.featureChanges > 0 && (
                <StatusChip tone="warning">
                  {aiSummary.featureChanges} feature change{aiSummary.featureChanges !== 1 && "s"}
                </StatusChip>
              )}
              {aiSummary.scriptIssues > 0 && (
                <StatusChip tone="warning">
                  {aiSummary.scriptIssues} script issue{aiSummary.scriptIssues !== 1 && "s"}
                </StatusChip>
              )}
              {aiSummary.environmentIssues > 0 && (
                <StatusChip tone="info">
                  {aiSummary.environmentIssues} environment issue{aiSummary.environmentIssues !== 1 && "s"}
                </StatusChip>
              )}
              {aiSummary.pending > 0 && (
                <StatusChip tone="ai" live>
                  {aiSummary.pending} pending
                </StatusChip>
              )}
              {aiSummary.errors > 0 && (
                <StatusChip tone="error">
                  {aiSummary.errors} error{aiSummary.errors !== 1 && "s"}
                </StatusChip>
              )}
              {aiSummary.unclassified > 0 && (
                <StatusChip tone="neutral">
                  {aiSummary.unclassified} unclassified
                </StatusChip>
              )}
            </div>
          </CardBody>
        </Card>
      )}

      {/* Tabs: Failure Clusters in this Run vs. All Run Tests. We keep the
          summary cards above the tabs because they describe the run as a
          whole, while the tabs split the deep-dive content. */}
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border-subtle)]">
        <RunTabButton
          active={tab === "clusters"}
          onClick={() => setTab("clusters")}
          label="Failure Clusters in this Run"
          count={clusters.length}
        />
        <RunTabButton
          active={tab === "tests"}
          onClick={() => setTab("tests")}
          label="All Run Tests"
          count={run.tests.length}
        />
      </div>

      {tab === "clusters" ? (
        clusters.length > 0 ? (
          <FailureClustersSection
            projectId={id}
            runId={runId}
            clusters={clusters}
          />
        ) : (
          <Card>
            <CardBody className="py-6 px-5 text-center">
              <p className="text-sm text-[var(--foreground)]">
                {run.failed === 0
                  ? "No failures in this run — nothing to cluster."
                  : "No failure clusters detected for this run yet."}
              </p>
              <p className="mt-1 text-xs text-[var(--muted)]">
                Failures are clustered automatically by their underlying
                exception type as soon as they finish processing.
              </p>
            </CardBody>
          </Card>
        )
      ) : (
        <>
          {/* Filters + search */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="inline-flex items-center rounded-full border border-[var(--border)] bg-[var(--surface)] p-0.5">
              {(["all", "Passed", "Failed", "Skipped"] as StatusFilter[]).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setFilter(f)}
                  className={`rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors ${
                    filter === f
                      ? "bg-[var(--brand-primary)] text-[var(--surface)]"
                      : "text-[var(--muted)] hover:text-[var(--foreground)]"
                  }`}
                >
                  {f === "all" ? "All" : f} ({filterCounts[f]})
                </button>
              ))}
            </div>
            <input
              type="text"
              placeholder="Search tests…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-11 w-64 rounded-xl border border-[var(--glass-border-soft)] bg-[var(--glass-bg-subtle)] px-3.5 text-sm text-[var(--foreground)] placeholder:text-[var(--muted-soft)] backdrop-blur-md transition-[border-color,box-shadow] focus:border-[var(--brand-primary)] focus:outline-none focus:ring-4 focus:ring-[color-mix(in_oklab,var(--brand-primary)_18%,transparent)]"
            />
          </div>

          {/* Test list */}
          <Card>
            <CardBody className="p-0">
              {filteredTests.length === 0 ? (
                <p className="p-6 text-sm text-[var(--muted)]">
                  {run.tests.length === 0
                    ? "No test data for this run."
                    : "No tests match the current filter."}
                </p>
              ) : (
                <>
                  <div className="grid grid-cols-[1fr_auto_auto] items-center gap-3 px-5 py-2 text-[10px] uppercase tracking-wide text-[var(--muted)] border-b border-[var(--border-subtle)] bg-[var(--surface-secondary)]">
                    <span>Test</span>
                    <span>AI Analysis</span>
                    <span className="w-14 text-right">Duration</span>
                  </div>
                  <div className="divide-y divide-[var(--border-subtle)]">
                    {filteredTests.map((t) => (
                      <TestRow
                        key={t.id}
                        test={t}
                        aiAnalysisEnabled={!!run.aiAnalysisEnabled}
                        projectId={id}
                        runId={runId}
                      />
                    ))}
                  </div>
                </>
              )}
            </CardBody>
          </Card>
        </>
      )}
    </div>
  );
}

function RunTabButton({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`relative -mb-px inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_oklab,var(--brand-primary)_30%,transparent)] ${
        active
          ? "border-b-2 border-[var(--brand-primary)] text-[var(--foreground)]"
          : "border-b-2 border-transparent text-[var(--muted)] hover:text-[var(--foreground)]"
      }`}
    >
      {label}
      <span
        className={`inline-flex min-w-[1.5rem] items-center justify-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums ${
          active
            ? "bg-[var(--brand-primary)] text-[var(--surface)]"
            : "bg-[var(--surface-tertiary)] text-[var(--muted)]"
        }`}
      >
        {count}
      </span>
    </button>
  );
}

// ── Failure Clusters ───────────────────────────────────────────────────────
//
// Failure clusters group together tests that failed for the same underlying
// reason (e.g. all 12 tests that hit the same Selenium element-not-found
// error). The data the backend persists is great for grouping but
// historically the title we showed was the *normalized signature* — a
// machine-readable string full of `#` placeholders, CDATA wrappers and
// Selenium boilerplate that nobody could read. The section below turns each
// cluster into a clickable card with a clean title + category, and opens a
// detail modal that explains the failure, lists every affected test, and
// surfaces the original error so the engineer can act on it.

const CATEGORY_DISPLAY: Record<
  Exclude<FailureCategoryHint, null>,
  {
    tone: "error" | "warning" | "info";
    label: string;
    advice: string;
  }
> = {
  ACTUAL_BUG: {
    tone: "error",
    label: "Actual bug",
    advice:
      "The product behaved differently than the test expected. Reproduce locally, then file a bug or push a fix in the application code.",
  },
  FEATURE_CHANGE: {
    tone: "warning",
    label: "Feature change",
    advice:
      "The app intentionally changed behaviour. Update the assertions or selectors in the test to match the new expected behaviour.",
  },
  SCRIPT_ISSUE: {
    tone: "warning",
    label: "Script issue",
    advice:
      "The test code itself is the problem (bad selector, wrong wait, stale data). Fix the test rather than the application.",
  },
  ENVIRONMENT_ISSUE: {
    tone: "info",
    label: "Environment issue",
    advice:
      "The failure looks like infrastructure/network — timeouts, DNS, 5xx. Re-run after the environment is healthy and consider better retries.",
  },
};

function categoryProps(hint: FailureCategoryHint) {
  if (hint && CATEGORY_DISPLAY[hint]) return CATEGORY_DISPLAY[hint];
  return {
    tone: "neutral" as const,
    label: "Unclassified",
    advice:
      "Open the affected tests below and inspect the original error to decide whether this is a bug, a script issue, or an environment problem.",
  };
}

// A group of underlying signature-clusters that share the same exception
// class (e.g. all `ElementClickInterceptedException` failures). The user
// asked to fold these together because today the same exception can
// appear under multiple cluster cards depending on the offending element
// or locator — that detail still matters, but the headline count should
// be by exception type.
interface ClusterGroup {
  /** Stable key used in React lists; lower-cased error type or `__none__`. */
  key: string;
  /** Display label for the group (e.g. `ElementClickInterceptedException`). */
  errorTypeLabel: string;
  /** True when the group was synthesised from clusters with no error type. */
  isUnclassified: boolean;
  clusters: RunCluster[];
  /** Total affected tests across all underlying clusters. */
  testCount: number;
  /** The "worst" category hint represented in the group (error > warning > info > neutral). */
  dominantCategory: FailureCategoryHint;
  /** Most recent `lastSeenAt` across the underlying clusters. */
  lastSeenAt: string | null;
}

function groupClustersByErrorType(clusters: RunCluster[]): ClusterGroup[] {
  const map = new Map<string, ClusterGroup>();
  for (const c of clusters) {
    const trimmed = (c.errorType || "").trim();
    const key = trimmed ? trimmed.toLowerCase() : "__none__";
    let group = map.get(key);
    if (!group) {
      group = {
        key,
        errorTypeLabel: trimmed || "Unclassified failure",
        isUnclassified: !trimmed,
        clusters: [],
        testCount: 0,
        dominantCategory: null,
        lastSeenAt: null,
      };
      map.set(key, group);
    }
    group.clusters.push(c);
    group.testCount += c.testCount;
    group.dominantCategory = pickDominantCategory(
      group.dominantCategory,
      c.categoryHint
    );
    if (c.lastSeenAt && (!group.lastSeenAt || c.lastSeenAt > group.lastSeenAt)) {
      group.lastSeenAt = c.lastSeenAt;
    }
  }
  // Sort by total tests desc so the loudest failures bubble to the top,
  // pushing the synthetic "Unclassified" bucket to the end.
  return [...map.values()].sort((a, b) => {
    if (a.isUnclassified !== b.isUnclassified) return a.isUnclassified ? 1 : -1;
    return b.testCount - a.testCount;
  });
}

const CATEGORY_PRIORITY: Record<string, number> = {
  ACTUAL_BUG: 4,
  FEATURE_CHANGE: 3,
  SCRIPT_ISSUE: 2,
  ENVIRONMENT_ISSUE: 1,
};

function pickDominantCategory(
  current: FailureCategoryHint,
  candidate: FailureCategoryHint
): FailureCategoryHint {
  const a = current ? CATEGORY_PRIORITY[current] || 0 : 0;
  const b = candidate ? CATEGORY_PRIORITY[candidate] || 0 : 0;
  return b > a ? candidate : current;
}

function FailureClustersSection({
  projectId,
  runId,
  clusters,
}: {
  projectId: string;
  runId: string;
  clusters: RunCluster[];
}) {
  const [openGroupKey, setOpenGroupKey] = useState<string | null>(null);

  const groups = useMemo(() => groupClustersByErrorType(clusters), [clusters]);
  const openGroup = openGroupKey
    ? groups.find((g) => g.key === openGroupKey) ?? null
    : null;

  return (
    <Card>
      <CardBody className="py-4 px-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-[var(--foreground)]">
              Failure Clusters in this Run
            </p>
            <p className="text-xs text-[var(--muted)]">
              Failures grouped by exception type. Click a card to see every
              affected test, including different element/locator variants.
            </p>
          </div>
          <span className="shrink-0 text-xs text-[var(--muted)]">
            {groups.length} exception{groups.length !== 1 && "s"} ·{" "}
            {clusters.length} signature{clusters.length !== 1 && "s"}
          </span>
        </div>
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          {groups.map((group) => (
            <ClusterGroupCard
              key={group.key}
              group={group}
              onOpen={() => setOpenGroupKey(group.key)}
            />
          ))}
        </div>
      </CardBody>

      <ClusterGroupDetailModal
        projectId={projectId}
        runId={runId}
        group={openGroup}
        onClose={() => setOpenGroupKey(null)}
      />
    </Card>
  );
}

function ClusterGroupCard({
  group,
  onOpen,
}: {
  group: ClusterGroup;
  onOpen: () => void;
}) {
  const cat = categoryProps(group.dominantCategory);
  const variantCount = group.clusters.length;
  // Pick the most representative summary — the underlying cluster with the
  // most tests usually has the cleanest signal.
  const sampleSummary = useMemo(() => {
    const withSummary = group.clusters
      .filter((c) => c.summary && c.summary.trim().length > 0)
      .sort((a, b) => b.testCount - a.testCount);
    return withSummary[0]?.summary || null;
  }, [group.clusters]);

  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex flex-col gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 text-left transition-colors hover:border-[var(--brand-primary)] hover:bg-[var(--surface-secondary)]"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-[var(--foreground)]">
            <span
              className={
                group.isUnclassified
                  ? "text-[var(--muted)]"
                  : "text-[var(--error)] font-mono"
              }
            >
              {group.errorTypeLabel}
            </span>
          </p>
          {sampleSummary && (
            <p className="mt-1 text-[11px] text-[var(--muted)] line-clamp-2 leading-relaxed">
              {sampleSummary}
            </p>
          )}
        </div>
        <StatusChip tone="neutral" className="shrink-0 text-[10px]">
          {group.testCount} {group.testCount === 1 ? "test" : "tests"}
        </StatusChip>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusChip tone={cat.tone} className="text-[10px] px-2 py-0.5">
          {cat.label}
        </StatusChip>
        {variantCount > 1 && (
          <span className="text-[10px] text-[var(--muted)]">
            {variantCount} variants
          </span>
        )}
        {group.lastSeenAt && (
          <span className="text-[10px] text-[var(--muted)]">
            Last seen {formatTime(group.lastSeenAt)}
          </span>
        )}
        <span className="ml-auto text-[10px] font-medium text-[var(--brand-primary)] opacity-0 transition-opacity group-hover:opacity-100">
          View details →
        </span>
      </div>
    </button>
  );
}

function ClusterGroupDetailModal({
  projectId,
  runId,
  group,
  onClose,
}: {
  projectId: string;
  runId: string;
  group: ClusterGroup | null;
  onClose: () => void;
}) {
  const [details, setDetails] = useState<RunClusterDetail[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showRawError, setShowRawError] = useState(false);

  // Stable list of cluster IDs so the effect only re-runs when the group
  // actually changes — not on every render of the parent.
  const clusterIdsKey = group ? group.clusters.map((c) => c.id).join(",") : "";

  useEffect(() => {
    if (!group) {
      setDetails([]);
      setError(null);
      setShowRawError(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setShowRawError(false);
    setDetails([]);
    Promise.all(
      group.clusters.map((c) => getRunCluster(projectId, runId, c.id))
    )
      .then((data) => {
        if (!cancelled) setDetails(data);
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load cluster");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clusterIdsKey, projectId, runId]);

  const cat = categoryProps(group?.dominantCategory ?? null);

  // Aggregate tests across the underlying clusters and dedupe by id —
  // a single test could in theory be linked to multiple signature
  // variants and we never want to show it twice in this view.
  const aggregatedTests = useMemo(() => {
    const seen = new Map<string, RunClusterDetail["tests"][number]>();
    for (const d of details) {
      for (const t of d.tests) {
        if (!seen.has(t.id)) seen.set(t.id, t);
      }
    }
    return [...seen.values()];
  }, [details]);

  // Pick a representative sample error (largest underlying cluster with
  // a real message) to anchor the "original error" disclosure.
  const sampleSource = useMemo(() => {
    const withMsg = details.filter(
      (d) => d.sampleErrorMessage || d.sampleErrorStack
    );
    if (withMsg.length === 0) return null;
    return withMsg.reduce((best, d) =>
      d.testCount > best.testCount ? d : best
    );
  }, [details]);

  // Variant breakdown: each underlying signature-cluster within this
  // group, sorted by test count so the loudest variant is on top.
  const variants = useMemo(() => {
    return [...details].sort((a, b) => b.testCount - a.testCount);
  }, [details]);

  const open = !!group;
  const headerTitle = group?.errorTypeLabel || "Failure cluster";

  return (
    <Modal
      open={open}
      onClose={onClose}
      className="max-w-3xl max-h-[85vh] flex flex-col"
    >
      <div className="flex flex-col gap-4 min-h-0">
        {/* Header */}
        <div>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--muted)]">
                Failure cluster
              </p>
              <h2 className="mt-1 text-lg font-semibold leading-tight break-words">
                <span
                  className={
                    group?.isUnclassified
                      ? "text-[var(--foreground)]"
                      : "text-[var(--error)] font-mono"
                  }
                >
                  {headerTitle}
                </span>
              </h2>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="shrink-0 rounded-xl p-1 text-[var(--muted)] hover:bg-[var(--glass-bg-subtle)] hover:text-[var(--foreground)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_oklab,var(--brand-primary)_30%,transparent)]"
              aria-label="Close"
            >
              <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          {group && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <StatusChip tone={cat.tone}>{cat.label}</StatusChip>
              <StatusChip tone="neutral">
                {group.testCount} affected test
                {group.testCount !== 1 && "s"}
              </StatusChip>
              {group.clusters.length > 1 && (
                <StatusChip tone="neutral">
                  {group.clusters.length} variants
                </StatusChip>
              )}
            </div>
          )}
        </div>

        {error && <ErrorBlock title="Couldn't load cluster" message={error} />}

        {loading && details.length === 0 && (
          <div className="space-y-3">
            <div className="h-4 w-3/4 animate-pulse rounded bg-[var(--surface-tertiary)]" />
            <div className="h-4 w-1/2 animate-pulse rounded bg-[var(--surface-tertiary)]" />
            <div className="h-24 w-full animate-pulse rounded bg-[var(--surface-tertiary)]" />
          </div>
        )}

        {group && details.length > 0 && (
          <div className="flex-1 overflow-y-auto -mx-6 px-6 space-y-5 min-h-0">
            {/* What to do next */}
            <section className="rounded-xl border border-[var(--border)] bg-[var(--surface-secondary)] p-3">
              <SectionTitle>What to do next</SectionTitle>
              <p className="mt-1.5 text-sm text-[var(--foreground)] leading-relaxed">
                {cat.advice}
              </p>
            </section>

            {/* Variants — only worth showing when multiple underlying
                signature-clusters were merged into this exception group. */}
            {variants.length > 1 && (
              <section>
                <SectionTitle>Variants ({variants.length})</SectionTitle>
                <p className="mt-1 text-[11px] text-[var(--muted)] leading-relaxed">
                  All of these failures share the same exception type but hit
                  different elements, locators, or timing.
                </p>
                <div className="mt-2 divide-y divide-[var(--border-subtle)] rounded-xl border border-[var(--border)] bg-[var(--surface)]">
                  {variants.map((v) => (
                    <div key={v.id} className="px-3 py-2.5">
                      <div className="flex items-start gap-3">
                        <StatusChip
                          tone="neutral"
                          className="shrink-0 text-[10px]"
                        >
                          {v.testCount}
                          {v.testCount === 1 ? " test" : " tests"}
                        </StatusChip>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-[var(--foreground)] break-words">
                            {v.summary || v.title || "Variant"}
                          </p>
                          {v.sampleErrorMessage && (
                            <p className="mt-1 text-[11px] font-mono text-[var(--muted)] line-clamp-2 leading-relaxed break-words">
                              {v.sampleErrorMessage}
                            </p>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* Affected tests */}
            <section>
              <SectionTitle>
                Affected tests ({aggregatedTests.length})
              </SectionTitle>
              <div className="mt-2 divide-y divide-[var(--border-subtle)] rounded-xl border border-[var(--border)] bg-[var(--surface)]">
                {aggregatedTests.map((t) => (
                  <div key={t.id} className="px-3 py-2.5">
                    <div className="flex items-start gap-3">
                      <StatusChip
                        tone={
                          t.status === "Passed"
                            ? "success"
                            : t.status === "Failed"
                              ? "error"
                              : "neutral"
                        }
                        className="shrink-0 text-[10px]"
                      >
                        {t.status === "Failed"
                          ? "FAIL"
                          : t.status === "Passed"
                            ? "PASS"
                            : t.status.toUpperCase()}
                      </StatusChip>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-[var(--foreground)] truncate">
                          {t.name || t.fullTitle || "(unnamed test)"}
                        </p>
                        {t.spec && (
                          <p className="text-[11px] font-mono text-[var(--muted)] truncate">
                            {t.spec}
                          </p>
                        )}
                        {t.errorPreview && (
                          <p className="mt-1 text-[11px] text-[var(--muted)] line-clamp-2 leading-relaxed">
                            {t.errorPreview}
                          </p>
                        )}
                      </div>
                      {t.durationMs != null && (
                        <span className="shrink-0 text-[11px] text-[var(--muted)] tabular-nums">
                          {formatDuration(t.durationMs)}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </section>

            {/* Original error — uses the sample from the dominant variant. */}
            {sampleSource &&
              (sampleSource.sampleErrorMessage ||
                sampleSource.sampleErrorStack) && (
                <section>
                  <button
                    type="button"
                    onClick={() => setShowRawError((v) => !v)}
                    className="flex items-center gap-1.5 text-xs font-medium text-[var(--brand-primary)] hover:underline"
                  >
                    <svg
                      className={`h-3.5 w-3.5 transition-transform ${showRawError ? "rotate-90" : ""}`}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2}
                      viewBox="0 0 24 24"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                    </svg>
                    {showRawError ? "Hide" : "Show"} original error
                  </button>
                  {showRawError && (
                    <div className="mt-2 rounded-xl border border-[var(--error-border)] bg-[var(--error-soft)] p-3">
                      {sampleSource.sampleErrorMessage && (
                        <pre className="text-[11px] text-[var(--foreground)] whitespace-pre-wrap break-words leading-relaxed font-mono">
                          {sampleSource.sampleErrorMessage}
                        </pre>
                      )}
                      {sampleSource.sampleErrorStack && (
                        <details className="mt-2">
                          <summary className="cursor-pointer text-[10px] text-[var(--muted)] hover:text-[var(--foreground)] select-none">
                            Stack trace
                          </summary>
                          <pre className="mt-2 text-[10px] text-[var(--muted)] whitespace-pre-wrap break-words max-h-48 overflow-auto font-mono">
                            {sampleSource.sampleErrorStack}
                          </pre>
                        </details>
                      )}
                    </div>
                  )}
                </section>
              )}
          </div>
        )}
      </div>
    </Modal>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)]">
      {children}
    </h3>
  );
}

function SummaryCard({
  label,
  value,
  color,
  icon,
}: {
  label: string;
  value: string;
  color?: string;
  icon?: React.ReactNode;
}) {
  return (
    <Card>
      <CardBody className="py-3 px-4">
        <div className="flex items-center gap-2">
          {icon}
          <p className="text-xs text-[var(--muted)]">{label}</p>
        </div>
        <p
          className="mt-1 text-xl font-bold tabular-nums"
          style={{ color: color || "var(--foreground)" }}
        >
          {value}
        </p>
      </CardBody>
    </Card>
  );
}

function TestRow({
  test,
  aiAnalysisEnabled,
  projectId,
  runId,
}: {
  test: ReportTest;
  aiAnalysisEnabled: boolean;
  projectId: string;
  runId: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [commandsOpen, setCommandsOpen] = useState(false);
  const testTone = TEST_TONE[test.status] ?? "neutral";
  const testLabel = TEST_LABEL[test.status] ?? test.status;
  const ai = aiChipProps(test, aiAnalysisEnabled);
  const hasArtifacts = !!(test.traceUrl || test.screenshotUrl || test.videoUrl);
  const hasSteps = test.steps && test.steps.length > 0;
  const hasError = !!test.errorMessage;
  const hasAiSummary = !!test.aiAnalysisSummary;
  // Live VNC is only meaningful while the session is still running AND the
  // proxy has discovered the upstream node — otherwise the WS upgrade
  // would 4xx and the user would see "Connection lost".
  const sessionLiveAvailable =
    test.status !== "Skipped" && !!test.seleniumSessionLiveAvailable;
  // Show the recording link only when we know the session ended AND there
  // is an mp4 URL to play. Live sessions never have a finalised mp4 yet.
  const sessionRecordingUrl = (() => {
    if (!test.seleniumSessionVideoUrl) return null;
    const finalStatuses = ["ended", "abandoned", "failed"];
    if (test.seleniumSessionStatus && !finalStatuses.includes(test.seleniumSessionStatus)) {
      return null;
    }
    return test.seleniumSessionVideoUrl;
  })();
  const hasSessionLink =
    !!test.seleniumSessionId &&
    (sessionLiveAvailable || !!sessionRecordingUrl);
  const rowAccent =
    test.status === "Passed"
      ? "var(--success)"
      : test.status === "Failed"
        ? "var(--error)"
        : "var(--muted)";

  return (
    <div style={{ borderLeft: `3px solid ${rowAccent}` }}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full text-left px-5 py-3 hover:bg-[var(--surface-secondary)] transition-colors flex items-center gap-4"
      >
        <StatusChip tone={testTone} className="shrink-0 text-[10px] px-2 py-0.5">
          {testLabel}
        </StatusChip>

        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-[var(--foreground)] truncate">
            {test.name || test.fullTitle}
          </p>
          <p className="text-xs text-[var(--muted)] font-mono truncate">
            {test.spec}
          </p>
        </div>

        <div className="shrink-0 flex items-center gap-3">
          {test.isProbableRegression && (
            <StatusChip tone="error" className="text-[10px] px-2 py-0.5">
              Probable regression
            </StatusChip>
          )}
          <StatusChip tone={ai.tone} className="text-[10px] px-2 py-0.5">
            {ai.label}
          </StatusChip>
          {hasArtifacts && (
            <div className="flex items-center gap-1.5">
              {test.screenshotUrl && (
                <svg className="h-3.5 w-3.5 text-[var(--muted)]" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909M3.75 21h16.5A2.25 2.25 0 0 0 22.5 18.75V5.25A2.25 2.25 0 0 0 20.25 3H3.75A2.25 2.25 0 0 0 1.5 5.25v13.5A2.25 2.25 0 0 0 3.75 21Z" />
                </svg>
              )}
              {test.videoUrl && (
                <svg className="h-3.5 w-3.5 text-[var(--muted)]" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z" />
                </svg>
              )}
              {test.traceUrl && (
                <svg className="h-3.5 w-3.5 text-[var(--muted)]" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
                </svg>
              )}
            </div>
          )}
          {hasSessionLink && (
            <div className="flex items-center gap-1.5">
              {/* Live-pulse dot when the linked session is still running. We
                  show this in the collapsed row so users can spot tests that
                  are still executing without expanding every row. */}
              {sessionLiveAvailable && (
                <span
                  title="Live Selenium session available"
                  aria-label="Live Selenium session available"
                  className="relative inline-flex h-2 w-2"
                >
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--error)] opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--error)]" />
                </span>
              )}
              {!sessionLiveAvailable && sessionRecordingUrl && (
                <svg
                  aria-label="Session recording available"
                  className="h-3.5 w-3.5 text-[var(--brand-primary)]"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.5}
                  viewBox="0 0 24 24"
                >
                  <title>Session recording available</title>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 0 1 0 1.972l-11.54 6.347a1.125 1.125 0 0 1-1.667-.986V5.653Z" />
                </svg>
              )}
            </div>
          )}
          <span className="text-xs text-[var(--muted)] tabular-nums w-14 text-right">
            {formatDuration(test.durationMs)}
          </span>
          <svg
            className={`h-4 w-4 text-[var(--muted)] transition-transform ${expanded ? "rotate-180" : ""}`}
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-[var(--border-subtle)] bg-[var(--surface-secondary,var(--surface))]">
          {/* Detail header */}
          <div className="px-6 py-4 border-b border-[var(--border-subtle)]">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-sm font-semibold text-[var(--foreground)]">
                  {test.fullTitle || test.name}
                </h3>
                <p className="text-xs text-[var(--muted)] font-mono mt-0.5">
                  {test.spec}
                </p>
              </div>
              <StatusChip tone={testTone}>
                {test.status}
              </StatusChip>
            </div>

            <div className="flex flex-wrap gap-x-5 gap-y-1 mt-3 text-xs">
              <span className="text-[var(--muted)]">
                Duration: <span className="text-[var(--foreground)] font-medium">{formatDuration(test.durationMs)}</span>
              </span>
              {test.attempt != null && (
                <span className="text-[var(--muted)]">
                  Attempt: <span className="text-[var(--foreground)] font-medium">{test.attempt}</span>
                </span>
              )}
              {test.projectName && (
                <span className="text-[var(--muted)]">
                  Browser: <span className="text-[var(--foreground)] font-medium">{test.projectName}</span>
                </span>
              )}
              {test.isProbableRegression && (
                <span className="text-[var(--muted)]">
                  Regression:{" "}
                  <span className="text-[var(--error)] font-medium">
                    {test.regressionConfidence != null
                      ? `${test.regressionConfidence}%`
                      : "Probable"}
                  </span>
                </span>
              )}
            </div>

            {test.tags && test.tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {test.tags.map((tag, i) => (
                  <span
                    key={i}
                    className="inline-flex items-center rounded-full bg-[var(--surface)] border border-[var(--border)] px-2 py-0.5 text-[10px] font-medium text-[var(--muted)]"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Error section */}
          {hasError && (
            <div className="px-6 py-4 border-b border-[var(--border-subtle)]">
              <SectionHeader
                icon={
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126Z" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 15.75h.007v.008H12v-.008Z" />
                  </svg>
                }
                title="Error"
                color="var(--error)"
              />
              <div className="mt-2 rounded-lg border border-[var(--error-border)] bg-[var(--error-soft)] p-4">
                <pre className="text-xs text-[var(--foreground)] whitespace-pre-wrap break-words leading-relaxed">
                  {test.errorMessage}
                </pre>
                {test.errorStack && (
                  <details className="mt-3">
                    <summary className="cursor-pointer text-[10px] text-[var(--muted)] hover:text-[var(--foreground)] select-none">
                      Stack trace
                    </summary>
                    <pre className="mt-2 text-[10px] text-[var(--muted)] whitespace-pre-wrap break-words max-h-48 overflow-auto">
                      {test.errorStack}
                    </pre>
                  </details>
                )}
              </div>
            </div>
          )}

          {/* AI Analysis per-test */}
          {hasAiSummary && (
            <div className="px-6 py-4 border-b border-[var(--border-subtle)]">
              <SectionHeader
                icon={
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904 9 18.75l-2.844.813a1.125 1.125 0 0 0 0 2.124L9 22.5l.813 2.844a1.125 1.125 0 0 0 2.124 0L12.75 22.5l2.844-.813a1.125 1.125 0 0 0 0-2.124L12.75 18.75l-.813-2.846a1.125 1.125 0 0 0-2.124 0Z" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 6.75V3m0 3.75V10.5m0-3.75h3.75m-3.75 0H12.75M4.5 8.25V6m0 2.25v2.25m0-2.25H2.25m2.25 0h2.25" />
                  </svg>
                }
                title="AI Analysis"
                color="var(--ai-primary)"
              />
              <div className="mt-2 glass-subtle rounded-xl p-3">
                <p className="text-xs text-[var(--foreground)] leading-relaxed">
                  {test.aiAnalysisSummary}
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {test.aiAnalysisCategory && AI_CATEGORY_DISPLAY[test.aiAnalysisCategory] && (
                    <StatusChip
                      tone={AI_CATEGORY_DISPLAY[test.aiAnalysisCategory].tone}
                      className="text-[10px] px-2 py-0.5"
                    >
                      {AI_CATEGORY_DISPLAY[test.aiAnalysisCategory].label}
                    </StatusChip>
                  )}
                  {test.aiAnalysisConfidence != null && (
                    <StatusChip
                      tone={
                        test.aiAnalysisConfidence >= 80
                          ? "confidenceHigh"
                          : test.aiAnalysisConfidence >= 50
                            ? "confidenceMedium"
                            : "confidenceLow"
                      }
                      className="text-[10px] px-2 py-0.5"
                    >
                      {test.aiAnalysisConfidence}% confidence
                    </StatusChip>
                  )}
                  {test.aiAnalysisModel && (
                    <span className="text-[10px] text-[var(--muted)]">
                      Model: {test.aiAnalysisModel}
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Steps section */}
          {hasSteps && (
            <div className="px-6 py-4 border-b border-[var(--border-subtle)]">
              <SectionHeader
                icon={
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 0 1 0 3.75H5.625a1.875 1.875 0 0 1 0-3.75Z" />
                  </svg>
                }
                title={`Steps (${test.steps!.length})`}
              />
              <div className="mt-2 max-h-72 space-y-0 overflow-auto glass-subtle rounded-xl">
                {test.steps!.map((step, i) => (
                  <div
                    key={i}
                    className={`flex items-start gap-3 px-3 py-2 text-xs ${
                      i > 0 ? "border-t border-[var(--border-subtle)]" : ""
                    }`}
                  >
                    <span className="shrink-0 w-6 text-right text-[var(--muted)] tabular-nums font-mono">
                      {i + 1}
                    </span>
                    <span className="text-[var(--foreground)] font-mono leading-relaxed break-words min-w-0">
                      {step.description}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Selenium session section — links the failure back to the live
              VNC stream (while the session is running) and the recorded mp4
              + WebDriver command timeline (after the session ends). Only
              renders when the report ingest correlated this test to a
              session id from selenium_sessions. */}
          {test.seleniumSessionId && (
            <div className="px-6 py-4 border-b border-[var(--border-subtle)]">
              <SectionHeader
                icon={
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 17.25v1.007a3 3 0 0 1-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0 1 15 18.257V17.25m6-12V15a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 15V5.25m18 0A2.25 2.25 0 0 0 18.75 3H5.25A2.25 2.25 0 0 0 3 5.25m18 0V12a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 12V5.25" />
                  </svg>
                }
                title="Selenium Session"
                color={sessionLiveAvailable ? "var(--error)" : "var(--brand-primary)"}
              />
              <div className="mt-2 rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)] p-3">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="text-[var(--muted)]">Session:</span>
                  <code className="rounded bg-[var(--surface)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--foreground)]">
                    {test.seleniumSessionId.slice(0, 12)}…
                  </code>
                  {test.seleniumSessionStatus && (
                    <StatusChip
                      tone={
                        sessionLiveAvailable
                          ? "error"
                          : test.seleniumSessionStatus === "queued"
                            ? "warning"
                            : "neutral"
                      }
                      live={sessionLiveAvailable}
                      className="text-[10px] px-2 py-0.5"
                    >
                      {test.seleniumSessionStatus}
                    </StatusChip>
                  )}
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {sessionLiveAvailable && (
                    <Link
                      href={`/projects/${projectId}/sessions/${encodeURIComponent(test.seleniumSessionId)}`}
                      className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--error-border)] bg-[var(--error-soft)] px-3.5 py-1.5 text-xs font-medium text-[var(--error)] hover:bg-[color-mix(in_oklab,var(--error)_20%,transparent)] transition-colors"
                    >
                      <span className="relative inline-flex h-2 w-2">
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--error)] opacity-75" />
                        <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--error)]" />
                      </span>
                      Watch live VNC
                    </Link>
                  )}
                  {!sessionLiveAvailable && sessionRecordingUrl && (
                    <a
                      href={sessionRecordingUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--brand-border)] bg-[var(--brand-soft)] px-3.5 py-1.5 text-xs font-medium text-[var(--brand-primary)] hover:bg-[var(--brand-surface)] transition-colors"
                    >
                      <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 0 1 0 1.972l-11.54 6.347a1.125 1.125 0 0 1-1.667-.986V5.653Z" />
                      </svg>
                      Session recording
                    </a>
                  )}
                  <button
                    type="button"
                    onClick={() => setCommandsOpen(true)}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--glass-border)] bg-[var(--glass-bg-subtle)] px-3.5 py-1.5 text-xs font-medium text-[var(--foreground)] backdrop-blur-sm hover:bg-[var(--glass-bg)] transition-colors"
                  >
                    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 7.5l3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0 0 21 18V6a2.25 2.25 0 0 0-2.25-2.25H5.25A2.25 2.25 0 0 0 3 6v12a2.25 2.25 0 0 0 2.25 2.25Z" />
                    </svg>
                    Command timeline
                  </button>
                </div>
                {sessionLiveAvailable && (
                  <p className="mt-2 text-[10px] text-[var(--muted)]">
                    The browser node is still live — open the VNC viewer to
                    see what the test is doing right now.
                  </p>
                )}
                {!sessionLiveAvailable && !sessionRecordingUrl && (
                  <p className="mt-2 text-[10px] text-[var(--muted)]">
                    Session ended; recording is not yet available (or this
                    deployment doesn&apos;t enable session video).
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Artifacts section */}
          {hasArtifacts && (
            <div className="px-6 py-4">
              <SectionHeader
                icon={
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="m18.375 12.739-7.693 7.693a4.5 4.5 0 0 1-6.364-6.364l10.94-10.94A3 3 0 1 1 19.5 7.372L8.552 18.32m.009-.01-.01.01m5.699-9.941-7.81 7.81a1.5 1.5 0 0 0 2.112 2.13" />
                  </svg>
                }
                title="Artifacts"
              />

              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                {test.screenshotUrl && (
                  <a
                    href={test.screenshotUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group block rounded-lg border border-[var(--border)] overflow-hidden hover:border-[var(--brand-primary)] transition-colors"
                  >
                    <div className="aspect-video bg-[var(--surface)] relative">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={test.screenshotUrl}
                        alt="Test screenshot"
                        className="w-full h-full object-cover"
                        loading="lazy"
                        onError={(e) => {
                          (e.target as HTMLImageElement).style.display = "none";
                          (e.target as HTMLImageElement).nextElementSibling?.classList.remove("hidden");
                        }}
                      />
                      <div className="hidden absolute inset-0 flex items-center justify-center">
                        <svg className="h-8 w-8 text-[var(--muted)]" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909M3.75 21h16.5A2.25 2.25 0 0 0 22.5 18.75V5.25A2.25 2.25 0 0 0 20.25 3H3.75A2.25 2.25 0 0 0 1.5 5.25v13.5A2.25 2.25 0 0 0 3.75 21Z" />
                        </svg>
                      </div>
                    </div>
                    <div className="px-3 py-2 flex items-center gap-2">
                      <svg className="h-4 w-4 text-[var(--muted)] group-hover:text-[var(--brand-primary)]" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909M3.75 21h16.5A2.25 2.25 0 0 0 22.5 18.75V5.25A2.25 2.25 0 0 0 20.25 3H3.75A2.25 2.25 0 0 0 1.5 5.25v13.5A2.25 2.25 0 0 0 3.75 21Z" />
                      </svg>
                      <span className="text-xs font-medium text-[var(--foreground)]">Screenshot</span>
                      <svg className="ml-auto h-3 w-3 text-[var(--muted)]" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 0 0 3 8.25v10.5A2.25 2.25 0 0 0 5.25 21h10.5A2.25 2.25 0 0 0 18 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
                      </svg>
                    </div>
                  </a>
                )}

                {test.videoUrl && (
                  <div className="rounded-lg border border-[var(--border)] overflow-hidden">
                    <div className="aspect-video bg-[var(--surface-tertiary)]">
                      <video
                        src={test.videoUrl}
                        controls
                        preload="metadata"
                        className="w-full h-full"
                      >
                        <track kind="captions" />
                      </video>
                    </div>
                    <div className="px-3 py-2 flex items-center gap-2">
                      <svg className="h-4 w-4 text-[var(--muted)]" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z" />
                      </svg>
                      <span className="text-xs font-medium text-[var(--foreground)]">Video Recording</span>
                      <a
                        href={test.videoUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="ml-auto"
                      >
                        <svg className="h-3 w-3 text-[var(--muted)] hover:text-[var(--brand-primary)]" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 0 0 3 8.25v10.5A2.25 2.25 0 0 0 5.25 21h10.5A2.25 2.25 0 0 0 18 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
                        </svg>
                      </a>
                    </div>
                  </div>
                )}
              </div>

              {test.traceUrl && <TraceViewer traceUrl={test.traceUrl} />}
            </div>
          )}

          {/* No detail data */}
          {!hasError && !hasSteps && !hasArtifacts && !hasAiSummary && !test.seleniumSessionId && !(test.attempt != null || test.projectName || (test.tags && test.tags.length > 0)) && (
            <div className="px-6 py-4">
              <p className="text-xs text-[var(--muted)]">No additional details available for this test.</p>
            </div>
          )}
        </div>
      )}

      {commandsOpen && test.seleniumSessionId && (
        <SessionCommandsModal
          projectId={projectId}
          runId={runId}
          testId={test.id}
          testTitle={test.fullTitle || test.name}
          seleniumSessionId={test.seleniumSessionId}
          onClose={() => setCommandsOpen(false)}
        />
      )}
    </div>
  );
}

// Modal that shows the WebDriver command tail captured for the Selenium
// session that ran this test. We fetch lazily on open — most users never
// click the button, so the cost is paid only when needed.
function SessionCommandsModal({
  projectId,
  runId,
  testId,
  testTitle,
  seleniumSessionId,
  onClose,
}: {
  projectId: string;
  runId: string;
  testId: string;
  testTitle: string;
  seleniumSessionId: string;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [commands, setCommands] = useState<SeleniumSessionCommand[]>([]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getReportTestSessionCommands(projectId, runId, testId, { limit: 500 })
      .then((data) => {
        if (cancelled) return;
        setCommands(data.commands || []);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Failed to load commands");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, runId, testId]);

  return (
    <Modal
      open
      onClose={onClose}
      title={`WebDriver commands — ${testTitle}`}
      className="max-w-4xl"
    >
      <div className="space-y-3">
        <p className="text-xs text-[var(--muted)]">
          Captured by the Selenium proxy from session{" "}
          <code className="rounded bg-[var(--surface)] px-1 py-0.5 font-mono text-[10px]">
            {seleniumSessionId}
          </code>
          . This is the same tail that powers the live session viewer; the
          last command before the failure is usually the one that broke.
        </p>
        {loading && <PageSkeleton rows={6} />}
        {!loading && error && (
          <ErrorBlock
            title="Could not load commands"
            message={error}
            retry={() => {
              setLoading(true);
              setError(null);
              getReportTestSessionCommands(projectId, runId, testId, {
                limit: 500,
              })
                .then((data) => setCommands(data.commands || []))
                .catch((e) =>
                  setError(e instanceof Error ? e.message : "Failed")
                )
                .finally(() => setLoading(false));
            }}
          />
        )}
        {!loading && !error && commands.length === 0 && (
          <p className="text-xs text-[var(--muted)]">
            No WebDriver commands were captured for this session. The proxy
            only stores a tail; very short sessions or sessions that ended
            before any commands were issued may have nothing to show.
          </p>
        )}
        {!loading && !error && commands.length > 0 && (
          <div className="max-h-[60vh] overflow-auto rounded-lg border border-[var(--border)]">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-[var(--surface-secondary)] text-[10px] uppercase tracking-wide text-[var(--muted)]">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">#</th>
                  <th className="px-3 py-2 text-left font-medium">Command</th>
                  <th className="px-3 py-2 text-left font-medium">Status</th>
                  <th className="px-3 py-2 text-right font-medium">Duration</th>
                </tr>
              </thead>
              <tbody>
                {commands.map((c) => {
                  const failed =
                    c.error || (c.status != null && c.status >= 400);
                  return (
                    <tr
                      key={c.id}
                      className={`border-t border-[var(--border-subtle)] ${
                        failed ? "bg-[var(--error-soft)]" : ""
                      }`}
                    >
                      <td className="px-3 py-1.5 text-[var(--muted)] tabular-nums">
                        {c.sequence}
                      </td>
                      <td className="px-3 py-1.5 font-mono">
                        <span className="text-[var(--foreground)]">
                          {c.command || c.method}
                        </span>
                        <span className="ml-2 text-[10px] text-[var(--muted)]">
                          {c.path}
                        </span>
                        {c.error && (
                          <p className="mt-1 text-[10px] text-[var(--error)] whitespace-pre-wrap">
                            {c.error}
                          </p>
                        )}
                      </td>
                      <td className="px-3 py-1.5 tabular-nums">
                        {c.status ?? "—"}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-[var(--muted)]">
                        {c.durationMs != null ? `${c.durationMs}ms` : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Modal>
  );
}

function TraceViewer({ traceUrl }: { traceUrl: string }) {
  const [showViewer, setShowViewer] = useState(false);
  const viewerUrl = `https://trace.playwright.dev/?trace=${encodeURIComponent(traceUrl)}`;

  return (
    <div className="mt-3">
      {!showViewer ? (
        <div className="rounded-lg border border-[var(--border)] overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3">
            <div className="flex items-center gap-2">
              <svg className="h-5 w-5 text-[var(--brand-primary)]" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
              </svg>
              <div>
                <p className="text-sm font-medium text-[var(--foreground)]">Playwright Trace</p>
                <p className="text-[10px] text-[var(--muted)]">View actions, DOM snapshots, network &amp; console logs</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setShowViewer(true)}
                className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--brand-border)] bg-[var(--brand-soft)] px-3.5 py-1.5 text-xs font-medium text-[var(--brand-primary)] hover:bg-[var(--brand-surface)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_oklab,var(--brand-primary)_30%,transparent)]"
              >
                <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 0 1 0 1.972l-11.54 6.347a1.125 1.125 0 0 1-1.667-.986V5.653Z" />
                </svg>
                View Trace
              </button>
              <a
                href={viewerUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--glass-border)] bg-[var(--glass-bg-subtle)] px-3.5 py-1.5 text-xs font-medium text-[var(--foreground)] backdrop-blur-sm hover:bg-[var(--glass-bg)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_oklab,var(--brand-primary)_30%,transparent)]"
              >
                Open in new tab
                <svg className="h-3 w-3 text-[var(--muted)]" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 0 0 3 8.25v10.5A2.25 2.25 0 0 0 5.25 21h10.5A2.25 2.25 0 0 0 18 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
                </svg>
              </a>
            </div>
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-[var(--border)] overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2 bg-[var(--surface-secondary)] border-b border-[var(--border)]">
            <div className="flex items-center gap-2">
              <svg className="h-4 w-4 text-[var(--brand-primary)]" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
              </svg>
              <span className="text-xs font-medium text-[var(--foreground)]">Playwright Trace Viewer</span>
            </div>
            <div className="flex items-center gap-2">
              <a
                href={viewerUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-[10px] text-[var(--muted)] hover:text-[var(--foreground)] transition-colors"
              >
                Open in new tab
                <svg className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 0 0 3 8.25v10.5A2.25 2.25 0 0 0 5.25 21h10.5A2.25 2.25 0 0 0 18 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
                </svg>
              </a>
              <button
                type="button"
                onClick={() => setShowViewer(false)}
                className="rounded p-1 text-[var(--muted)] hover:text-[var(--foreground)] hover:bg-[var(--surface)] transition-colors"
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
          <iframe
            src={viewerUrl}
            title="Playwright Trace Viewer"
            className="w-full border-0"
            style={{ height: "600px" }}
            sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
          />
        </div>
      )}
    </div>
  );
}

function SectionHeader({
  icon,
  title,
  color,
}: {
  icon: React.ReactNode;
  title: string;
  color?: string;
}) {
  return (
    <div className="flex items-center gap-2" style={{ color: color || "var(--foreground)" }}>
      {icon}
      <h4 className="text-xs font-semibold uppercase tracking-wider">{title}</h4>
    </div>
  );
}
