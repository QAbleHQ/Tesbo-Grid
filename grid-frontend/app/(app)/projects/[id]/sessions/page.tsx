"use client";

import Link from "next/link";
import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Card,
  CardBody,
  EmptyStateBlock,
  ErrorBlock,
  Field,
  FieldLabel,
  Input,
  MetricCard,
  StatusChip,
  TableSkeleton,
} from "@/components/ui";
import {
  getProject,
  listSeleniumSessions,
  type ProjectDetail,
  type SeleniumSession,
  type SeleniumSessionStatus,
  type SeleniumSessionsCounts,
} from "@/lib/api";

// The dashboard splits the lifecycle into two tabs:
//  * Live      → queued + active. Auto-refreshes; no date filter (live data is
//                short-lived by definition).
//  * Completed → ended + abandoned + failed. Defaults to the last 7 days, with
//                a date-range picker and day grouping so a busy project's
//                history is browsable without paginating thousands of rows.
type Tab = "live" | "completed";

const LIVE_STATUSES: SeleniumSessionStatus[] = ["queued", "active"];
const COMPLETED_STATUSES: SeleniumSessionStatus[] = [
  "ended",
  "abandoned",
  "failed",
];

const STATUS_TONE: Record<
  SeleniumSessionStatus,
  "brand" | "success" | "warning" | "error" | "neutral"
> = {
  queued: "brand",
  active: "success",
  ended: "neutral",
  abandoned: "warning",
  failed: "error",
};

function formatDuration(ms: number | null) {
  if (ms == null || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${ms} ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return `${hours}h ${remMinutes}m`;
}

function formatTime(value: string | null) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
}

function formatRelative(value: string | null) {
  if (!value) return "—";
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return value;
  const diff = Date.now() - then;
  if (diff < 0) return "just now";
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// Bucket key for day grouping. We use the user's local date so groups line
// up with the calendar they actually see — using UTC would put a 9PM Pacific
// session into "tomorrow", which is confusing.
function localDayKey(value: string | null): string {
  if (!value) return "Unknown";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "Unknown";
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

// Local YYYY-MM-DD for <input type="date"> values; the server accepts both
// YYYY-MM-DD (treated as UTC midnight) and full ISO strings.
function todayLocalIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function daysAgoLocalIso(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const ZERO_COUNTS: SeleniumSessionsCounts = {
  queued: 0,
  active: 0,
  ended: 0,
  abandoned: 0,
  failed: 0,
};

export default function LiveSessionsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [tab, setTab] = useState<Tab>("live");

  const [sessions, setSessions] = useState<SeleniumSession[]>([]);
  const [counts, setCounts] = useState<SeleniumSessionsCounts>(ZERO_COUNTS);

  // Live-tab status sub-filter — lets the user drill into "just queued" or
  // "just active" within the live tab without leaving it.
  const [liveStatus, setLiveStatus] = useState<"all" | "queued" | "active">(
    "all"
  );
  // Completed-tab status sub-filter.
  const [completedStatus, setCompletedStatus] = useState<
    "all" | "ended" | "abandoned" | "failed"
  >("all");

  // Date range only applies to Completed. Defaults to the last 7 days so the
  // page loads quickly even on noisy projects; the user can widen it.
  const [fromDate, setFromDate] = useState<string>(daysAgoLocalIso(7));
  const [toDate, setToDate] = useState<string>(todayLocalIso());

  const [buildFilter, setBuildFilter] = useState("");
  const [buildInput, setBuildInput] = useState("");

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // `refreshError` is the *background-poll* error. We track it separately
  // from `error` (which represents a hard initial-load failure) so a
  // transient blip during the 15-second auto-refresh shows as a small
  // inline "couldn't refresh" indicator instead of nuking the table and
  // screaming "Something went wrong" at the user every poll cycle.
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  // True only for the very first request a given filter combination makes.
  // Subsequent loads are background refreshes and must not flicker the UI.
  const hasLoadedOnceRef = useRef(false);
  // Consecutive failure counter — used to back off the poll cadence so a
  // sustained backend outage doesn't hammer the API every 15s.
  const failureCountRef = useRef(0);

  const copySeleniumId = (seleniumId: string) => {
    navigator.clipboard.writeText(seleniumId).then(() => {
      setCopiedId(seleniumId);
      setTimeout(() => setCopiedId(null), 1500);
    });
  };

  const loadSessions = useCallback(
    async ({ silent = false }: { silent?: boolean } = {}) => {
      // Silent (background) refreshes never touch `loading` or clear the
      // existing `error`/data — that prevents the table from flashing
      // empty between polls and prevents one flake from wiping the
      // screen.
      if (!silent) {
        setLoading(true);
        setError(null);
      }
      try {
        // Pick the status filter for the active tab; the API expands "live"
        // and "completed" to the right status set when no sub-filter is set.
        let statusParam:
          | SeleniumSessionStatus
          | "live"
          | "completed"
          | undefined;
        if (tab === "live") {
          statusParam = liveStatus === "all" ? "live" : liveStatus;
        } else {
          statusParam =
            completedStatus === "all" ? "completed" : completedStatus;
        }

        const result = await listSeleniumSessions(id, {
          status: statusParam,
          build: buildFilter || undefined,
          // Only apply date filter on Completed — Live is always "now-ish".
          from: tab === "completed" ? fromDate || undefined : undefined,
          // `to` is end-of-day; we add 23:59:59 client-side so the user's
          // "to: today" actually includes today's most recent sessions.
          to:
            tab === "completed" && toDate ? `${toDate}T23:59:59Z` : undefined,
          limit: tab === "completed" ? 200 : 100,
        });
        setSessions(result.sessions);
        if (result.counts) setCounts(result.counts);
        setRefreshedAt(Date.now());
        setRefreshError(null);
        hasLoadedOnceRef.current = true;
        failureCountRef.current = 0;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to load sessions";
        failureCountRef.current += 1;
        if (silent && hasLoadedOnceRef.current) {
          // Background refresh failed but we already have data on screen —
          // surface it quietly via the "Updated …" header without erasing
          // the previously-loaded sessions.
          setRefreshError(message);
        } else {
          setError(message);
        }
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [id, tab, liveStatus, completedStatus, buildFilter, fromDate, toDate]
  );

  useEffect(() => {
    let cancelled = false;
    getProject(id)
      .then((p) => {
        if (!cancelled) setProject(p);
      })
      .catch(() => {
        if (!cancelled) setProject(null);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(() => {
    // Filter or tab changed — treat this as a fresh load so the user gets a
    // skeleton while the new query runs.
    hasLoadedOnceRef.current = false;
    failureCountRef.current = 0;
    loadSessions();
  }, [loadSessions]);

  // Auto-refresh: only on the Live tab. Completed sessions don't change.
  // Cadence backs off on consecutive failures (15s → 30s → 60s, capped) so
  // a backend outage doesn't drown the runner-api in retries.
  useEffect(() => {
    if (tab !== "live") return;
    let cancelled = false;
    const schedule = () => {
      if (cancelled) return;
      const failures = failureCountRef.current;
      const delay =
        failures === 0
          ? 15_000
          : Math.min(15_000 * 2 ** Math.min(failures, 3), 60_000);
      const timer = setTimeout(async () => {
        await loadSessions({ silent: true });
        schedule();
      }, delay);
      cleanup = () => clearTimeout(timer);
    };
    let cleanup = () => {};
    schedule();
    return () => {
      cancelled = true;
      cleanup();
    };
  }, [tab, loadSessions]);

  // Group completed sessions by local day. Memoised so re-renders triggered
  // by `copiedId` toggling don't re-bucket the entire list.
  const groupedByDay = useMemo(() => {
    if (tab !== "completed") return [];
    const groups = new Map<string, SeleniumSession[]>();
    for (const s of sessions) {
      const key = localDayKey(s.endedAt || s.startedAt || s.queuedAt);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(s);
    }
    // Map.entries() preserves insertion order, and since the API returns
    // sessions newest-first, the resulting day groups are already sorted
    // descending by date.
    return Array.from(groups.entries());
  }, [sessions, tab]);

  const liveTotal = counts.queued + counts.active;
  const completedTotal = counts.ended + counts.abandoned + counts.failed;

  const isSelenium =
    (project?.settings as { framework?: string } | null | undefined)
      ?.framework === "selenium";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--foreground)]">
            Selenium Sessions
          </h1>
          <p className="text-sm text-[var(--muted)]">
            Every WebDriver session that hits the authenticated grid endpoint
            for{" "}
            <span className="font-medium">
              {project?.name || "this project"}
            </span>
            .
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-[var(--muted)]">
          {refreshError ? (
            <span
              className="inline-flex items-center gap-1 text-[var(--warning)]"
              title={refreshError}
            >
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--warning)]" />
              Couldn&apos;t refresh
              {refreshedAt && (
                <span className="text-[var(--muted)]">
                  · last updated{" "}
                  {formatRelative(new Date(refreshedAt).toISOString())}
                </span>
              )}
            </span>
          ) : (
            refreshedAt && (
              <span>
                Updated {formatRelative(new Date(refreshedAt).toISOString())}
              </span>
            )
          )}
          <Button
            size="sm"
            variant="secondary"
            onClick={() => loadSessions()}
            disabled={loading}
          >
            {loading ? "Refreshing…" : "Refresh"}
          </Button>
        </div>
      </div>

      {project && !isSelenium && (
        <Card>
          <CardBody className="p-5">
            <p className="text-sm text-[var(--foreground)]">
              This project uses{" "}
              <span className="font-medium">
                {(project.settings as { framework?: string } | null | undefined)
                  ?.framework || "Playwright"}
              </span>
              , so direct Selenium grid sessions don&apos;t apply here. Use the
              Automation Runs view to see your test history.
            </p>
          </CardBody>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <MetricCard
          label="Queued"
          value={counts.queued}
          valueColor={
            counts.queued > 0 ? "var(--brand-primary)" : undefined
          }
        />
        <MetricCard
          label="Active"
          value={counts.active}
          valueColor={counts.active > 0 ? "var(--success)" : undefined}
        />
        <MetricCard label="Ended" value={counts.ended} />
        <MetricCard
          label="Abandoned"
          value={counts.abandoned}
          valueColor={
            counts.abandoned > 0 ? "var(--warning)" : undefined
          }
        />
        <MetricCard
          label="Failed"
          value={counts.failed}
          valueColor={counts.failed > 0 ? "var(--error)" : undefined}
        />
      </div>

      <TabBar
        active={tab}
        onChange={setTab}
        liveCount={liveTotal}
        completedCount={completedTotal}
      />

      <Card>
        <CardBody className="space-y-4 p-5">
          <div className="grid gap-3 sm:grid-cols-[200px_1fr_auto] sm:items-end">
            {tab === "live" ? (
              <Field>
                <FieldLabel>Status</FieldLabel>
                <div className="flex gap-2">
                  <ToggleChip
                    active={liveStatus === "all"}
                    onClick={() => setLiveStatus("all")}
                  >
                    All
                  </ToggleChip>
                  <ToggleChip
                    active={liveStatus === "queued"}
                    onClick={() => setLiveStatus("queued")}
                  >
                    Queued
                  </ToggleChip>
                  <ToggleChip
                    active={liveStatus === "active"}
                    onClick={() => setLiveStatus("active")}
                  >
                    Active
                  </ToggleChip>
                </div>
              </Field>
            ) : (
              <Field>
                <FieldLabel>Status</FieldLabel>
                <div className="flex flex-wrap gap-2">
                  <ToggleChip
                    active={completedStatus === "all"}
                    onClick={() => setCompletedStatus("all")}
                  >
                    All
                  </ToggleChip>
                  <ToggleChip
                    active={completedStatus === "ended"}
                    onClick={() => setCompletedStatus("ended")}
                  >
                    Ended
                  </ToggleChip>
                  <ToggleChip
                    active={completedStatus === "abandoned"}
                    onClick={() => setCompletedStatus("abandoned")}
                  >
                    Abandoned
                  </ToggleChip>
                  <ToggleChip
                    active={completedStatus === "failed"}
                    onClick={() => setCompletedStatus("failed")}
                  >
                    Failed
                  </ToggleChip>
                </div>
              </Field>
            )}

            <Field>
              <FieldLabel>
                Build{" "}
                <span className="text-[var(--muted)]">
                  (tesbo:options.build)
                </span>
              </FieldLabel>
              <Input
                value={buildInput}
                placeholder="e.g. ci-2026-04-27-1234"
                onChange={(e) => setBuildInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    setBuildFilter(buildInput.trim());
                  }
                }}
              />
            </Field>
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => setBuildFilter(buildInput.trim())}
              >
                Apply
              </Button>
              {buildFilter && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setBuildInput("");
                    setBuildFilter("");
                  }}
                >
                  Clear
                </Button>
              )}
            </div>
          </div>

          {tab === "completed" && (
            <div className="grid gap-3 sm:grid-cols-[200px_200px_auto] sm:items-end">
              <Field>
                <FieldLabel>From</FieldLabel>
                <Input
                  type="date"
                  value={fromDate}
                  max={toDate || undefined}
                  onChange={(e) => setFromDate(e.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel>To</FieldLabel>
                <Input
                  type="date"
                  value={toDate}
                  min={fromDate || undefined}
                  max={todayLocalIso()}
                  onChange={(e) => setToDate(e.target.value)}
                />
              </Field>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setFromDate(daysAgoLocalIso(1));
                    setToDate(todayLocalIso());
                  }}
                >
                  Today
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setFromDate(daysAgoLocalIso(7));
                    setToDate(todayLocalIso());
                  }}
                >
                  7 days
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setFromDate(daysAgoLocalIso(30));
                    setToDate(todayLocalIso());
                  }}
                >
                  30 days
                </Button>
              </div>
            </div>
          )}

          {buildFilter && (
            <p className="text-xs text-[var(--muted)]">
              Filtering for build{" "}
              <code className="font-mono text-[11px] text-[var(--foreground)]">
                {buildFilter}
              </code>
              .
            </p>
          )}
        </CardBody>
      </Card>

      {error && <ErrorBlock message={error} retry={() => loadSessions()} />}

      {loading && sessions.length === 0 ? (
        <Card>
          <CardBody className="p-0">
            <TableSkeleton rows={5} />
          </CardBody>
        </Card>
      ) : sessions.length === 0 ? (
        <Card>
          <CardBody className="p-6">
            <EmptyStateBlock
              title={
                tab === "live"
                  ? "No live sessions right now"
                  : "No completed sessions in this range"
              }
              description={
                tab === "live"
                  ? "Once you point a WebDriver client at the authenticated grid URL, every session will show up here within a few seconds."
                  : "Try widening the date range or clearing the build filter to see more history."
              }
            />
          </CardBody>
        </Card>
      ) : tab === "live" ? (
        <Card>
          <CardBody className="p-0">
            <SessionsTable
              sessions={sessions}
              projectId={id}
              copiedId={copiedId}
              onCopy={copySeleniumId}
            />
          </CardBody>
        </Card>
      ) : (
        // Completed sessions are bucketed by local day so users with hundreds
        // of finished sessions can scan the timeline at a glance.
        <div className="space-y-4">
          {groupedByDay.map(([day, rows]) => (
            <Card key={day}>
              <CardBody className="p-0">
                <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-4 py-2.5">
                  <h2 className="text-sm font-semibold text-[var(--foreground)]">
                    {day}
                  </h2>
                  <span className="text-xs text-[var(--muted)]">
                    {rows.length} {rows.length === 1 ? "session" : "sessions"}
                  </span>
                </div>
                <SessionsTable
                  sessions={rows}
                  projectId={id}
                  copiedId={copiedId}
                  onCopy={copySeleniumId}
                />
              </CardBody>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function TabBar({
  active,
  onChange,
  liveCount,
  completedCount,
}: {
  active: Tab;
  onChange: (t: Tab) => void;
  liveCount: number;
  completedCount: number;
}) {
  return (
    <div
      role="tablist"
      className="flex gap-1 rounded-xl border border-[var(--glass-border-soft)] bg-[var(--glass-bg-subtle)] p-1"
    >
      <TabButton
        active={active === "live"}
        onClick={() => onChange("live")}
        label="Live"
        count={liveCount}
        accent="success"
      />
      <TabButton
        active={active === "completed"}
        onClick={() => onChange("completed")}
        label="Completed"
        count={completedCount}
      />
    </div>
  );
}

function TabButton({
  active,
  onClick,
  label,
  count,
  accent,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
  accent?: "success";
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_oklab,var(--brand-primary)_30%,transparent)] ${
        active
          ? "bg-[var(--surface-primary)] text-[var(--foreground)] shadow-sm"
          : "text-[var(--muted)] hover:text-[var(--foreground)]"
      }`}
    >
      {accent === "success" && count > 0 && (
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--success)]" />
      )}
      {label}
      <span
        className={`rounded-full px-2 py-0.5 text-[11px] tabular-nums ${
          active
            ? "bg-[var(--surface-secondary)] text-[var(--foreground)]"
            : "bg-[var(--glass-bg)] text-[var(--muted)]"
        }`}
      >
        {count}
      </span>
    </button>
  );
}

function ToggleChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_oklab,var(--brand-primary)_30%,transparent)] ${
        active
          ? "border-[var(--brand-primary)] bg-[var(--brand-soft)] text-[var(--brand-primary)]"
          : "border-[var(--glass-border-soft)] bg-[var(--glass-bg-subtle)] text-[var(--foreground)] hover:border-[var(--glass-border)]"
      }`}
    >
      {children}
    </button>
  );
}

function SessionsTable({
  sessions,
  projectId,
  copiedId,
  onCopy,
}: {
  sessions: SeleniumSession[];
  projectId: string;
  copiedId: string | null;
  onCopy: (seleniumId: string) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="tesbo-table min-w-[960px]">
        <thead>
          <tr>
            <th>Status</th>
            <th>Started</th>
            <th>Build / Name</th>
            <th>Browser</th>
            <th>Platform</th>
            <th>Duration</th>
            <th>Session ID</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((s) => {
            const tone = STATUS_TONE[s.status] ?? "neutral";
            const startTimestamp = s.startedAt || s.queuedAt;
            const detailHref = s.seleniumId
              ? `/projects/${projectId}/sessions/${encodeURIComponent(
                  s.seleniumId
                )}`
              : null;
            return (
              <tr key={s.id}>
                <td>
                  <StatusChip tone={tone}>
                    {(s.status === "active" || s.status === "queued") && (
                      <span className="mr-1 h-1.5 w-1.5 animate-pulse rounded-full bg-current inline-block" />
                    )}
                    {s.status.charAt(0).toUpperCase() + s.status.slice(1)}
                  </StatusChip>
                </td>
                <td className="text-sm text-[var(--muted)]">
                  <div className="flex flex-col">
                    <span className="text-[var(--foreground)]">
                      {formatRelative(startTimestamp)}
                    </span>
                    <span className="text-[11px]">
                      {formatTime(startTimestamp)}
                    </span>
                  </div>
                </td>
                <td>
                  <div className="flex flex-col">
                    <span className="text-sm font-medium text-[var(--foreground)]">
                      {s.name || "—"}
                    </span>
                    {s.build && (
                      <code className="font-mono text-[11px] text-[var(--muted)]">
                        {s.build}
                      </code>
                    )}
                  </div>
                </td>
                <td className="text-sm text-[var(--foreground)]">
                  {s.browser
                    ? `${s.browser}${
                        s.browserVersion ? ` ${s.browserVersion}` : ""
                      }`
                    : "—"}
                </td>
                <td className="text-sm text-[var(--muted)]">
                  {s.platform || "—"}
                </td>
                <td className="text-sm text-[var(--foreground)]">
                  {formatDuration(s.durationMs)}
                  {s.endReason && (
                    <span className="ml-1 text-[11px] text-[var(--muted)]">
                      ({s.endReason})
                    </span>
                  )}
                </td>
                <td>
                  {s.seleniumId ? (
                    <button
                      type="button"
                      onClick={() => onCopy(s.seleniumId!)}
                      title={
                        copiedId === s.seleniumId
                          ? "Copied!"
                          : "Click to copy session ID"
                      }
                      className="group flex items-center gap-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_oklab,var(--brand-primary)_30%,transparent)] rounded"
                    >
                      <code className="font-mono text-[11px] text-[var(--muted)] break-all group-hover:text-[var(--foreground)] transition-colors">
                        {s.seleniumId.slice(0, 12)}…
                      </code>
                      <span className="text-[10px] text-[var(--muted)] opacity-0 group-hover:opacity-100 transition-opacity">
                        {copiedId === s.seleniumId ? "✓" : "copy"}
                      </span>
                    </button>
                  ) : (
                    <span className="text-[11px] italic text-[var(--muted)]">
                      waiting…
                    </span>
                  )}
                </td>
                <td className="whitespace-nowrap">
                  {detailHref ? (
                    <Link
                      href={detailHref}
                      className="inline-flex items-center gap-1 rounded-xl border border-[var(--glass-border)] bg-[var(--glass-bg-subtle)] px-2.5 py-1 text-[11px] font-medium text-[var(--foreground)] hover:bg-[var(--glass-bg)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_oklab,var(--brand-primary)_30%,transparent)]"
                    >
                      {s.liveAvailable ? "Watch live" : "View"}
                    </Link>
                  ) : (
                    <span className="text-[11px] text-[var(--muted)]">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
