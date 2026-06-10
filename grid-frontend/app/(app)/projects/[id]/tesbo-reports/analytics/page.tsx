"use client";

import { use, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  listReportRuns,
  getSpecIntelligence,
  getTestIntelligence,
  getQualityOverview,
  type ReportRun,
  type SpecIntelligenceItem,
  type TestIntelligenceItem,
  type QualityOverviewResponse,
} from "@/lib/api";
import {
  Banner,
  Button,
  Card,
  CardBody,
  EmptyStateBlock,
  ErrorBlock,
  MetricCard,
  PageSkeleton,
  StatusChip,
} from "@/components/ui";

function formatDuration(ms: number | null) {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

// Per-endpoint state lets us:
//   • render whatever data did load instead of hiding everything,
//   • show a precise banner naming the section that's failing,
//   • avoid the silent-zero footgun where a 500 looked identical to "no data".
type SectionLoad<T> =
  | { status: "loading" }
  | { status: "ok"; data: T }
  | { status: "error"; message: string };

type LoadState = {
  runs: SectionLoad<ReportRun[]>;
  specs: SectionLoad<SpecIntelligenceItem[]>;
  tests: SectionLoad<TestIntelligenceItem[]>;
  quality: SectionLoad<QualityOverviewResponse>;
};

const INITIAL_STATE: LoadState = {
  runs: { status: "loading" },
  specs: { status: "loading" },
  tests: { status: "loading" },
  quality: { status: "loading" },
};

function settledToSection<T>(
  result: PromiseSettledResult<T>
): SectionLoad<T> {
  if (result.status === "fulfilled") return { status: "ok", data: result.value };
  const reason = result.reason;
  const message =
    reason instanceof Error
      ? reason.message
      : typeof reason === "string"
        ? reason
        : "Failed to load";
  return { status: "error", message };
}

function unwrap<T, F>(section: SectionLoad<T>, fallback: F): T | F {
  return section.status === "ok" ? section.data : fallback;
}

export default function AnalyticsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [state, setState] = useState<LoadState>(INITIAL_STATE);

  const loadData = useCallback(async () => {
    setState(INITIAL_STATE);
    const [runsRes, specsRes, testsRes, qualityRes] = await Promise.allSettled([
      listReportRuns(id, 1, 100),
      getSpecIntelligence(id, 1, 200),
      getTestIntelligence(id, 1, 200),
      getQualityOverview(id),
    ]);
    setState({
      runs:
        runsRes.status === "fulfilled"
          ? { status: "ok", data: runsRes.value.runs }
          : settledToSection(runsRes),
      specs:
        specsRes.status === "fulfilled"
          ? { status: "ok", data: specsRes.value.specs }
          : settledToSection(specsRes),
      tests:
        testsRes.status === "fulfilled"
          ? { status: "ok", data: testsRes.value.tests }
          : settledToSection(testsRes),
      quality: settledToSection(qualityRes),
    });
  }, [id]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const isLoading = Object.values(state).every((s) => s.status === "loading");
  const allFailed = Object.values(state).every((s) => s.status === "error");

  const runs = unwrap(state.runs, [] as ReportRun[]);
  const specs = unwrap(state.specs, [] as SpecIntelligenceItem[]);
  const tests = unwrap(state.tests, [] as TestIntelligenceItem[]);
  const quality = state.quality.status === "ok" ? state.quality.data : null;

  const failedSections = useMemo(() => {
    const out: { label: string; key: keyof LoadState; message: string }[] = [];
    if (state.runs.status === "error") out.push({ label: "Runs", key: "runs", message: state.runs.message });
    if (state.specs.status === "error") out.push({ label: "Specs", key: "specs", message: state.specs.message });
    if (state.tests.status === "error") out.push({ label: "Tests", key: "tests", message: state.tests.message });
    if (state.quality.status === "error") out.push({ label: "Quality overview", key: "quality", message: state.quality.message });
    return out;
  }, [state]);

  const sortedRuns = useMemo(
    () =>
      [...runs].sort((a, b) => {
        const ta = new Date(a.startedAt || a.createdAt).getTime();
        const tb = new Date(b.startedAt || b.createdAt).getTime();
        return ta - tb;
      }),
    [runs]
  );

  const passRateSeries = useMemo(
    () =>
      sortedRuns.map((r, i) => ({
        index: i + 1,
        rate: r.totalTests > 0 ? (r.passed / r.totalTests) * 100 : 0,
        name: r.runName || `Run ${i + 1}`,
      })),
    [sortedRuns]
  );

  const durationSeries = useMemo(
    () =>
      sortedRuns
        .filter((r) => r.durationMs != null)
        .map((r, i) => ({
          index: i + 1,
          durationMs: r.durationMs!,
          name: r.runName || `Run ${i + 1}`,
        })),
    [sortedRuns]
  );

  const aiBreakdown = useMemo(() => {
    let actualBugs = 0,
      featureChanges = 0,
      scriptIssues = 0,
      environmentIssues = 0,
      unclassified = 0;
    for (const t of tests) {
      actualBugs += t.actualBugFailures;
      featureChanges += t.featureChangeFailures;
      scriptIssues += t.scriptIssueFailures;
      environmentIssues += t.environmentIssueFailures;
      const classified =
        t.actualBugFailures +
        t.featureChangeFailures +
        t.scriptIssueFailures +
        t.environmentIssueFailures;
      if (t.failed > 0 && classified === 0) {
        unclassified += t.failed;
      }
    }
    return { actualBugs, featureChanges, scriptIssues, environmentIssues, unclassified };
  }, [tests]);

  const topFailing = useMemo(
    () => [...tests].sort((a, b) => b.failureRate - a.failureRate).slice(0, 8),
    [tests]
  );

  const flakyCount = useMemo(() => tests.filter((t) => t.flaky).length, [tests]);

  const totalTestsAcrossRuns = runs.reduce((a, r) => a + r.totalTests, 0);
  const totalPassedAcrossRuns = runs.reduce((a, r) => a + r.passed, 0);
  const overallPassRate =
    totalTestsAcrossRuns > 0
      ? (totalPassedAcrossRuns / totalTestsAcrossRuns) * 100
      : null;

  const hasAnyData = runs.length > 0 || specs.length > 0 || tests.length > 0;

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--foreground)]">Analytics</h1>
          <p className="text-sm text-[var(--muted)]">
            Execution trends, stability signals, and failure hotspots
          </p>
        </div>
        <PageSkeleton rows={4} />
      </div>
    );
  }

  // Every endpoint failed → most likely a systemic issue (DB down, missing
  // migration, auth). Show a single retryable error rather than confusing zeros.
  if (allFailed) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--foreground)]">Analytics</h1>
          <p className="text-sm text-[var(--muted)]">
            Execution trends, stability signals, and failure hotspots
          </p>
        </div>
        <ErrorBlock
          title="Couldn't load analytics"
          message={state.runs.status === "error" ? state.runs.message : "All analytics endpoints failed."}
          retry={loadData}
        />
      </div>
    );
  }

  if (!hasAnyData && failedSections.length === 0) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--foreground)]">Analytics</h1>
          <p className="text-sm text-[var(--muted)]">
            Execution trends, stability signals, and failure hotspots
          </p>
        </div>
        <EmptyStateBlock
          title="No analytics data yet"
          description="Run tests for this project to generate analytics. Check the Integration Guide for setup instructions."
          action={
            <Link
              href={`/projects/${id}/integration`}
              className="inline-flex items-center gap-2 rounded-xl border border-[var(--brand-border)] bg-[var(--brand-primary)] px-5 py-2.5 text-sm font-medium text-[var(--surface)] hover:bg-[var(--brand-hover)] transition-colors"
            >
              View Integration Guide
            </Link>
          }
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--foreground)]">Analytics</h1>
          <p className="text-sm text-[var(--muted)]">
            Execution trends, stability signals, and failure hotspots
          </p>
        </div>
        <Button size="sm" variant="secondary" onClick={loadData}>
          Refresh
        </Button>
      </div>

      {failedSections.length > 0 && (
        <Banner
          tone="warning"
          title={
            failedSections.length === 1
              ? `${failedSections[0].label} couldn't be loaded`
              : `${failedSections.length} sections couldn't be loaded`
          }
          description={
            failedSections.length === 1
              ? `${failedSections[0].message}. Other panels below may be incomplete.`
              : `Sections: ${failedSections.map((s) => s.label).join(", ")}. The page is showing partial data — the missing panels stay blank until they load.`
          }
          action={
            <Button size="sm" variant="secondary" onClick={loadData}>
              Retry
            </Button>
          }
        />
      )}

      {/* Summary metrics */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label="Total Runs"
          value={state.runs.status === "error" ? "—" : runs.length}
          sub={state.runs.status === "error" ? "Couldn't load runs" : undefined}
        />
        <MetricCard
          label="Overall Pass Rate"
          value={overallPassRate != null ? `${overallPassRate.toFixed(1)}%` : "—"}
          valueColor={
            overallPassRate == null
              ? undefined
              : overallPassRate >= 90
                ? "var(--success)"
                : overallPassRate >= 70
                  ? "var(--warning)"
                  : "var(--error)"
          }
          sub={
            state.runs.status === "error"
              ? "Couldn't load runs"
              : runs.length === 0
                ? "Awaiting first run"
                : undefined
          }
        />
        <MetricCard
          label="Total Specs"
          value={state.specs.status === "error" ? "—" : specs.length}
          sub={state.specs.status === "error" ? "Couldn't load specs" : undefined}
        />
        <MetricCard
          label="Flaky Tests"
          value={state.tests.status === "error" ? "—" : flakyCount}
          valueColor={
            state.tests.status === "error"
              ? undefined
              : flakyCount > 0
                ? "var(--warning)"
                : "var(--success)"
          }
          sub={state.tests.status === "error" ? "Couldn't load tests" : undefined}
        />
      </div>

      {/* Quality / risk row — always rendered (with placeholders) so the page
          layout is stable whether or not /quality-overview succeeded. */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label="Avg Release Risk"
          value={
            quality?.runs.avgRiskScore != null ? `${quality.runs.avgRiskScore}/100` : "—"
          }
          valueColor={
            quality?.runs.avgRiskScore != null
              ? quality.runs.avgRiskScore >= 70
                ? "var(--error)"
                : quality.runs.avgRiskScore >= 45
                  ? "var(--warning)"
                  : "var(--success)"
              : undefined
          }
          sub={
            state.quality.status === "error"
              ? "Couldn't load risk"
              : quality?.runs.avgRiskScore == null
                ? "No risk scored yet"
                : undefined
          }
        />
        <MetricCard
          label="Failure Clusters"
          value={quality?.clusters.totalClusters ?? "—"}
          sub={
            state.quality.status === "error"
              ? "Couldn't load clusters"
              : (quality?.clusters.totalClusters ?? 0) === 0
                ? "No clusters detected"
                : undefined
          }
        />
        <MetricCard
          label="High Flaky Tests"
          value={quality?.flakiness.highFlakyTests ?? "—"}
          valueColor={
            (quality?.flakiness.highFlakyTests ?? 0) > 0
              ? "var(--warning)"
              : quality?.flakiness.highFlakyTests === 0
                ? "var(--success)"
                : undefined
          }
          sub={
            state.quality.status === "error"
              ? "Couldn't load flakiness"
              : undefined
          }
        />
        <MetricCard
          label="Probable Regressions"
          value={quality?.regressions.probableRegressions ?? "—"}
          valueColor={
            (quality?.regressions.probableRegressions ?? 0) > 0
              ? "var(--error)"
              : quality?.regressions.probableRegressions === 0
                ? "var(--success)"
                : undefined
          }
          sub={
            state.quality.status === "error"
              ? "Couldn't load regressions"
              : undefined
          }
        />
      </div>

      {/* Charts row */}
      <div className="grid gap-4 lg:grid-cols-2 items-stretch">
        <Card className="h-full">
          <CardBody className="flex flex-col h-full">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-sm font-semibold text-[var(--foreground)]">Pass Rate Over Time</p>
                <p className="mt-0.5 text-xs text-[var(--muted)]">Percentage of tests passing per run</p>
              </div>
              <InfoTooltip text="Tracks the percentage of passing tests across each run in chronological order. An upward trend signals improving test stability, while dips highlight regressions worth investigating." />
            </div>
            <ChartFrame>
              {state.runs.status === "error" ? (
                <ChartPlaceholder
                  tone="error"
                  title="Couldn't load runs"
                  message={state.runs.message}
                />
              ) : passRateSeries.length === 0 ? (
                <ChartPlaceholder title="No runs yet" message="Trigger a test run to see the pass-rate trend appear here." />
              ) : passRateSeries.length < 2 ? (
                <ChartPlaceholder title="Need 2+ runs" message="At least two runs are required to draw a trend line. One more run and this chart will populate." />
              ) : (
                <TrendChart data={passRateSeries} color="var(--success)" suffix="%" maxValue={100} />
              )}
            </ChartFrame>
          </CardBody>
        </Card>

        <Card className="h-full">
          <CardBody className="flex flex-col h-full">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-sm font-semibold text-[var(--foreground)]">Run Duration Trend</p>
                <p className="mt-0.5 text-xs text-[var(--muted)]">Total execution time per run</p>
              </div>
              <InfoTooltip text="Shows total wall-clock time for each run. Sudden spikes can indicate slow or hanging tests, infrastructure issues, or newly added expensive test suites." />
            </div>
            <ChartFrame>
              {state.runs.status === "error" ? (
                <ChartPlaceholder
                  tone="error"
                  title="Couldn't load runs"
                  message={state.runs.message}
                />
              ) : durationSeries.length === 0 ? (
                <ChartPlaceholder title="No runs yet" message="Duration is recorded after the first completed run." />
              ) : durationSeries.length < 2 ? (
                <ChartPlaceholder title="Need 2+ runs" message="At least two runs are required to compare durations." />
              ) : (
                <DurationBars data={durationSeries} />
              )}
            </ChartFrame>
          </CardBody>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2 items-stretch">
        <Card className="h-full">
          <CardBody className="flex flex-col h-full">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-sm font-semibold text-[var(--foreground)]">Failure Classification</p>
                <p className="mt-0.5 text-xs text-[var(--muted)]">AI-powered root cause breakdown of failures</p>
              </div>
              <InfoTooltip text="AI classifies each failure into one of four root-cause categories. 'Actual Bugs' are product defects. 'Feature Changes' indicate intentional app changes that broke tests. 'Script Issues' are problems in the test code itself (bad selectors, wrong assertions). 'Environment Issues' are infra or network problems. 'Unclassified' have not been analysed yet." />
            </div>
            {state.tests.status === "error" ? (
              <ChartPlaceholder
                tone="error"
                title="Couldn't load tests"
                message={state.tests.message}
              />
            ) : aiBreakdown.actualBugs === 0 &&
              aiBreakdown.featureChanges === 0 &&
              aiBreakdown.scriptIssues === 0 &&
              aiBreakdown.environmentIssues === 0 &&
              aiBreakdown.unclassified === 0 ? (
              <p className="mt-6 text-sm text-[var(--muted)]">No failure data yet. Run tests to see classification.</p>
            ) : (
              (() => {
                const total =
                  aiBreakdown.actualBugs +
                  aiBreakdown.featureChanges +
                  aiBreakdown.scriptIssues +
                  aiBreakdown.environmentIssues +
                  aiBreakdown.unclassified;
                return (
                  <div className="mt-4 space-y-3">
                    <ClassificationRow label="Actual Bugs" count={aiBreakdown.actualBugs} total={total} color="var(--error)" />
                    <ClassificationRow label="Feature Changes" count={aiBreakdown.featureChanges} total={total} color="var(--warning)" />
                    <ClassificationRow label="Script Issues" count={aiBreakdown.scriptIssues} total={total} color="var(--warning)" />
                    <ClassificationRow label="Environment Issues" count={aiBreakdown.environmentIssues} total={total} color="var(--brand-primary)" />
                    <ClassificationRow label="Unclassified" count={aiBreakdown.unclassified} total={total} color="var(--muted)" />
                  </div>
                );
              })()
            )}
          </CardBody>
        </Card>

        <Card className="h-full">
          <CardBody className="flex flex-col h-full">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-sm font-semibold text-[var(--foreground)]">Spec Health Distribution</p>
                <p className="mt-0.5 text-xs text-[var(--muted)]">Specs grouped by failure rate severity</p>
              </div>
              <InfoTooltip text="Buckets every spec file by its historical failure rate. Healthy specs pass >80% of the time. At Risk specs fail 20–50% of the time and need attention. Critical specs fail more than 50% of the time and should be prioritised immediately." />
            </div>
            {state.specs.status === "error" ? (
              <ChartPlaceholder
                tone="error"
                title="Couldn't load specs"
                message={state.specs.message}
              />
            ) : specs.length === 0 ? (
              <p className="mt-6 text-sm text-[var(--muted)]">No specs yet — once tests run, specs will be summarised here.</p>
            ) : (
              <div className="mt-4 space-y-3">
                {(() => {
                  const healthy = specs.filter((s) => s.failureRate < 20).length;
                  const atRisk = specs.filter((s) => s.failureRate >= 20 && s.failureRate < 50).length;
                  const critical = specs.filter((s) => s.failureRate >= 50).length;
                  const total = specs.length || 1;
                  return (
                    <>
                      <HealthRow label="Healthy" count={healthy} total={total} color="var(--success)" description="< 20% failure rate" />
                      <HealthRow label="At Risk" count={atRisk} total={total} color="var(--warning)" description="20–50% failure rate" />
                      <HealthRow label="Critical" count={critical} total={total} color="var(--error)" description="> 50% failure rate" />
                    </>
                  );
                })()}
              </div>
            )}
          </CardBody>
        </Card>
      </div>

      {topFailing.length > 0 && (
        <Card>
          <CardBody className="p-0">
            <div className="border-b border-[var(--border-subtle)] px-5 py-3">
              <p className="text-sm font-semibold text-[var(--foreground)]">Top Failing Tests</p>
              <p className="text-xs text-[var(--muted)]">Tests with the highest failure rates across all runs</p>
            </div>
            <div className="divide-y divide-[var(--border-subtle)]">
              {topFailing.map((t, i) => (
                <Link
                  key={`${t.spec}:${t.testName}`}
                  href={`/projects/${id}/tesbo-reports/tests/detail?spec=${encodeURIComponent(t.spec)}&testName=${encodeURIComponent(t.testName)}`}
                  className="flex items-center gap-4 px-5 py-3 hover:bg-[var(--surface-secondary)] transition-colors"
                >
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--surface-tertiary)] text-[11px] font-semibold text-[var(--muted)]">
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-[var(--foreground)]">{t.testName}</p>
                    <p className="truncate text-xs font-mono text-[var(--muted)]">{t.spec}</p>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <div className="w-24 text-right">
                      <div className="h-1.5 overflow-hidden rounded-full bg-[var(--surface-tertiary)]">
                        <div
                          className="h-full rounded-full transition-all"
                          style={{
                            width: `${Math.min(100, t.failureRate)}%`,
                            backgroundColor:
                              t.failureRate >= 50
                                ? "var(--error)"
                                : t.failureRate >= 20
                                  ? "var(--warning)"
                                  : "var(--success)",
                          }}
                        />
                      </div>
                    </div>
                    <span className="w-14 text-right text-xs font-semibold tabular-nums text-[var(--foreground)]">
                      {t.failureRate.toFixed(1)}%
                    </span>
                    {t.flaky && <StatusChip tone="warning">Flaky</StatusChip>}
                  </div>
                </Link>
              ))}
            </div>
          </CardBody>
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ChartFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-4 flex flex-1 min-h-[12rem] flex-col justify-end">
      {children}
    </div>
  );
}

function ChartPlaceholder({
  title,
  message,
  tone = "muted",
}: {
  title: string;
  message: string;
  tone?: "muted" | "error";
}) {
  const isError = tone === "error";
  return (
    <div className="flex h-full min-h-[12rem] flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-[var(--border-subtle)] px-4 py-6 text-center">
      <p
        className={`text-sm font-medium ${
          isError ? "text-[var(--error-foreground)]" : "text-[var(--foreground)]"
        }`}
      >
        {title}
      </p>
      <p className="text-xs text-[var(--muted)] max-w-sm">{message}</p>
    </div>
  );
}

function TrendChart({
  data,
  color,
  suffix = "",
  maxValue,
}: {
  data: { index: number; rate: number; name: string }[];
  color: string;
  suffix?: string;
  maxValue?: number;
}) {
  const width = 640;
  const height = 200;
  const px = 32;
  const py = 24;
  const iw = width - px * 2;
  const ih = height - py * 2;
  const max = maxValue || Math.max(1, ...data.map((d) => d.rate));

  const points = data.map((d, i) => ({
    x: px + (data.length <= 1 ? iw / 2 : (i / (data.length - 1)) * iw),
    y: py + ih - (d.rate / max) * ih,
    ...d,
  }));

  const path = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join(" ");
  const areaPath = `${path} L ${points[points.length - 1].x.toFixed(1)} ${height - py} L ${points[0].x.toFixed(1)} ${height - py} Z`;

  return (
    <div className="w-full">
      <svg viewBox={`0 0 ${width} ${height}`} className="h-48 w-full">
        {[0, 25, 50, 75, 100].map((tick) => {
          const y = py + ih - (tick / max) * ih;
          return (
            <g key={tick}>
              <line x1={px} y1={y} x2={width - px} y2={y} stroke="var(--border-subtle)" strokeDasharray="3,3" />
              <text x={px - 6} y={y + 4} textAnchor="end" fill="var(--muted-soft)" fontSize="10">
                {tick}
                {suffix}
              </text>
            </g>
          );
        })}
        <line x1={px} y1={height - py} x2={width - px} y2={height - py} stroke="var(--border)" />
        <path d={areaPath} fill={color} opacity={0.08} />
        <path d={path} fill="none" stroke={color} strokeWidth={2} />
        {points.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r={3} fill={color}>
            <title>{`${p.name}: ${p.rate.toFixed(1)}${suffix}`}</title>
          </circle>
        ))}
      </svg>
    </div>
  );
}

function DurationBars({
  data,
}: {
  data: { index: number; durationMs: number; name: string }[];
}) {
  const max = Math.max(1, ...data.map((d) => d.durationMs));
  const displayData = data.slice(-20);

  return (
    <div className="flex h-48 items-end gap-1 overflow-x-auto">
      {displayData.map((d) => {
        const heightPct = (d.durationMs / max) * 100;
        return (
          <div key={d.index} className="flex flex-col items-center gap-1 min-w-[20px] flex-1">
            <span className="text-[9px] tabular-nums text-[var(--muted)]">{formatDuration(d.durationMs)}</span>
            <div className="w-full flex-1 flex flex-col justify-end">
              <div
                className="w-full rounded-t bg-[var(--brand-primary)] opacity-70 hover:opacity-100 transition-opacity"
                style={{ height: `${Math.max(4, heightPct)}%` }}
                title={`${d.name}: ${formatDuration(d.durationMs)}`}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ClassificationRow({
  label,
  count,
  total,
  color,
}: {
  label: string;
  count: number;
  total: number;
  color: string;
}) {
  const pct = total > 0 ? (count / total) * 100 : 0;
  return (
    <div className="flex items-center gap-3">
      <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: color }} />
      <span className="flex-1 text-sm text-[var(--foreground)]">{label}</span>
      <span className="text-sm font-semibold tabular-nums text-[var(--foreground)]">{count}</span>
      <div className="w-20 h-1.5 rounded-full bg-[var(--surface-tertiary)] overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: color }} />
      </div>
      <span className="w-10 text-right text-xs tabular-nums text-[var(--muted)]">{pct.toFixed(0)}%</span>
    </div>
  );
}

function HealthRow({
  label,
  count,
  total,
  color,
  description,
}: {
  label: string;
  count: number;
  total: number;
  color: string;
  description: string;
}) {
  const pct = (count / total) * 100;
  return (
    <div>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: color }} />
          <span className="text-sm font-medium text-[var(--foreground)]">{label}</span>
          <span className="text-xs text-[var(--muted)]">{description}</span>
        </div>
        <span className="text-sm font-semibold tabular-nums text-[var(--foreground)]">{count}</span>
      </div>
      <div className="mt-1.5 h-2 rounded-full bg-[var(--surface-tertiary)] overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: color }} />
      </div>
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
