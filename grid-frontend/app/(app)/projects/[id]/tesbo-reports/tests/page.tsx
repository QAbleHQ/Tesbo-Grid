"use client";

import { use, useEffect, useMemo, useState, useCallback } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import {
  getTestIntelligence,
  type TestIntelligenceItem,
} from "@/lib/api";
import {
  Banner,
  Card,
  CardBody,
  EmptyStateBlock,
  ErrorBlock,
  Input,
  MetricCard,
  PageSkeleton,
  Select,
  StatusChip,
} from "@/components/ui";

export default function TestIntelligencePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [items, setItems] = useState<TestIntelligenceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState(searchParams.get("search") || "");
  const [flakyFilter, setFlakyFilter] = useState<"all" | "flaky" | "stable">(
    searchParams.get("flaky") === "true" ? "flaky" : "all",
  );
  const [statusFilter, setStatusFilter] = useState<
    "all" | "Passed" | "Failed" | "Skipped"
  >((searchParams.get("status") as "all" | "Passed" | "Failed" | "Skipped") || "all");
  const [minFailureRate, setMinFailureRate] = useState<0 | 10 | 25 | 50>(
    (Number(searchParams.get("minFailure") || 0) as 0 | 10 | 25 | 50) || 0,
  );

  // Persist filter state to URL
  const updateUrl = useCallback((updates: Record<string, string | undefined>) => {
    const params = new URLSearchParams(searchParams.toString());
    Object.entries(updates).forEach(([k, v]) => {
      if (!v || v === "all" || v === "0" || v === "") {
        params.delete(k);
      } else {
        params.set(k, v);
      }
    });
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }, [searchParams, router, pathname]);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    getTestIntelligence(id)
      .then((response) => setItems(response.tests))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const filteredItems = useMemo(() => {
    return items.filter((item) => {
      const query = search.trim().toLowerCase();
      const matchesSearch =
        !query ||
        item.testName.toLowerCase().includes(query) ||
        item.spec.toLowerCase().includes(query);
      const matchesFlaky =
        flakyFilter === "all" ||
        (flakyFilter === "flaky" && item.flaky) ||
        (flakyFilter === "stable" && !item.flaky);
      const matchesStatus =
        statusFilter === "all" || item.lastStatus === statusFilter;
      const matchesFailureRate = item.failureRate >= minFailureRate;
      return matchesSearch && matchesFlaky && matchesStatus && matchesFailureRate;
    });
  }, [items, search, flakyFilter, statusFilter, minFailureRate]);

  const overview = useMemo(() => {
    const total = filteredItems.length;
    const flaky = filteredItems.filter((i) => i.flaky).length;
    const stable = total - flaky;
    const avgFailureRate =
      total > 0
        ? filteredItems.reduce((acc, i) => acc + i.failureRate, 0) / total
        : 0;
    return { total, flaky, stable, avgFailureRate };
  }, [filteredItems]);

  const totalFlakyCount = useMemo(
    () => items.filter((i) => i.flaky).length,
    [items],
  );

  const hasActiveFilters =
    flakyFilter !== "all" ||
    statusFilter !== "all" ||
    minFailureRate > 0 ||
    search.trim() !== "";

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

      {/* Flaky tests alert */}
      {totalFlakyCount > 0 && flakyFilter !== "flaky" && (
        <Banner
          tone="warning"
          title={`${totalFlakyCount} flaky ${totalFlakyCount === 1 ? "test" : "tests"} detected`}
          description="Tests with inconsistent pass/fail results across runs."
          action={
            <button
              type="button"
              onClick={() => {
                setFlakyFilter("flaky");
                updateUrl({ flaky: "true" });
              }}
              className="rounded-xl border border-[var(--warning-border)] bg-[var(--warning-soft)] px-3.5 py-1.5 text-xs font-semibold text-[var(--warning-foreground)] hover:brightness-95 transition whitespace-nowrap"
            >
              Show flaky only
            </button>
          }
        />
      )}

      {/* Search */}
      <Input
        type="text"
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
          updateUrl({ search: e.target.value });
        }}
        placeholder="Search by test name or spec path"
      />

      {/* Filters */}
      <div className="grid gap-2 grid-cols-2 sm:grid-cols-4">
        <Select
          value={flakyFilter}
          onChange={(e) => {
            const v = e.target.value as "all" | "flaky" | "stable";
            setFlakyFilter(v);
            updateUrl({ flaky: v === "flaky" ? "true" : undefined });
          }}
        >
          <option value="all">All Flakiness</option>
          <option value="flaky">Flaky only</option>
          <option value="stable">Stable only</option>
        </Select>
        <Select
          value={statusFilter}
          onChange={(e) => {
            const v = e.target.value as "all" | "Passed" | "Failed" | "Skipped";
            setStatusFilter(v);
            updateUrl({ status: v });
          }}
        >
          <option value="all">All Last Status</option>
          <option value="Failed">Last status: Failed</option>
          <option value="Passed">Last status: Passed</option>
          <option value="Skipped">Last status: Skipped</option>
        </Select>
        <Select
          value={String(minFailureRate)}
          onChange={(e) => {
            const v = Number(e.target.value) as 0 | 10 | 25 | 50;
            setMinFailureRate(v);
            updateUrl({ minFailure: v > 0 ? String(v) : undefined });
          }}
        >
          <option value="0">Min failure rate: 0%</option>
          <option value="10">Min failure rate: 10%</option>
          <option value="25">Min failure rate: 25%</option>
          <option value="50">Min failure rate: 50%</option>
        </Select>
        <button
          type="button"
          onClick={() => {
            setFlakyFilter("all");
            setStatusFilter("all");
            setMinFailureRate(0);
            setSearch("");
            router.replace(pathname, { scroll: false });
          }}
          className="rounded-xl border border-[var(--glass-border-soft)] bg-[var(--glass-bg-subtle)] px-3 py-2 text-sm font-medium text-[var(--foreground)] hover:bg-[var(--glass-bg)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_oklab,var(--brand-primary)_30%,transparent)]"
        >
          Reset Filters
        </button>
      </div>

      {/* Active filter chips */}
      {hasActiveFilters && (
        <div className="flex flex-wrap items-center gap-2">
          {flakyFilter !== "all" && (
            <FilterChip label={`Flakiness: ${flakyFilter}`} />
          )}
          {statusFilter !== "all" && (
            <FilterChip label={`Last status: ${statusFilter}`} />
          )}
          {minFailureRate > 0 && (
            <FilterChip label={`Min failure: ${minFailureRate}%`} />
          )}
          {search.trim() && (
            <FilterChip label={`Search: "${search.trim()}"`} />
          )}
        </div>
      )}

      {/* Overview stats */}
      {overview.total > 0 && (
        <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
          <MetricCard label="Visible Tests" value={overview.total} />
          <MetricCard
            label="Flaky"
            value={overview.flaky}
            valueColor={overview.flaky > 0 ? "var(--warning)" : undefined}
          />
          <MetricCard label="Stable" value={overview.stable} valueColor="var(--success)" />
          <MetricCard
            label="Avg Failure Rate"
            value={`${Math.round(overview.avgFailureRate)}%`}
            valueColor={overview.avgFailureRate > 20 ? "var(--error)" : undefined}
          />
        </div>
      )}

      {/* Test list */}
      <Card>
        <CardBody className="p-0">
          {filteredItems.length === 0 ? (
            <div className="p-4">
              <EmptyStateBlock
                title={
                  items.length === 0
                    ? "No test intelligence available"
                    : "No matching tests"
                }
                description={
                  items.length === 0
                    ? "Run tests for this project to generate cross-run test analysis."
                    : "Adjust your search to see test-level analysis results."
                }
              />
            </div>
          ) : (
            <div className="divide-y divide-[var(--border-subtle)]">
              <div className="flex items-center justify-end px-4 py-2 text-[11px] text-[var(--muted)] bg-[var(--surface-secondary)]">
                <span>Click any row to open test details</span>
              </div>
              {filteredItems.map((item) => (
                <Link
                  key={`${item.spec}:${item.testName}`}
                  href={`/projects/${id}/tesbo-reports/tests/detail?spec=${encodeURIComponent(item.spec)}&testName=${encodeURIComponent(item.testName)}`}
                  className="block px-4 py-3 hover:bg-[var(--surface-secondary)] transition-colors"
                  style={{
                    borderLeft: `3px solid ${riskColor(item.failureRate)}`,
                  }}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-[var(--foreground)]">
                        {item.testName}
                      </p>
                      <p className="truncate text-xs font-mono text-[var(--muted)]">
                        {item.spec}
                      </p>
                    </div>
                    <div className="shrink-0 flex items-center gap-1.5 flex-wrap justify-end">
                      <StatusChip tone={item.flaky ? "warning" : "success"}>
                        {item.flaky ? "Flaky" : "Stable"}
                      </StatusChip>
                      {item.flakyScore != null && (
                        <StatusChip tone={item.flakyScore >= 70 ? "warning" : "neutral"}>
                          Flaky score {item.flakyScore}
                        </StatusChip>
                      )}
                      {item.probableRegression && (
                        <StatusChip tone="error">Regression</StatusChip>
                      )}
                      <StatusChip
                        tone={statusTone(item.lastStatus)}
                      >
                        {item.lastStatus || "Unknown"}
                      </StatusChip>
                      {(item.actualBugFailures > 0 || item.featureChangeFailures > 0 || item.scriptIssueFailures > 0 || item.environmentIssueFailures > 0) && (
                        <StatusChip tone={item.actualBugFailures > 0 ? "error" : "ai"}>
                          {item.actualBugFailures > 0 && `${item.actualBugFailures} bug${item.actualBugFailures !== 1 ? "s" : ""}`}
                          {item.actualBugFailures > 0 && (item.featureChangeFailures + item.scriptIssueFailures + item.environmentIssueFailures) > 0 && " · "}
                          {(item.featureChangeFailures + item.scriptIssueFailures + item.environmentIssueFailures) > 0 && `${item.featureChangeFailures + item.scriptIssueFailures + item.environmentIssueFailures} other`}
                        </StatusChip>
                      )}
                    </div>
                  </div>

                  {/* Stats grid */}
                  <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
                    <Stat label="Executions" value={item.totalExecutions} />
                    <Stat label="Failures" value={item.failed} />
                    <Stat
                      label="Flaky Trend"
                      value={
                        item.flakyTrendSlope == null
                          ? "—"
                          : item.flakyTrendSlope > 0
                            ? `+${item.flakyTrendSlope.toFixed(2)}`
                            : item.flakyTrendSlope.toFixed(2)
                      }
                    />
                    <Stat
                      label="Avg Time"
                      value={formatDuration(item.avgDurationMs)}
                    />
                    <Stat
                      label="Last Run"
                      value={formatDate(item.lastSeenAt)}
                    />
                  </div>
                  {item.likelyFlakyReason && (
                    <p className="mt-2 text-xs text-[var(--muted)]">
                      {item.likelyFlakyReason}
                    </p>
                  )}
                </Link>
              ))}
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

/* ─── Local components ─── */

function PageHeader() {
  return (
    <div>
      <h1 className="text-2xl font-semibold text-[var(--foreground)]">
        Test Intelligence
      </h1>
      <p className="text-sm text-[var(--muted)]">
        Individual test reliability and flakiness patterns across all runs
      </p>
    </div>
  );
}

function FilterChip({ label }: { label: string }) {
  return (
    <span className="rounded-full bg-[var(--brand-soft)] px-2.5 py-1 text-[11px] font-medium text-[var(--brand-primary)]">
      {label}
    </span>
  );
}


function Stat({
  label,
  value,
}: {
  label: string;
  value: string | number;
}) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wide text-[var(--muted)]">{label}</p>
      <p className="text-sm font-semibold text-[var(--foreground)]">{value}</p>
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
