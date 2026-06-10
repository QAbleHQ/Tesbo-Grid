"use client";

import { use, useEffect, useMemo, useState, useCallback } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  getSpecIntelligenceDetail,
  type SpecIntelligenceDetailResponse,
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

export default function SpecIntelligenceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const searchParams = useSearchParams();
  const spec = searchParams.get("spec") || "";
  const [detail, setDetail] = useState<SpecIntelligenceDetailResponse | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [runsLimit, setRunsLimit] = useState<10 | 30>(10);

  const load = useCallback(() => {
    if (!spec) {
      setError("Missing spec parameter.");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    getSpecIntelligenceDetail(id, spec)
      .then(setDetail)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [id, spec]);

  useEffect(() => {
    load();
  }, [load]);

  // Oldest → latest for charts, capped to runsLimit
  const runsSorted = useMemo(
    () => [...(detail?.runs || [])].reverse().slice(0, runsLimit),
    [detail?.runs, runsLimit],
  );

  const ratesSeries = useMemo(
    () =>
      runsSorted.map((run, index) => ({
        label: run.runName
          ? run.runName.length > 8
            ? run.runName.slice(0, 8) + "…"
            : run.runName
          : `#${index + 1}`,
        fullLabel: run.runName || `Run #${index + 1}`,
        passRate: Math.max(0, 100 - run.failureRate),
        failRate: run.failureRate,
      })),
    [runsSorted],
  );

  const durationSeries = useMemo(
    () =>
      runsSorted.map((run, index) => ({
        label: run.runName
          ? run.runName.length > 8
            ? run.runName.slice(0, 8) + "…"
            : run.runName
          : `#${index + 1}`,
        fullLabel: run.runName || `Run #${index + 1}`,
        durationMs: run.avgDurationMs ?? 0,
      })),
    [runsSorted],
  );

  // Build a set of top-failed test names for tagging
  const topFailedSet = useMemo(() => {
    const top = (detail?.topFailingTests || [])
      .filter((t) => t.failed > 0)
      .slice(0, 5);
    return new Set(top.map((t) => t.testName));
  }, [detail?.topFailingTests]);

  // All tests sorted: flaky first, then by failure count desc
  const allTests = useMemo(() => {
    return [...(detail?.testCaseFlakiness || [])].sort((a, b) => {
      if (a.flaky !== b.flaky) return a.flaky ? -1 : 1;
      return b.failed - a.failed;
    });
  }, [detail?.testCaseFlakiness]);

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Link
          href={`/projects/${id}/tesbo-reports/specs`}
          className="text-sm text-[var(--brand-primary)] hover:underline"
        >
          &larr; Back to Spec Intelligence
        </Link>
        <h1 className="text-2xl font-semibold text-[var(--foreground)]">
          Spec Details
        </h1>
        <p className="truncate text-sm font-mono text-[var(--muted)]">
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
              title="No spec data available"
              description="This spec does not have execution data yet."
            />
          </CardBody>
        </Card>
      ) : (
        <>
          {/* Summary metrics */}
          <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
            <MetricCard label="Executions" value={detail.summary.totalExecutions} />
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
              label="Avg Duration"
              value={formatDuration(detail.summary.avgDurationMs)}
            />
            <MetricCard
              label="Last Seen"
              value={formatDate(detail.summary.lastSeenAt)}
            />
          </div>

          <div className="grid gap-3 grid-cols-2 sm:grid-cols-3">
            <MetricCard
              label="Total Test Cases"
              value={detail.summary.totalTestCases}
            />
            <MetricCard
              label="Flaky Test Cases"
              value={detail.summary.flakyTestCases}
              valueColor={detail.summary.flakyTestCases > 0 ? "var(--warning)" : undefined}
            />
            <MetricCard
              label="Combined Flaky Ratio"
              value={`${detail.summary.combinedSpecFlakyRatio.toFixed(1)}%`}
              valueColor={detail.summary.combinedSpecFlakyRatio > 10 ? "var(--warning)" : undefined}
            />
          </div>

          {/* Charts row */}
          <div className="grid gap-4 lg:grid-cols-2 items-stretch">
            {/* Pass Rate vs Failure Rate — area line chart */}
            <Card className="h-full">
              <CardBody className="flex flex-col h-full">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-[var(--foreground)]">
                      Pass Rate vs Failure Rate
                    </p>
                    <p className="mt-0.5 text-xs text-[var(--muted)]">
                      Pass and failure rates across runs (oldest → latest).
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <div className="glass-subtle inline-flex items-center rounded-xl p-0.5">
                      {([10, 30] as const).map((n) => (
                        <button
                          key={n}
                          type="button"
                          onClick={() => setRunsLimit(n)}
                          className={`rounded-[10px] px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_oklab,var(--brand-primary)_30%,transparent)] ${runsLimit === n ? "bg-[var(--glass-bg)] text-[var(--foreground)]" : "text-[var(--muted)] hover:text-[var(--foreground)]"}`}
                        >
                          {n}
                        </button>
                      ))}
                    </div>
                    <InfoTooltip text="Area chart showing pass rate (green) and failure rate (red) for this spec across consecutive runs. Overlapping areas indicate mixed results." />
                  </div>
                </div>
                <div className="mt-2 flex items-center gap-3 text-[11px]">
                  <span className="flex items-center gap-1">
                    <span className="inline-block h-2 w-4 rounded-sm bg-[var(--success)] opacity-70" />
                    Pass Rate
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="inline-block h-2 w-4 rounded-sm bg-[var(--error)] opacity-70" />
                    Failure Rate
                  </span>
                </div>
                <div className="flex-1 flex flex-col justify-end">
                  {ratesSeries.length < 2 ? (
                    <p className="mt-4 text-sm text-[var(--muted)]">
                      Need at least two runs to render trend.
                    </p>
                  ) : (
                    <AreaLineChart data={ratesSeries} />
                  )}
                </div>
              </CardBody>
            </Card>

            {/* Duration Across Runs */}
            <Card className="h-full">
              <CardBody className="flex flex-col h-full">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-[var(--foreground)]">
                      Time Taken Across Runs
                    </p>
                    <p className="mt-0.5 text-xs text-[var(--muted)]">
                      Average spec execution time per run (oldest → latest).
                    </p>
                  </div>
                  <InfoTooltip text="Shows how long this spec took on average per run. Rising values may indicate test bloat or environment slowdowns." />
                </div>
                <div className="flex-1 flex flex-col justify-end">
                  {durationSeries.filter((d) => d.durationMs > 0).length < 2 ? (
                    <p className="mt-4 text-sm text-[var(--muted)]">
                      Need at least two runs with duration data.
                    </p>
                  ) : (
                    <DurationChart data={durationSeries} />
                  )}
                </div>
              </CardBody>
            </Card>
          </div>

          {/* Run comparison table */}
          <Card>
            <CardBody className="p-0">
              <div className="border-b border-[var(--border-subtle)] px-4 py-3">
                <p className="text-sm font-semibold text-[var(--foreground)]">
                  Spec Comparison Across Runs
                </p>
                <p className="text-xs text-[var(--muted)]">
                  Latest runs for this spec with pass/fail behavior.
                </p>
              </div>
              {detail.runs.length === 0 ? (
                <p className="p-4 text-sm text-[var(--muted)]">
                  No run-level comparison data.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <div className="divide-y divide-[var(--border-subtle)] min-w-[640px]">
                    <div className="grid grid-cols-[1.5fr_repeat(6,minmax(0,1fr))] gap-2 bg-[var(--surface-secondary)] px-4 py-2 text-[10px] uppercase tracking-wide text-[var(--muted)]">
                      <span>Run</span>
                      <span className="text-right">Total</span>
                      <span className="text-right">Passed</span>
                      <span className="text-right">Failed</span>
                      <span className="text-right">Fail %</span>
                      <span className="text-right">Avg Time</span>
                      <span className="text-right">Started</span>
                    </div>
                    {detail.runs.map((run) => (
                      <div
                        key={run.runId}
                        className="grid grid-cols-[1.5fr_repeat(6,minmax(0,1fr))] gap-2 px-4 py-3 text-sm hover:bg-[var(--surface-secondary)] transition-colors"
                      >
                        <Link
                          href={`/projects/${id}/tesbo-reports/runs/${run.runId}`}
                          className="truncate font-medium text-[var(--foreground)] hover:underline"
                        >
                          {run.runName || run.runId}
                        </Link>
                        <Cell value={run.totalExecutions} />
                        <Cell value={run.passed} tone="success" />
                        <Cell
                          value={run.failed}
                          tone={run.failed > 0 ? "error" : undefined}
                        />
                        <Cell value={`${run.failureRate.toFixed(1)}%`} />
                        <Cell value={formatDuration(run.avgDurationMs)} />
                        <Cell value={formatDate(run.startedAt)} />
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </CardBody>
          </Card>

          {/* All Tests in this Spec */}
          <Card>
            <CardBody className="p-0">
              <div className="border-b border-[var(--border-subtle)] px-4 py-3 flex items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold text-[var(--foreground)]">
                    All Test Cases
                  </p>
                  <p className="text-xs text-[var(--muted)]">
                    All tests in this spec. Flaky tests passed and failed across
                    runs. Top Failed marks the 5 most-failing tests.
                  </p>
                </div>
                <span className="shrink-0 rounded-full bg-[var(--surface-secondary)] border border-[var(--border-subtle)] px-2.5 py-0.5 text-xs font-medium text-[var(--muted)]">
                  {allTests.length}
                </span>
              </div>
              {allTests.length === 0 ? (
                <p className="p-4 text-sm text-[var(--muted)]">
                  No test cases recorded for this spec.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <div className="divide-y divide-[var(--border-subtle)] min-w-[720px]">
                    <div className="grid grid-cols-[2fr_repeat(5,minmax(0,1fr))_auto] gap-2 bg-[var(--surface-secondary)] px-4 py-2 text-[10px] uppercase tracking-wide text-[var(--muted)]">
                      <span>Test Case</span>
                      <span className="text-right">Executions</span>
                      <span className="text-right">Passed</span>
                      <span className="text-right">Failed</span>
                      <span className="text-right">Skipped</span>
                      <span className="text-right">Flaky Ratio</span>
                      <span className="text-right">Tags</span>
                    </div>
                    {allTests.map((tc) => {
                      const isTopFailed = topFailedSet.has(tc.testName);
                      return (
                        <Link
                          key={tc.testName}
                          href={`/projects/${id}/tesbo-reports/tests/detail?spec=${encodeURIComponent(detail.spec)}&testName=${encodeURIComponent(tc.testName)}`}
                          className="grid grid-cols-[2fr_repeat(5,minmax(0,1fr))_auto] gap-2 px-4 py-3 text-sm hover:bg-[var(--surface-secondary)] transition-colors items-center"
                        >
                          <p className="truncate text-[var(--foreground)]">
                            {tc.testName}
                          </p>
                          <Cell value={tc.totalExecutions} />
                          <Cell value={tc.passed} tone="success" />
                          <Cell
                            value={tc.failed}
                            tone={tc.failed > 0 ? "error" : undefined}
                          />
                          <Cell value={tc.skipped} />
                          <Cell
                            value={`${tc.flakyRatio.toFixed(1)}%`}
                            tone={tc.flaky ? "warning" : undefined}
                          />
                          <div className="flex justify-end gap-1.5 flex-wrap">
                            {tc.flaky && (
                              <StatusChip tone="warning">Flaky</StatusChip>
                            )}
                            {isTopFailed && (
                              <StatusChip tone="error">Top Failed</StatusChip>
                            )}
                            {!tc.flaky && !isTopFailed && (
                              <StatusChip tone="success">Stable</StatusChip>
                            )}
                          </div>
                        </Link>
                      );
                    })}
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


function Cell({
  value,
  tone,
}: {
  value: string | number;
  tone?: "success" | "error" | "warning";
}) {
  const colorVar =
    tone === "success"
      ? "var(--success)"
      : tone === "error"
        ? "var(--error)"
        : tone === "warning"
          ? "var(--warning)"
          : "var(--foreground)";
  return (
    <p className="text-right tabular-nums" style={{ color: colorVar }}>
      {value}
    </p>
  );
}

/* ─── Area Line Chart (Pass Rate vs Failure Rate) ─── */

function AreaLineChart({
  data,
}: {
  data: { label: string; fullLabel: string; passRate: number; failRate: number }[];
}) {
  const width = 640;
  const height = 240;
  const padTop = 24;
  const padBottom = 40;
  const padLeft = 44;
  const padRight = 16;
  const innerWidth = width - padLeft - padRight;
  const innerHeight = height - padTop - padBottom;

  const xOf = (i: number) =>
    padLeft + (data.length <= 1 ? 0 : (i / (data.length - 1)) * innerWidth);
  const yOf = (pct: number) =>
    padTop + innerHeight - (Math.min(100, Math.max(0, pct)) / 100) * innerHeight;

  const passPoints = data.map((d, i) => ({ x: xOf(i), y: yOf(d.passRate) }));
  const failPoints = data.map((d, i) => ({ x: xOf(i), y: yOf(d.failRate) }));

  const toLinePath = (pts: { x: number; y: number }[]) =>
    pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");

  const toAreaPath = (
    pts: { x: number; y: number }[],
    baseline: number,
  ) => {
    const line = toLinePath(pts);
    const lastX = pts[pts.length - 1].x.toFixed(1);
    const firstX = pts[0].x.toFixed(1);
    return `${line} L ${lastX} ${baseline.toFixed(1)} L ${firstX} ${baseline.toFixed(1)} Z`;
  };

  const baselineY = padTop + innerHeight;
  const yTicks = [0, 25, 50, 75, 100];
  const xSkip =
    data.length > 12 ? Math.ceil(data.length / 8) : 1;

  return (
    <div className="mt-4">
      <svg viewBox={`0 0 ${width} ${height}`} className="h-56 w-full">
        {/* Grid lines */}
        {yTicks.map((tick) => {
          const y = yOf(tick);
          return (
            <g key={tick}>
              <line
                x1={padLeft}
                y1={y}
                x2={width - padRight}
                y2={y}
                stroke="var(--border-subtle)"
                strokeDasharray="4 4"
              />
              <text
                x={padLeft - 6}
                y={y + 3}
                textAnchor="end"
                fontSize={9}
                fill="var(--muted)"
              >
                {tick}%
              </text>
            </g>
          );
        })}

        {/* Axes */}
        <line
          x1={padLeft}
          y1={baselineY}
          x2={width - padRight}
          y2={baselineY}
          stroke="var(--border)"
        />
        <line
          x1={padLeft}
          y1={padTop}
          x2={padLeft}
          y2={baselineY}
          stroke="var(--border)"
        />

        {/* Pass area */}
        <path
          d={toAreaPath(passPoints, baselineY)}
          fill="var(--success)"
          fillOpacity={0.15}
        />
        {/* Fail area */}
        <path
          d={toAreaPath(failPoints, baselineY)}
          fill="var(--error)"
          fillOpacity={0.15}
        />

        {/* Pass line */}
        <path
          d={toLinePath(passPoints)}
          fill="none"
          stroke="var(--success)"
          strokeWidth={2}
          strokeLinejoin="round"
        />
        {/* Fail line */}
        <path
          d={toLinePath(failPoints)}
          fill="none"
          stroke="var(--error)"
          strokeWidth={2}
          strokeLinejoin="round"
        />

        {/* Data points */}
        {passPoints.map((p, i) => (
          <circle key={`p${i}`} cx={p.x} cy={p.y} r={3} fill="var(--success)">
            <title>
              {data[i].fullLabel}: Pass {data[i].passRate.toFixed(1)}%
            </title>
          </circle>
        ))}
        {failPoints.map((p, i) => (
          <circle key={`f${i}`} cx={p.x} cy={p.y} r={3} fill="var(--error)">
            <title>
              {data[i].fullLabel}: Fail {data[i].failRate.toFixed(1)}%
            </title>
          </circle>
        ))}

        {/* X-axis labels */}
        {data.map((d, i) => {
          if (i % xSkip !== 0) return null;
          return (
            <text
              key={i}
              x={xOf(i)}
              y={baselineY + 14}
              textAnchor="middle"
              fontSize={9}
              fill="var(--muted)"
            >
              {d.label}
            </text>
          );
        })}
      </svg>
    </div>
  );
}

/* ─── Duration Chart ─── */

function DurationChart({
  data,
}: {
  data: { label: string; fullLabel: string; durationMs: number }[];
}) {
  const width = 640;
  const height = 240;
  const padTop = 24;
  const padBottom = 40;
  const padLeft = 52;
  const padRight = 16;
  const innerWidth = width - padLeft - padRight;
  const innerHeight = height - padTop - padBottom;

  const maxVal = Math.max(1, ...data.map((d) => d.durationMs));

  const xOf = (i: number) =>
    padLeft + (data.length <= 1 ? 0 : (i / (data.length - 1)) * innerWidth);
  const yOf = (ms: number) =>
    padTop + innerHeight - (ms / maxVal) * innerHeight;

  const points = data.map((d, i) => ({ x: xOf(i), y: yOf(d.durationMs) }));
  const linePath = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join(" ");
  const areaPath = `${linePath} L ${points[points.length - 1].x.toFixed(1)} ${(padTop + innerHeight).toFixed(1)} L ${points[0].x.toFixed(1)} ${(padTop + innerHeight).toFixed(1)} Z`;

  const yTicks = [0, Math.round(maxVal / 2), maxVal];
  const xSkip = data.length > 12 ? Math.ceil(data.length / 8) : 1;

  return (
    <div className="mt-4">
      <svg viewBox={`0 0 ${width} ${height}`} className="h-56 w-full">
        {yTicks.map((tick) => {
          const y = yOf(tick);
          return (
            <g key={tick}>
              <line
                x1={padLeft}
                y1={y}
                x2={width - padRight}
                y2={y}
                stroke="var(--border-subtle)"
                strokeDasharray="4 4"
              />
              <text
                x={padLeft - 6}
                y={y + 3}
                textAnchor="end"
                fontSize={9}
                fill="var(--muted)"
              >
                {formatDurationShort(tick)}
              </text>
            </g>
          );
        })}

        {/* Axes */}
        <line
          x1={padLeft}
          y1={padTop + innerHeight}
          x2={width - padRight}
          y2={padTop + innerHeight}
          stroke="var(--border)"
        />
        <line
          x1={padLeft}
          y1={padTop}
          x2={padLeft}
          y2={padTop + innerHeight}
          stroke="var(--border)"
        />

        {/* Area fill */}
        <path
          d={areaPath}
          fill="var(--brand-primary)"
          fillOpacity={0.12}
        />

        {/* Line */}
        <path
          d={linePath}
          fill="none"
          stroke="var(--brand-primary)"
          strokeWidth={2.5}
          strokeLinejoin="round"
        />

        {/* Points */}
        {points.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r={3.5} fill="var(--brand-primary)">
            <title>
              {data[i].fullLabel}: {formatDuration(data[i].durationMs)}
            </title>
          </circle>
        ))}

        {/* X labels */}
        {data.map((d, i) => {
          if (i % xSkip !== 0) return null;
          return (
            <text
              key={i}
              x={xOf(i)}
              y={padTop + innerHeight + 14}
              textAnchor="middle"
              fontSize={9}
              fill="var(--muted)"
            >
              {d.label}
            </text>
          );
        })}
      </svg>
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

function formatDuration(ms: number | null) {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${Math.round(ms / 1000)}s`;
}

function formatDurationShort(ms: number) {
  if (ms === 0) return "0s";
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${Math.round(s)}s`;
  return `${Math.round(s / 60)}m`;
}

function formatDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString();
}
