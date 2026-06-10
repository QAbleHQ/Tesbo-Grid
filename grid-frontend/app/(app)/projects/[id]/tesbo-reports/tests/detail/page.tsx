"use client";

import { use, useEffect, useMemo, useState, useCallback } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  getTestIntelligenceDetail,
  type TestIntelligenceDetailResponse,
} from "@/lib/api";
import {
  Card,
  CardBody,
  EmptyStateBlock,
  ErrorBlock,
  MetricCard,
  PageSkeleton,
  StatusChip,
} from "@/components/ui";

export default function TestIntelligenceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const searchParams = useSearchParams();
  const spec = searchParams.get("spec") || "";
  const testName = searchParams.get("testName") || "";

  const [detail, setDetail] = useState<TestIntelligenceDetailResponse | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dotsLimit, setDotsLimit] = useState<60 | "all">(60);

  const load = useCallback(() => {
    if (!spec || !testName) {
      setError("Missing spec or testName parameter.");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    getTestIntelligenceDetail(id, spec, testName)
      .then(setDetail)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [id, spec, testName]);

  useEffect(() => {
    load();
  }, [load]);

  const stability = useMemo(() => {
    if (!detail?.summary) return { score: 0, label: "Unknown" };
    const total = detail.summary.totalExecutions;
    const passed = detail.summary.passed;
    const score = total > 0 ? Number(((passed * 100) / total).toFixed(2)) : 0;
    const label =
      score >= 90
        ? "Highly stable"
        : score >= 70
          ? "Moderately stable"
          : "Unstable";
    return { score, label };
  }, [detail?.summary]);

  const stabilityTone =
    stability.score >= 90
      ? ("success" as const)
      : stability.score >= 70
        ? ("warning" as const)
        : ("error" as const);

  const failureReasons = useMemo(() => {
    if (!detail) return [];
    const reasonMap = new Map<string, number>();
    for (const run of detail.runs) {
      if (run.testStatus !== "Failed") continue;
      const reason = normalizeFailureReason(run.errorMessage);
      reasonMap.set(reason, (reasonMap.get(reason) || 0) + 1);
    }
    return [...reasonMap.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
  }, [detail]);

  const totalFailures = useMemo(
    () => failureReasons.reduce((acc, r) => acc + r.count, 0),
    [failureReasons],
  );

  const recentDurations = useMemo(() => {
    if (!detail) return [];
    return [...detail.runs]
      .reverse()
      .filter((r) => r.durationMs != null)
      .slice(0, 20)
      .map((r) => ({
        runName: r.runName || r.runId,
        durationMs: r.durationMs!,
        status: r.testStatus,
      }));
  }, [detail]);

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Link
          href={`/projects/${id}/tesbo-reports/tests`}
          className="text-sm text-[var(--brand-primary)] hover:underline"
        >
          &larr; Back to Test Intelligence
        </Link>
        <h1 className="text-2xl font-semibold text-[var(--foreground)]">
          Test Details
        </h1>
        <p className="truncate text-sm text-[var(--foreground)]">
          {testName || "—"}
        </p>
        <p className="truncate font-mono text-xs text-[var(--muted)]">
          {spec || "—"}
        </p>
      </div>

      {loading ? (
        <PageSkeleton rows={4} />
      ) : error ? (
        <ErrorBlock message={error} retry={load} />
      ) : !detail || !detail.summary ? (
        <Card>
          <CardBody>
            <EmptyStateBlock
              title="No detail available"
              description="This test does not have execution data yet."
            />
          </CardBody>
        </Card>
      ) : (
        <>
          {/* Summary metrics */}
          <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
            <MetricCard
              label="Executions"
              value={detail.summary.totalExecutions}
            />
            <MetricCard
              label="Failures"
              value={detail.summary.failed}
              valueColor={detail.summary.failed > 0 ? "var(--error)" : undefined}
            />
            <MetricCard
              label="Failure Rate"
              value={`${detail.summary.failureRate.toFixed(1)}%`}
            />
            <MetricCard
              label="Flaky"
              value={detail.summary.flaky ? "Yes" : "No"}
              valueColor={detail.summary.flaky ? "var(--warning)" : "var(--success)"}
            />
            <MetricCard
              label="Avg Duration"
              value={formatDuration(detail.summary.avgDurationMs)}
            />
          </div>

          {/* Test steps */}
          {(() => {
            const latestWithSteps = detail.runs.find(
              (r) => r.steps && r.steps.length > 0,
            );
            if (!latestWithSteps) return null;
            return (
              <Card>
                <CardBody>
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-sm font-semibold text-[var(--foreground)]">
                        Test Steps ({latestWithSteps.steps.length})
                      </p>
                      <p className="mt-0.5 text-xs text-[var(--muted)]">
                        Steps captured from the most recent run.
                      </p>
                    </div>
                    <InfoTooltip text="The sequence of steps recorded during the most recent execution of this test. Steps are captured at runtime and show each action the test performed in order." />
                  </div>
                  <div className="mt-3 space-y-0 max-h-80 overflow-auto glass-subtle rounded-xl">
                    {latestWithSteps.steps.map((step, i) => (
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
                </CardBody>
              </Card>
            );
          })()}

          {/* Stability overview */}
          <Card>
            <CardBody>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold text-[var(--foreground)]">
                    Stability Overview
                  </p>
                  <p className="mt-0.5 text-xs text-[var(--muted)]">
                    Stability score = passed runs / total runs.
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <StatusChip tone={stabilityTone}>
                    {stability.label}
                  </StatusChip>
                  <div className="glass-subtle inline-flex items-center rounded-xl p-0.5">
                    {([60, "all"] as const).map((n) => (
                      <button
                        key={n}
                        type="button"
                        onClick={() => setDotsLimit(n)}
                        className={`rounded-[10px] px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_oklab,var(--brand-primary)_30%,transparent)] ${dotsLimit === n ? "bg-[var(--glass-bg)] text-[var(--foreground)]" : "text-[var(--muted)] hover:text-[var(--foreground)]"}`}
                      >
                        {n === "all" ? "All" : n}
                      </button>
                    ))}
                  </div>
                  <InfoTooltip text="Shows how consistently this test passes. Each dot represents one run — green is passed, red is failed, grey is skipped. The score is the percentage of passing runs out of total executions." />
                </div>
              </div>
              <div className="mt-2 flex items-end gap-2">
                <p className="text-2xl font-bold text-[var(--foreground)]">
                  {stability.score}%
                </p>
                <p className="pb-0.5 text-xs text-[var(--muted)]">
                  ({detail.summary.passed}/{detail.summary.totalExecutions}{" "}
                  passed)
                </p>
              </div>

              {/* Stability dots */}
              <div className="mt-3 flex flex-wrap gap-1.5">
                {(dotsLimit === "all" ? detail.runs : detail.runs.slice(0, dotsLimit)).map((run, index) => (
                  <Link
                    key={`${run.runId}-${index}`}
                    href={`/projects/${id}/tesbo-reports/runs/${run.runId}`}
                    title={`${run.testStatus} • ${formatDate(run.startedAt)} — click to open run`}
                    className="h-2.5 w-2.5 rounded-full hover:ring-2 hover:ring-offset-1 hover:ring-[var(--border)] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_oklab,var(--brand-primary)_30%,transparent)]"
                    style={{ backgroundColor: dotColor(run.testStatus) }}
                  />
                ))}
              </div>

              {/* Legend */}
              <div className="mt-3 flex items-center gap-4 text-[11px] text-[var(--muted)]">
                <span className="flex items-center gap-1.5">
                  <span
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ backgroundColor: "var(--success)" }}
                  />
                  Passed
                </span>
                <span className="flex items-center gap-1.5">
                  <span
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ backgroundColor: "var(--error)" }}
                  />
                  Failed
                </span>
                <span className="flex items-center gap-1.5">
                  <span
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ backgroundColor: "var(--muted)" }}
                  />
                  Skipped
                </span>
              </div>
            </CardBody>
          </Card>

          {/* Duration trend */}
          {recentDurations.length > 1 && (
            <Card>
              <CardBody>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-[var(--foreground)]">
                      Duration Trend
                    </p>
                    <p className="mt-0.5 text-xs text-[var(--muted)]">
                      Execution time across recent runs (oldest → latest).
                    </p>
                  </div>
                  <InfoTooltip text="Bar chart of this test's execution time per run, coloured by result — blue for passed, red for failed, grey for skipped. Bars are relative to the slowest run shown. Useful for spotting tests that are getting slower over time." />
                </div>
                <DurationBarChart runs={recentDurations} />
              </CardBody>
            </Card>
          )}

          {/* Latest error */}
          {detail.summary.latestErrorMessage && (
            <Card>
              <CardBody>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-[var(--foreground)]">
                      Latest Failure Message
                    </p>
                    <p className="mt-0.5 text-xs text-[var(--muted)]">
                      Error output from the most recent failed run.
                    </p>
                  </div>
                  <InfoTooltip text="The raw error or assertion message captured from the last time this test failed. Helps you quickly understand what broke without having to open the full run log." />
                </div>
                <pre className="mt-3 glass-subtle rounded-xl px-3 py-2.5 font-mono text-[11px] leading-relaxed text-[var(--foreground)] whitespace-pre-wrap break-words line-clamp-6 overflow-hidden">
                  {normalizeFailureReason(detail.summary.latestErrorMessage)}
                </pre>
              </CardBody>
            </Card>
          )}

          {/* Failure reasons */}
          <Card>
            <CardBody>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold text-[var(--foreground)]">
                    Failed Due To (Top Reasons)
                  </p>
                  <p className="mt-0.5 text-xs text-[var(--muted)]">
                    Most common failure reasons across recent runs.
                  </p>
                </div>
                <InfoTooltip text="Groups all failure messages for this test into distinct reasons and ranks them by frequency. The bar shows each reason's share of total failures — a dominant single reason often points to a root-cause bug." />
              </div>
              {failureReasons.length === 0 ? (
                <p className="mt-3 text-sm text-[var(--muted)]">
                  No failure reasons found.
                </p>
              ) : (
                <div className="mt-3 space-y-2">
                  {failureReasons.map((reason) => {
                    const pct =
                      totalFailures > 0
                        ? (reason.count / totalFailures) * 100
                        : 0;
                    return (
                      <div
                        key={reason.reason}
                        className="glass-subtle rounded-xl px-3 py-2"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <p className="line-clamp-2 text-xs text-[var(--foreground)]">
                            {reason.reason}
                          </p>
                          <StatusChip
                            tone="error"
                            className="shrink-0 !text-[10px]"
                          >
                            {reason.count}
                          </StatusChip>
                        </div>
                        {/* Proportional bar */}
                        <div className="mt-2 flex items-center gap-2">
                          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--surface-tertiary)]">
                            <div
                              className="h-full rounded-full bg-[var(--error)]"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                          <span className="text-[10px] tabular-nums text-[var(--muted)]">
                            {pct.toFixed(0)}%
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardBody>
          </Card>

          {/* Run history table */}
          <Card>
            <CardBody className="p-0">
              <div className="border-b border-[var(--border-subtle)] px-4 py-3 flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold text-[var(--foreground)]">
                    Run History
                  </p>
                  <p className="mt-0.5 text-xs text-[var(--muted)]">
                    Latest runs where this test appeared.
                  </p>
                </div>
                <InfoTooltip text="Full per-run breakdown showing the run status, this test's individual result, how long it took, the AI-assigned failure category, confidence score, and the specific error message when it failed." />
              </div>
              {detail.runs.length === 0 ? (
                <p className="p-4 text-sm text-[var(--muted)]">
                  No run history for this test.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <div className="divide-y divide-[var(--border-subtle)] min-w-[860px]">
                    <div className="grid grid-cols-[1.8fr_0.9fr_0.9fr_0.7fr_1fr_0.8fr_1.8fr_0.9fr] gap-2 bg-[var(--surface-secondary)] px-4 py-2 text-[10px] uppercase tracking-wide text-[var(--muted)]">
                      <span>Run</span>
                      <span className="text-center">Run Status</span>
                      <span className="text-center">Test Status</span>
                      <span className="text-right">Duration</span>
                      <span>AI Category</span>
                      <span className="text-right">Confidence</span>
                      <span>Failed Due To</span>
                      <span className="text-right">Started</span>
                    </div>
                    {detail.runs.map((run) => (
                      <div
                        key={`${run.runId}-${run.startedAt || ""}`}
                        className="grid grid-cols-[1.8fr_0.9fr_0.9fr_0.7fr_1fr_0.8fr_1.8fr_0.9fr] gap-2 px-4 py-3 text-sm hover:bg-[var(--surface-secondary)] transition-colors"
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <span
                            className="h-2 w-2 shrink-0 rounded-full"
                            style={{
                              backgroundColor: dotColor(run.testStatus),
                            }}
                          />
                          <Link
                            href={`/projects/${id}/tesbo-reports/runs/${run.runId}`}
                            className="truncate text-[var(--foreground)] hover:underline"
                          >
                            {run.runName || run.runId}
                          </Link>
                        </div>
                        <CellValue value={run.runStatus} align="center" />
                        <CellValue
                          value={run.testStatus}
                          tone={statusTone(run.testStatus)}
                          align="center"
                        />
                        <CellValue value={formatDuration(run.durationMs)} align="right" />
                        <CellValue value={run.aiAnalysisCategory ? AI_CATEGORY_LABEL[run.aiAnalysisCategory] ?? run.aiAnalysisCategory : "—"} align="left" />
                        <CellValue
                          value={
                            run.aiAnalysisConfidence != null
                              ? `${run.aiAnalysisConfidence}%`
                              : "—"
                          }
                          align="right"
                        />
                        <CellValue
                          value={
                            run.testStatus === "Failed"
                              ? normalizeFailureReason(run.errorMessage)
                              : "—"
                          }
                          align="left"
                        />
                        <CellValue value={formatDate(run.startedAt)} align="right" />
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </CardBody>
          </Card>
        </>
      )}
    </div>
  );
}

/* ─── Local components ─── */


function CellValue({
  value,
  tone,
  align = "right",
}: {
  value: string | number;
  tone?: "success" | "error" | "warning";
  align?: "left" | "center" | "right";
}) {
  const colorVar =
    tone === "success"
      ? "var(--success)"
      : tone === "error"
        ? "var(--error)"
        : tone === "warning"
          ? "var(--warning)"
          : "var(--foreground)";
  const alignClass =
    align === "left"
      ? "text-left"
      : align === "center"
        ? "text-center"
        : "text-right";
  return (
    <p
      className={`${alignClass} tabular-nums truncate text-xs`}
      style={{ color: colorVar }}
      title={String(value)}
    >
      {value}
    </p>
  );
}

function DurationBarChart({
  runs,
}: {
  runs: { runName: string; durationMs: number; status: string }[];
}) {
  const maxDuration = Math.max(1, ...runs.map((r) => r.durationMs));

  return (
    <div className="mt-3 flex items-end gap-1 h-32">
      {runs.map((run, i) => {
        const heightPct = (run.durationMs / maxDuration) * 100;
        return (
          <div
            key={i}
            className="flex flex-col items-center gap-1 flex-1 min-w-[6px] h-full justify-end"
          >
            <div
              className="w-full rounded-t-sm transition-all opacity-80 hover:opacity-100"
              style={{
                height: `${Math.max(4, heightPct)}%`,
                backgroundColor:
                  run.status === "Passed"
                    ? "var(--brand-primary)"
                    : run.status === "Failed"
                      ? "var(--error)"
                      : "var(--muted)",
              }}
              title={`${run.runName}: ${formatDuration(run.durationMs)}`}
            />
          </div>
        );
      })}
    </div>
  );
}

function InfoTooltip({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative shrink-0">
      <button
        type="button"
        aria-label="More information"
        aria-expanded={open}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className="flex items-center justify-center h-5 w-5 rounded-full border border-[var(--border-subtle)] text-[var(--muted)] hover:text-[var(--foreground)] hover:border-[var(--border)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_oklab,var(--brand-primary)_30%,transparent)] transition-colors"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
          <text x="5" y="8.5" textAnchor="middle" fill="currentColor" fontSize="9" fontWeight="700" fontFamily="serif">i</text>
        </svg>
      </button>
      {open && (
        <div className="absolute right-0 top-7 z-50 w-60">
          <div className="glass-strong rounded-xl border border-[var(--glass-border)] p-3 shadow-lg">
            <p className="text-xs text-[var(--foreground)] leading-relaxed">{text}</p>
          </div>
        </div>
      )}
    </div>
  );
}

const AI_CATEGORY_LABEL: Record<string, string> = {
  ACTUAL_BUG: "Actual Bug",
  FEATURE_CHANGE: "Feature Change",
  SCRIPT_ISSUE: "Script Issue",
  ENVIRONMENT_ISSUE: "Environment Issue",
};

function dotColor(status: string) {
  if (status === "Passed") return "var(--success)";
  if (status === "Failed") return "var(--error)";
  return "var(--muted)";
}

function statusTone(status: string) {
  if (status === "Passed") return "success" as const;
  if (status === "Failed") return "error" as const;
  return undefined;
}

function formatDuration(ms: number | null) {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${Math.round(ms / 1000)}s`;
}

function formatDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString();
}

function normalizeFailureReason(message: string | null) {
  if (!message || !message.trim()) return "Unknown failure reason";
  const firstLine = message.split("\n")[0].trim();
  return firstLine.length > 120
    ? `${firstLine.slice(0, 117)}...`
    : firstLine;
}
