"use client";

import { use, useEffect, useMemo, useState, useCallback } from "react";
import Link from "next/link";
import {
  getSpecIntelligence,
  type SpecIntelligenceItem,
} from "@/lib/api";
import {
  Card,
  CardBody,
  EmptyStateBlock,
  ErrorBlock,
  Input,
  MetricCard,
  PageSkeleton,
  StatusChip,
} from "@/components/ui";

export default function SpecIntelligencePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [items, setItems] = useState<SpecIntelligenceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    getSpecIntelligence(id)
      .then((response) => setItems(response.specs))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const overview = useMemo(() => {
    const total = items.length;
    const highRisk = items.filter((i) => i.failureRate >= 50).length;
    const mediumRisk = items.filter(
      (i) => i.failureRate >= 20 && i.failureRate < 50,
    ).length;
    const avgFailureRate =
      total > 0
        ? items.reduce((acc, i) => acc + i.failureRate, 0) / total
        : 0;
    return { total, highRisk, mediumRisk, avgFailureRate };
  }, [items]);

  if (loading) return <PageSkeleton rows={6} />;

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader />
        <ErrorBlock message={error} retry={load} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader />

      {items.length > 0 && (
        <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
          <MetricCard label="Total Specs" value={overview.total} />
          <MetricCard label="High Risk" value={overview.highRisk} valueColor={overview.highRisk > 0 ? "var(--error)" : undefined} />
          <MetricCard label="Medium Risk" value={overview.mediumRisk} valueColor={overview.mediumRisk > 0 ? "var(--warning)" : undefined} />
          <MetricCard label="Avg Failure Rate" value={`${overview.avgFailureRate.toFixed(1)}%`} />
        </div>
      )}

      <Card>
        <CardBody className="p-0">
          {items.length === 0 ? (
            <div className="p-4">
              <EmptyStateBlock
                title="No spec intelligence available"
                description="Run tests for this project to generate cross-run spec analysis."
              />
            </div>
          ) : (
            <>
              {/* Search bar */}
              <div className="px-4 py-3 border-b border-[var(--border-subtle)]">
                <Input
                  type="search"
                  placeholder="Search specs…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="max-w-xs"
                />
              </div>

              {/* Desktop table header */}
              <div className="hidden lg:grid grid-cols-[1.4fr_repeat(7,minmax(0,1fr))] gap-3 border-b border-[var(--border-subtle)] bg-[var(--surface-secondary)] px-4 py-2 text-[10px] uppercase tracking-wide text-[var(--muted)]">
                <span>Spec</span>
                <span className="text-right">Exec</span>
                <span className="text-right">Failed</span>
                <span className="text-right">Fail %</span>
                <span className="text-right">Avg Time</span>
                <span className="text-right">Bugs</span>
                <span className="text-right">Env/Script</span>
                <span className="text-right">Last Status</span>
              </div>

              <div className="divide-y divide-[var(--border-subtle)]">
                {(search ? items.filter((i) => i.spec.toLowerCase().includes(search.toLowerCase())) : items).map((item) => (
                  <Link
                    key={item.spec}
                    href={`/projects/${id}/tesbo-reports/specs/detail?spec=${encodeURIComponent(item.spec)}`}
                    className="block hover:bg-[var(--surface-secondary)] transition-colors"
                    style={{ borderLeft: `3px solid ${riskColor(item.failureRate)}` }}
                  >
                    {/* Desktop row */}
                    <div className="hidden lg:grid grid-cols-[1.4fr_repeat(7,minmax(0,1fr))] gap-3 px-4 py-3 text-sm items-center">
                      <div className="min-w-0">
                        <p className="truncate font-medium text-[var(--foreground)]">
                          {item.spec}
                        </p>
                        <div className="mt-0.5 flex items-center gap-1.5 text-xs">
                          <span className="text-[var(--muted)]">
                            {formatDate(item.lastSeenAt)}
                          </span>
                          {(item.actualBugFailures > 0 || item.featureChangeFailures > 0 || item.scriptIssueFailures > 0 || item.environmentIssueFailures > 0) && (
                            <StatusChip tone={item.actualBugFailures > 0 ? "error" : "ai"} className="!text-[9px] !px-1.5 !py-0">
                              {item.actualBugFailures > 0 ? `${item.actualBugFailures} bug` : `${item.featureChangeFailures + item.scriptIssueFailures + item.environmentIssueFailures} issues`}
                            </StatusChip>
                          )}
                        </div>
                      </div>
                      <Metric value={item.totalExecutions} />
                      <Metric
                        value={item.failed}
                        danger={item.failed > 0}
                      />
                      <div className="text-right">
                        <p className="tabular-nums text-[var(--foreground)]">
                          {item.failureRate.toFixed(1)}%
                        </p>
                        <FailureBar rate={item.failureRate} />
                      </div>
                      <Metric value={formatDuration(item.avgDurationMs)} />
                      <Metric value={item.actualBugFailures} />
                      <Metric value={item.featureChangeFailures + item.scriptIssueFailures + item.environmentIssueFailures} />
                      <div className="flex justify-end">
                        <StatusChip tone={statusTone(item.lastStatus)}>
                          {item.lastStatus || "Unknown"}
                        </StatusChip>
                      </div>
                    </div>

                    {/* Mobile card layout */}
                    <div className="lg:hidden px-4 py-3 space-y-2">
                      <div className="flex items-start justify-between gap-2">
                        <p className="truncate text-sm font-medium text-[var(--foreground)]">
                          {item.spec}
                        </p>
                        <StatusChip tone={statusTone(item.lastStatus)} className="shrink-0">
                          {item.lastStatus || "Unknown"}
                        </StatusChip>
                      </div>
                      <FailureBar rate={item.failureRate} />
                      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-[var(--muted)]">
                        <Stat label="Executions" value={item.totalExecutions} />
                        <Stat label="Failed" value={item.failed} />
                        <Stat label="Fail %" value={`${item.failureRate.toFixed(1)}%`} />
                        <Stat label="Avg Time" value={formatDuration(item.avgDurationMs)} />
                        <Stat label="AI Bugs" value={item.actualBugFailures} />
                        <Stat label="Env/Script" value={item.featureChangeFailures + item.scriptIssueFailures + item.environmentIssueFailures} />
                      </div>
                      <p className="text-xs text-[var(--muted)]">
                        Last seen {formatDate(item.lastSeenAt)}
                      </p>
                    </div>
                  </Link>
                ))}
              </div>
            </>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

function PageHeader() {
  return (
    <div>
      <h1 className="text-2xl font-semibold text-[var(--foreground)]">
        Spec Intelligence
      </h1>
      <p className="text-sm text-[var(--muted)]">
        Spec-level reliability and failure patterns across all runs
      </p>
    </div>
  );
}

function Metric({
  value,
  danger = false,
}: {
  value: string | number;
  danger?: boolean;
}) {
  return (
    <p
      className="text-right tabular-nums"
      style={{ color: danger ? "var(--error)" : "var(--foreground)" }}
    >
      {value}
    </p>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <p>
      {label}:{" "}
      <span className="font-medium text-[var(--foreground)]">{value}</span>
    </p>
  );
}

function FailureBar({ rate }: { rate: number }) {
  return (
    <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-[var(--surface-secondary)]">
      <div
        className="h-full rounded-full transition-all"
        style={{
          width: `${Math.min(100, Math.max(0, rate))}%`,
          backgroundColor: riskColor(rate),
        }}
      />
    </div>
  );
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

function riskColor(failureRate: number) {
  if (failureRate >= 50) return "var(--error)";
  if (failureRate >= 20) return "var(--warning)";
  return "var(--success)";
}

function statusTone(status: string | null) {
  if (!status) return "neutral" as const;
  const s = status.toLowerCase();
  if (s === "passed") return "success" as const;
  if (s === "failed") return "error" as const;
  if (s === "skipped") return "warning" as const;
  return "neutral" as const;
}
