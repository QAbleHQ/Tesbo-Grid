"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  listReportRuns,
  getSpecIntelligence,
  getTestIntelligence,
  getProject,
  type ProjectDetail,
  type ReportRun,
  type SpecIntelligenceItem,
  type TestIntelligenceItem,
} from "@/lib/api";
import {
  Banner,
  Card,
  CardBody,
  EmptyStateBlock,
  ErrorBlock,
  MetricCard,
  PageSkeleton,
  SectionHeader,
  StatusChip,
} from "@/components/ui";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return remM > 0 ? `${h}h ${remM}m` : `${h}h`;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function riskTone(rate: number): "error" | "warning" | "success" {
  if (rate >= 0.5) return "error";
  if (rate >= 0.2) return "warning";
  return "success";
}

function riskColor(rate: number): string {
  if (rate >= 0.5) return "var(--error)";
  if (rate >= 0.2) return "var(--warning)";
  return "var(--success)";
}

function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

/* ------------------------------------------------------------------ */
/*  Data state                                                         */
/* ------------------------------------------------------------------ */

type DashboardData = {
  project: ProjectDetail | null;
  runs: ReportRun[];
  runsTotal: number;
  specs: SpecIntelligenceItem[];
  tests: TestIntelligenceItem[];
};

type LoadState = "loading" | "loaded" | "error";

/* ------------------------------------------------------------------ */
/*  Page                                                               */
/* ------------------------------------------------------------------ */

export default function ProjectDashboardPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);

  const [state, setState] = useState<LoadState>("loading");
  const [data, setData] = useState<DashboardData>({
    project: null,
    runs: [],
    runsTotal: 0,
    specs: [],
    tests: [],
  });
  const [errorMsg, setErrorMsg] = useState("");

  const load = useCallback(async () => {
    setState("loading");
    const results = await Promise.allSettled([
      getProject(id),
      listReportRuns(id, 1, 10),
      getSpecIntelligence(id, 1, 50),
      getTestIntelligence(id, 1, 100),
    ]);

    const allFailed = results.every((r) => r.status === "rejected");
    if (allFailed) {
      setErrorMsg(
        results[0].status === "rejected"
          ? (results[0].reason as Error).message
          : "All API calls failed"
      );
      setState("error");
      return;
    }

    setData({
      project:
        results[0].status === "fulfilled" ? results[0].value : null,
      runs:
        results[1].status === "fulfilled" ? results[1].value.runs : [],
      runsTotal:
        results[1].status === "fulfilled" ? results[1].value.total : 0,
      specs:
        results[2].status === "fulfilled" ? results[2].value.specs : [],
      tests:
        results[3].status === "fulfilled" ? results[3].value.tests : [],
    });
    setState("loaded");
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  if (state === "loading") {
    return (
      <div className="tesbo-page">
        <PageSkeleton rows={4} />
      </div>
    );
  }

  if (state === "error") {
    return (
      <div className="tesbo-page">
        <ErrorBlock message={errorMsg} retry={load} />
      </div>
    );
  }

  const { project, runs, runsTotal, specs, tests } = data;
  const projectName = project?.name || "Project";

  /* ---------- computed metrics ---------- */
  const recentRuns = runs.slice(0, 10);
  const passRate =
    recentRuns.length > 0
      ? recentRuns.reduce((sum, r) => {
          const total = r.totalTests || 1;
          return sum + r.passed / total;
        }, 0) / recentRuns.length
      : null;

  const avgDuration =
    recentRuns.length > 0
      ? recentRuns.reduce((sum, r) => sum + (r.durationMs ?? 0), 0) /
        recentRuns.filter((r) => r.durationMs != null).length || null
      : null;

  const flakyTests = tests.filter((t) => t.flaky);
  const topFailingSpecs = [...specs]
    .filter((s) => s.failureRate > 0)
    .sort((a, b) => b.failureRate - a.failureRate)
    .slice(0, 5);

  const top3FlakyNames = flakyTests.slice(0, 3).map((t) => t.testName).join(", ");

  return (
    <div className="tesbo-page space-y-6">
      {/* Page heading */}
      <div>
        <h1 className="text-2xl font-semibold text-[var(--foreground)]">
          {projectName}
        </h1>
        <p className="text-sm text-[var(--muted)]">
          Project overview and health snapshot
        </p>
      </div>

      {/* 1 — Health Summary Row */}
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label="Total Runs"
          value={String(runsTotal)}
          sub={
            recentRuns.length > 0
              ? `Latest ${relativeTime(recentRuns[0]?.startedAt ?? recentRuns[0]?.createdAt)}`
              : undefined
          }
        />
        <MetricCard
          label="Pass Rate"
          value={passRate != null ? pct(passRate) : "—"}
          sub={recentRuns.length > 0 ? `Last ${recentRuns.length} runs` : undefined}
          valueColor={
            passRate != null
              ? passRate >= 0.9
                ? "var(--success)"
                : passRate >= 0.7
                  ? "var(--warning)"
                  : "var(--error)"
              : undefined
          }
        />
        <MetricCard
          label="Avg Duration"
          value={formatDuration(avgDuration)}
          sub={recentRuns.length > 0 ? "Across recent runs" : undefined}
        />
        <MetricCard
          label="Flaky Tests"
          value={String(flakyTests.length)}
          sub={
            flakyTests.length > 0
              ? `${pct(flakyTests.length / (tests.length || 1))} of tests`
              : "No flaky tests detected"
          }
          valueColor={
            flakyTests.length > 0 ? "var(--warning)" : "var(--success)"
          }
        />
      </section>

      {/* 2 — Recent Runs Timeline */}
      <section className="tesbo-section">
        <SectionHeader
          title="Recent Runs"
          action={
            runsTotal > 0 ? (
              <Link
                href={`/projects/${id}/tesbo-reports/runs`}
                className="text-xs font-medium text-[var(--brand-primary)] hover:underline"
              >
                View all runs
              </Link>
            ) : null
          }
        />
        {recentRuns.length === 0 ? (
          <EmptyStateBlock
            title="No runs yet"
            description="Run your first test to populate the dashboard. Check the Integration Guide for setup."
            action={
              <Link
                href={`/projects/${id}/integration`}
                className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--brand-border)] bg-[var(--brand-soft)] px-4 py-2 text-sm font-medium text-[var(--brand-primary)] hover:bg-[var(--brand-surface)] transition-colors"
              >
                Integration Guide
              </Link>
            }
          />
        ) : (
          <Card>
            <CardBody className="px-5 py-4">
              <div className="flex items-end gap-1.5 overflow-x-auto pb-1">
                {recentRuns.map((run, i) => (
                  <RunBar key={run.id} run={run} index={i} projectId={id} />
                ))}
              </div>
            </CardBody>
          </Card>
        )}
      </section>

      {/* 3 — Flaky Tests Alert (before failing specs so action is prominent) */}
      {flakyTests.length > 0 && (
        <section className="tesbo-section">
          <Banner
            tone="warning"
            title={`${flakyTests.length} Flaky Test${flakyTests.length !== 1 ? "s" : ""} Detected`}
            description={`Flaky tests produce inconsistent results.${top3FlakyNames ? ` Affected: ${top3FlakyNames}${flakyTests.length > 3 ? ` +${flakyTests.length - 3} more` : ""}.` : ""}`}
            action={
              <Link
                href={`/projects/${id}/tesbo-reports/tests?flaky=true`}
                className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--warning-border)] bg-[var(--warning-soft)] px-4 py-2 text-xs font-semibold text-[var(--warning-foreground)] hover:brightness-95 transition whitespace-nowrap"
              >
                View flaky tests
                <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                </svg>
              </Link>
            }
          />
        </section>
      )}

      {/* 4 — Top Failing Specs */}
      {topFailingSpecs.length > 0 && (
        <section className="tesbo-section">
          <SectionHeader
            title="Top Failing Specs"
            action={
              <Link
                href={`/projects/${id}/tesbo-reports/specs`}
                className="text-xs font-medium text-[var(--brand-primary)] hover:underline"
              >
                View all specs
              </Link>
            }
          />
          <Card>
            <CardBody className="divide-y divide-[var(--border-subtle)] p-0">
              {topFailingSpecs.map((spec) => (
                <Link
                  key={spec.spec}
                  href={`/projects/${id}/tesbo-reports/specs/detail?spec=${encodeURIComponent(spec.spec)}`}
                  className="flex items-center gap-4 px-5 py-4 hover:bg-[var(--glass-bg-subtle)] transition-colors"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-[var(--foreground)]">
                      {spec.spec}
                    </p>
                    <p className="mt-0.5 text-xs text-[var(--muted)]">
                      {spec.totalExecutions} executions · {spec.failed} failed
                    </p>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <div className="w-24">
                      <div className="h-1.5 w-full rounded-full bg-[var(--surface-tertiary)] overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all"
                          style={{
                            width: `${Math.min(100, spec.failureRate).toFixed(1)}%`,
                            backgroundColor: riskColor(spec.failureRate / 100),
                          }}
                        />
                      </div>
                    </div>
                    <StatusChip tone={riskTone(spec.failureRate / 100)}>
                      {spec.failureRate.toFixed(1)}%
                    </StatusChip>
                  </div>
                </Link>
              ))}
            </CardBody>
          </Card>
        </section>
      )}

      {/* 5 — Quick Navigation */}
      <section>
        <SectionHeader title="Quick Navigation" />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <QuickNavCard
            href={`/projects/${id}/tesbo-reports/runs`}
            title="Automation Runs"
            description="Browse and inspect execution runs"
            count={runsTotal > 0 ? runsTotal : undefined}
            icon={
              <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 4h16v16H4z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 8v8l7-4-7-4z" />
              </svg>
            }
          />
          <QuickNavCard
            href={`/projects/${id}/tesbo-reports/specs`}
            title="Spec Intelligence"
            description="Failure rates and stability by spec file"
            count={specs.length > 0 ? specs.length : undefined}
            icon={
              <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M7 4h10v16l-5-3-5 3V4z" />
              </svg>
            }
          />
          <QuickNavCard
            href={`/projects/${id}/tesbo-reports/tests`}
            title="Test Intelligence"
            description="Per-test health, flakiness, and trends"
            count={tests.length > 0 ? tests.length : undefined}
            icon={
              <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 4h8M9 4v4l-4 7a4 4 0 0 0 3.5 6h7a4 4 0 0 0 3.5-6l-4-7V4" />
              </svg>
            }
          />
          <QuickNavCard
            href={`/projects/${id}/tesbo-reports/analytics`}
            title="Analytics"
            description="Trends, stability signals, and hotspots"
            icon={
              <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 20V10M10 20V4M16 20v-8M22 20v-4" />
              </svg>
            }
          />
        </div>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Sub-components                                                     */
/* ------------------------------------------------------------------ */

function RunBar({
  run,
  index,
  projectId,
}: {
  run: ReportRun;
  index: number;
  projectId: string;
}) {
  const total = run.totalTests || 1;
  const passH = (run.passed / total) * 100;
  const failH = (run.failed / total) * 100;
  const skipH = 100 - passH - failH;
  const barHeight = 80;
  const dateStr = run.startedAt ?? run.createdAt;
  const dateLabel = dateStr
    ? new Date(dateStr).toLocaleDateString(undefined, { month: "short", day: "numeric" })
    : `#${index + 1}`;

  return (
    <Link
      href={`/projects/${projectId}/tesbo-reports/runs/${run.id}`}
      className="group flex flex-col items-center gap-1.5"
      title={`${dateLabel} · ${run.passed} passed · ${run.failed} failed · ${run.skipped} skipped`}
    >
      <div
        className="relative w-7 rounded-lg overflow-hidden border border-[var(--glass-border-soft)] group-hover:border-[var(--brand-border)] transition-colors"
        style={{ height: barHeight }}
      >
        <div
          className="absolute bottom-0 left-0 right-0"
          style={{ height: `${passH}%`, backgroundColor: "var(--success)" }}
        />
        <div
          className="absolute left-0 right-0"
          style={{
            bottom: `${passH}%`,
            height: `${failH}%`,
            backgroundColor: "var(--error)",
          }}
        />
        <div
          className="absolute left-0 right-0 top-0"
          style={{ height: `${skipH}%`, backgroundColor: "var(--glass-bg-subtle)" }}
        />
      </div>
      <span className="text-[10px] text-[var(--muted)] tabular-nums group-hover:text-[var(--foreground)] transition-colors max-w-[28px] truncate text-center">
        {dateLabel}
      </span>
    </Link>
  );
}

function QuickNavCard({
  href,
  title,
  description,
  count,
  icon,
}: {
  href: string;
  title: string;
  description: string;
  count?: number;
  icon: React.ReactNode;
}) {
  return (
    <Link href={href} className="block">
      <Card className="h-full hover:border-[var(--brand-border)] hover:shadow-[var(--shadow-elevated)] transition-all duration-200">
        <CardBody className="flex flex-col gap-3 p-5">
          <div className="flex items-center justify-between">
            <div className="rounded-xl bg-[var(--brand-soft)] p-2.5 text-[var(--brand-primary)]">
              {icon}
            </div>
            {count != null && (
              <span className="text-lg font-bold tabular-nums text-[var(--foreground)]">
                {count}
              </span>
            )}
          </div>
          <div>
            <p className="text-sm font-semibold text-[var(--foreground)]">
              {title}
            </p>
            <p className="mt-0.5 text-xs text-[var(--muted)] leading-relaxed">
              {description}
            </p>
          </div>
        </CardBody>
      </Card>
    </Link>
  );
}
