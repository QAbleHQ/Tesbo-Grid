"use client";

import { useEffect, useState, useCallback, use } from "react";
import Link from "next/link";
import { listReportRuns, type ReportRun } from "@/lib/api";
import {
  Button,
  Card,
  CardBody,
  EmptyStateBlock,
  ErrorBlock,
  MetricCard,
  PageSkeleton,
  StatusChip,
} from "@/components/ui";

const STATUS_TONE: Record<string, "success" | "error" | "warning" | "neutral"> = {
  COMPLETED: "success",
  FAILED: "error",
  IN_PROGRESS: "warning",
  CANCELLED: "neutral",
  TIMED_OUT: "neutral",
};

const STATUS_LABEL: Record<string, string> = {
  COMPLETED: "Completed",
  FAILED: "Failed",
  IN_PROGRESS: "Running",
  CANCELLED: "Cancelled",
  TIMED_OUT: "Timed Out",
};

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
    hour12: true,
  });
}

function runSortTime(run: ReportRun) {
  const source = run.startedAt || run.createdAt;
  const time = source ? new Date(source).getTime() : 0;
  return Number.isFinite(time) ? time : 0;
}

function passRate(run: ReportRun): string {
  if (run.totalTests === 0) return "—";
  return `${Math.round((run.passed / run.totalTests) * 100)}%`;
}

function DistributionBar({ passed, failed, skipped, total }: { passed: number; failed: number; skipped: number; total: number }) {
  if (total === 0) return null;
  const pPct = (passed / total) * 100;
  const fPct = (failed / total) * 100;
  const sPct = (skipped / total) * 100;

  return (
    <div className="flex h-1.5 w-28 overflow-hidden rounded-full bg-[var(--surface-tertiary)]">
      {passed > 0 && (
        <div className="h-full" style={{ width: `${pPct}%`, backgroundColor: "var(--success)" }} />
      )}
      {failed > 0 && (
        <div className="h-full" style={{ width: `${fPct}%`, backgroundColor: "var(--error)" }} />
      )}
      {skipped > 0 && (
        <div className="h-full" style={{ width: `${sPct}%`, backgroundColor: "var(--muted)" }} />
      )}
    </div>
  );
}

export default function AutomationRunsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [runs, setRuns] = useState<ReportRun[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const limit = 20;

  const loadRuns = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listReportRuns(id, page, limit);
      setRuns(data.runs);
      setTotal(data.total);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load runs");
    } finally {
      setLoading(false);
    }
  }, [id, page]);

  useEffect(() => {
    loadRuns();
  }, [loadRuns]);

  const totalPages = Math.ceil(total / limit);
  const sortedRuns = [...runs].sort((a, b) => runSortTime(b) - runSortTime(a));

  const allCompleted = runs.reduce((n, r) => n + (r.status === "COMPLETED" ? 1 : 0), 0);
  const allFailed = runs.reduce((n, r) => n + (r.status === "FAILED" ? 1 : 0), 0);
  const allInProgress = runs.reduce((n, r) => n + (r.status === "IN_PROGRESS" ? 1 : 0), 0);

  if (loading) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--foreground)]">Automation Runs</h1>
          <p className="text-sm text-[var(--muted)]">View execution runs and their results</p>
        </div>
        <PageSkeleton rows={6} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--foreground)]">Automation Runs</h1>
          <p className="text-sm text-[var(--muted)]">View execution runs and their results</p>
        </div>
        <ErrorBlock title="Failed to load runs" message={error} retry={loadRuns} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--foreground)]">Automation Runs</h1>
          <p className="text-sm text-[var(--muted)]">View execution runs and their results</p>
        </div>
        {total > 0 && (
          <span className="text-sm tabular-nums text-[var(--muted)]">
            {total} run{total !== 1 && "s"} total
          </span>
        )}
      </div>

      {/* Metrics */}
      {runs.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-4">
          <MetricCard label="Total Runs" value={total} />
          <MetricCard label="Completed" value={allCompleted} valueColor="var(--success)" />
          <MetricCard label="Failed" value={allFailed} valueColor={allFailed > 0 ? "var(--error)" : undefined} />
          <MetricCard label="In Progress" value={allInProgress} valueColor={allInProgress > 0 ? "var(--warning)" : undefined} />
        </div>
      )}

      {/* Run list */}
      {runs.length === 0 ? (
        <Card>
          <CardBody>
            <EmptyStateBlock
              title="No runs yet"
              description="Run your first test to see results here. Check the Integration Guide for setup instructions."
            />
          </CardBody>
        </Card>
      ) : (
        <div className="space-y-2">
          {sortedRuns.map((run, index) => {
            const runNumber = total - (page - 1) * limit - index;
            const tone = STATUS_TONE[run.status] ?? "neutral";
            const label = STATUS_LABEL[run.status] ?? run.status;

            return (
              <Link
                key={run.id}
                href={`/projects/${id}/tesbo-reports/runs/${run.id}`}
                className="block group"
              >
                <Card>
                  <CardBody className="px-5 py-4 group-hover:bg-[var(--surface-secondary)] transition-colors rounded-xl">
                    <div className="flex items-center gap-4">
                      {/* Left: name + time */}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2.5">
                          <p className="text-sm font-semibold text-[var(--foreground)] truncate">
                            {run.runName || `Automation Run #${runNumber > 0 ? runNumber : index + 1}`}
                          </p>
                          <StatusChip tone={tone} live={run.status === "IN_PROGRESS"}>
                            {label}
                          </StatusChip>
                        </div>
                        <p className="mt-0.5 text-xs text-[var(--muted)]">
                          {formatTime(run.startedAt || run.createdAt)}
                        </p>
                      </div>

                      {/* Center: distribution */}
                      <div className="hidden sm:flex flex-col items-end gap-1 shrink-0">
                        <div className="flex items-center gap-3 text-xs font-medium tabular-nums">
                          <span className="text-[var(--success)]">{run.passed} passed</span>
                          {run.failed > 0 && (
                            <span className="text-[var(--error)]">{run.failed} failed</span>
                          )}
                          {run.skipped > 0 && (
                            <span className="text-[var(--muted)]">{run.skipped} skip</span>
                          )}
                        </div>
                        <DistributionBar
                          passed={run.passed}
                          failed={run.failed}
                          skipped={run.skipped}
                          total={run.totalTests}
                        />
                      </div>

                      {/* Right: pass rate, duration, chevron */}
                      <div className="flex items-center gap-4 shrink-0">
                        {run.releaseRiskScore != null && (
                          <StatusChip
                            tone={
                              run.releaseRiskLevel === "CRITICAL" || run.releaseRiskLevel === "HIGH"
                                ? "error"
                                : run.releaseRiskLevel === "MEDIUM"
                                  ? "warning"
                                  : "success"
                            }
                          >
                            Risk {run.releaseRiskScore}
                          </StatusChip>
                        )}
                        <span className="hidden md:inline text-xs font-semibold tabular-nums text-[var(--foreground)]">
                          {passRate(run)}
                        </span>
                        <span className="text-xs text-[var(--muted)] w-16 text-right tabular-nums">
                          {formatDuration(run.durationMs)}
                        </span>
                        <svg
                          className="h-4 w-4 text-[var(--muted)] group-hover:text-[var(--foreground)] transition-colors"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth={2}
                          viewBox="0 0 24 24"
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                        </svg>
                      </div>
                    </div>
                  </CardBody>
                </Card>
              </Link>
            );
          })}

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between pt-3">
              <p className="text-xs text-[var(--muted)] tabular-nums">
                Showing {(page - 1) * limit + 1}–{Math.min(page * limit, total)} of {total}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => p - 1)}
                >
                  Previous
                </Button>
                <span className="text-xs text-[var(--muted)] tabular-nums px-2">
                  {page} / {totalPages}
                </span>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

