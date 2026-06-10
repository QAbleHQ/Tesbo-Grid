"use client";

import Link from "next/link";
import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import LiveVncViewer from "@/components/LiveVncViewer";
import { Button, Card, CardBody, ErrorBlock, StatusChip } from "@/components/ui";
import {
  buildSeleniumLiveVncUrl,
  getSeleniumSession,
  getSeleniumSessionCommands,
  getSeleniumSessionTests,
  type SeleniumSession,
  type SeleniumSessionCommand,
  type SeleniumSessionLinkedTest,
} from "@/lib/api";

const STATUS_TONE: Record<string, "brand" | "success" | "warning" | "error" | "neutral"> = {
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

export default function SeleniumSessionDetailPage({
  params,
}: {
  params: Promise<{ id: string; seleniumId: string }>;
}) {
  const { id: projectId, seleniumId: rawSeleniumId } = use(params);
  const seleniumId = decodeURIComponent(rawSeleniumId);

  const [session, setSession] = useState<SeleniumSession | null>(null);
  const [commands, setCommands] = useState<SeleniumSessionCommand[]>([]);
  const [linkedTests, setLinkedTests] = useState<SeleniumSessionLinkedTest[]>([]);
  const [zoomedScreenshot, setZoomedScreenshot] = useState<
    SeleniumSessionLinkedTest | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedCommandId, setSelectedCommandId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const copySeleniumId = () => {
    navigator.clipboard.writeText(seleniumId).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  // Track the highest sequence we've already fetched to keep poll payloads
  // tiny — without this every poll re-downloads the full ring buffer.
  const sinceRef = useRef(0);
  // The commands list scrolls to the bottom as new entries arrive, *unless*
  // the user has scrolled up to inspect history. We disable auto-scroll until
  // they scroll back to within ~60px of the bottom.
  const listRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);

  // Track whether we have ever successfully loaded the session. Once we
  // have, intermittent poll failures should NOT replace the live viewer
  // and command feed with a full-screen error block — the next tick
  // almost always recovers.
  const sessionLoadedRef = useRef(false);

  const refreshSession = useCallback(async () => {
    try {
      const result = await getSeleniumSession(projectId, seleniumId);
      setSession(result.session);
      sessionLoadedRef.current = true;
      setError(null);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to load session";
      if (sessionLoadedRef.current) {
        // Background refresh blip — keep the viewer visible.
        // eslint-disable-next-line no-console
        console.warn("session refresh failed", message);
        return;
      }
      setError(message);
    }
  }, [projectId, seleniumId]);

  const refreshCommands = useCallback(async () => {
    try {
      const result = await getSeleniumSessionCommands(projectId, seleniumId, {
        since: sinceRef.current,
        limit: 200,
      });
      if (result.commands.length === 0) return;
      const lastSeq = result.commands[result.commands.length - 1].sequence;
      if (lastSeq > sinceRef.current) sinceRef.current = lastSeq;
      setCommands((prev) => {
        const next = prev.concat(result.commands);
        // Cap client-side memory at the same window the proxy keeps.
        if (next.length > 500) return next.slice(next.length - 500);
        return next;
      });
    } catch (err) {
      // Network blips during a poll shouldn't blow up the page; the next
      // tick will recover.
      // eslint-disable-next-line no-console
      console.warn("commands refresh failed", err);
    }
  }, [projectId, seleniumId]);

  const refreshTests = useCallback(async () => {
    try {
      const result = await getSeleniumSessionTests(projectId, seleniumId);
      setLinkedTests(result.tests);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("session tests refresh failed", err);
    }
  }, [projectId, seleniumId]);

  useEffect(() => {
    refreshSession();
    refreshTests();
  }, [refreshSession, refreshTests]);

  useEffect(() => {
    refreshCommands();
    // Active sessions: poll every 1.5s. Otherwise back off to 5s so we still
    // pick up post-mortem command flushes without burning bandwidth.
    const interval = session && session.status === "active" ? 1500 : 5000;
    const timer = setInterval(() => {
      refreshCommands();
      // Re-check session status so we transition the polling cadence and
      // hide the live viewer when the session ends.
      refreshSession();
      // Linked test artifacts (screenshots, video, trace) trickle in as CLI
      // workers upload their report mid-run. Refresh on every tick while the
      // session is active; once it ends the linker stops adding rows so we
      // can rely on the post-end refresh that happens when status flips.
      refreshTests();
    }, interval);
    return () => clearInterval(timer);
  }, [refreshCommands, refreshSession, refreshTests, session]);

  // Keep auto-scroll glued to the bottom unless the user scrolled up.
  useEffect(() => {
    const el = listRef.current;
    if (!el || !stickRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [commands]);

  const wsUrl = useMemo(
    () => buildSeleniumLiveVncUrl(projectId, seleniumId),
    [projectId, seleniumId]
  );

  const showLiveViewer =
    !!session &&
    session.status === "active" &&
    session.liveAvailable &&
    !!session.seleniumId;

  // Show the recorded video only after the session has fully concluded —
  // mid-test the .mp4 hasn't been finalised by the selenium-node video
  // sidecar yet, so loading it would 404 or play a truncated file.
  const showRecordedVideo =
    !!session &&
    !showLiveViewer &&
    !!session.videoUrl &&
    (session.status === "ended" ||
      session.status === "abandoned" ||
      session.status === "failed");

  const selectedCommand = useMemo(
    () => commands.find((c) => c.id === selectedCommandId) || null,
    [commands, selectedCommandId]
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <Link
            href={`/projects/${projectId}/sessions`}
            className="text-xs text-[var(--brand-primary)] hover:underline"
          >
            ← Back to Live Sessions
          </Link>
          <h1 className="text-2xl font-semibold text-[var(--foreground)]">
            {session?.name || "Selenium session"}
          </h1>
          <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--muted)]">
            {session && (
              <StatusChip tone={STATUS_TONE[session.status] ?? "neutral"}>
                {(session.status === "active" || session.status === "queued") && (
                  <span className="mr-1 h-1.5 w-1.5 animate-pulse rounded-full bg-current inline-block" />
                )}
                {session.status}
              </StatusChip>
            )}
            <span>
              Started {formatTime(session?.startedAt || session?.queuedAt || null)}
            </span>
            {session?.durationMs != null && (
              <span>· {formatDuration(session.durationMs)}</span>
            )}
            {session?.build && <span>· build {session.build}</span>}
          </div>
          <button
            type="button"
            onClick={copySeleniumId}
            title={copied ? "Copied!" : "Click to copy session ID"}
            className="group flex items-center gap-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_oklab,var(--brand-primary)_30%,transparent)] rounded"
          >
            <code className="font-mono text-[11px] text-[var(--muted)] break-all group-hover:text-[var(--foreground)] transition-colors">
              {seleniumId}
            </code>
            <span className="text-[10px] text-[var(--muted)] opacity-0 group-hover:opacity-100 transition-opacity">
              {copied ? "✓ copied" : "copy"}
            </span>
          </button>
        </div>
      </div>

      {error && <ErrorBlock message={error} retry={refreshSession} />}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
        <Card className="overflow-hidden">
          <CardBody className="p-0">
            <div className="aspect-video w-full bg-black">
              {showLiveViewer ? (
                <LiveVncViewer
                  wsUrl={wsUrl}
                  className="h-full w-full"
                />
              ) : showRecordedVideo ? (
                <RecordedVideo videoUrl={session!.videoUrl!} />
              ) : (
                <NonLivePlaceholder session={session} />
              )}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--glass-border)] px-4 py-2 text-xs text-[var(--muted)]">
              <div>
                {session?.browser
                  ? `${session.browser}${session.browserVersion ? ` ${session.browserVersion}` : ""}`
                  : "—"}
                {session?.platform ? ` · ${session.platform}` : ""}
              </div>
              {session?.endReason && <div>End reason: {session.endReason}</div>}
            </div>
          </CardBody>
        </Card>

        <Card className="overflow-hidden">
          <CardBody className="flex h-[600px] flex-col p-0">
            <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-4 py-2">
              <div>
                <h3 className="text-sm font-semibold text-[var(--foreground)]">
                  Selenium commands
                </h3>
                <p className="text-[11px] text-[var(--muted)]">
                  Live tail · {commands.length} captured
                </p>
              </div>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  sinceRef.current = 0;
                  setCommands([]);
                  refreshCommands();
                }}
              >
                Reload
              </Button>
            </div>
            <div
              ref={listRef}
              className="flex-1 overflow-y-auto"
              onScroll={(e) => {
                const el = e.currentTarget;
                stickRef.current =
                  el.scrollHeight - el.scrollTop - el.clientHeight < 60;
              }}
            >
              {commands.length === 0 ? (
                <p className="p-6 text-xs text-[var(--muted)]">
                  No commands yet. The first WebDriver call from your test will
                  appear here within a second of being sent.
                </p>
              ) : (
                <ul className="divide-y divide-[var(--border-subtle)]">
                  {commands.map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        className={`flex w-full items-start gap-2 px-3 py-2 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[color-mix(in_oklab,var(--brand-primary)_30%,transparent)] hover:bg-[var(--glass-bg-subtle)] ${
                          selectedCommandId === c.id
                            ? "bg-[var(--glass-bg-subtle)]"
                            : ""
                        }`}
                        onClick={() =>
                          setSelectedCommandId((prev) =>
                            prev === c.id ? null : c.id
                          )
                        }
                      >
                        <span className="mt-0.5 inline-flex w-10 shrink-0 justify-center rounded-xl glass-subtle px-1 text-[10px] font-mono text-[var(--muted)]">
                          {c.method}
                        </span>
                        <div className="flex min-w-0 flex-1 flex-col">
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate font-medium text-[var(--foreground)]">
                              {c.command || c.path}
                            </span>
                            <span
                              className={`shrink-0 font-mono text-[10px] ${
                                c.status && c.status >= 400
                                  ? "text-[var(--error)]"
                                  : "text-[var(--muted)]"
                              }`}
                            >
                              {c.status ?? "—"} · {c.durationMs ?? 0}ms
                            </span>
                          </div>
                          <code className="truncate font-mono text-[10px] text-[var(--muted)]">
                            {c.path}
                          </code>
                        </div>
                      </button>
                      {selectedCommandId === c.id && (
                        <div className="space-y-1 border-t border-[var(--glass-border)] glass-subtle px-3 py-2 text-[11px] text-[var(--muted)]">
                          {c.requestBody && (
                            <details open>
                              <summary className="cursor-pointer text-[var(--foreground)]">
                                Request
                              </summary>
                              <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] text-[var(--foreground)]">
                                {c.requestBody}
                              </pre>
                            </details>
                          )}
                          {c.responseBody && (
                            <details>
                              <summary className="cursor-pointer text-[var(--foreground)]">
                                Response
                              </summary>
                              <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] text-[var(--foreground)]">
                                {c.responseBody}
                              </pre>
                            </details>
                          )}
                          {c.error && (
                            <div className="text-[var(--error)]">
                              {c.error}
                            </div>
                          )}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </CardBody>
        </Card>
      </div>

      {selectedCommand && (
        <p className="text-[11px] text-[var(--muted)]">
          Click a command again to collapse its payload.
        </p>
      )}

      <LinkedTestArtifacts
        projectId={projectId}
        tests={linkedTests}
        sessionActive={!!session && session.status === "active"}
        onZoom={(test) => setZoomedScreenshot(test)}
      />

      {zoomedScreenshot && zoomedScreenshot.screenshotUrl && (
        <ScreenshotLightbox
          test={zoomedScreenshot}
          onClose={() => setZoomedScreenshot(null)}
        />
      )}
    </div>
  );
}

function LinkedTestArtifacts({
  projectId,
  tests,
  sessionActive,
  onZoom,
}: {
  projectId: string;
  tests: SeleniumSessionLinkedTest[];
  sessionActive: boolean;
  onZoom: (test: SeleniumSessionLinkedTest) => void;
}) {
  if (tests.length === 0) {
    if (sessionActive) {
      return (
        <Card>
          <CardBody className="space-y-1 px-4 py-3">
            <h3 className="text-sm font-semibold text-[var(--foreground)]">
              Linked test artifacts
            </h3>
            <p className="text-xs text-[var(--muted)]">
              Waiting for the CLI runner to upload screenshots. They appear here
              within a few seconds of each test finishing.
            </p>
          </CardBody>
        </Card>
      );
    }
    return null;
  }

  return (
    <Card>
      <CardBody className="space-y-3 px-4 py-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-[var(--foreground)]">
              Linked test artifacts
            </h3>
            <p className="text-[11px] text-[var(--muted)]">
              {tests.length} test{tests.length === 1 ? "" : "s"} ran in this
              session · click a screenshot to zoom
            </p>
          </div>
        </div>
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {tests.map((t) => (
            <li
              key={t.id}
              className="space-y-2 rounded-lg border border-[var(--glass-border)] glass-subtle p-2"
            >
              {t.screenshotUrl ? (
                <button
                  type="button"
                  onClick={() => onZoom(t)}
                  className="block w-full overflow-hidden rounded bg-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_oklab,var(--brand-primary)_30%,transparent)]"
                  title="Click to zoom"
                >
                  <img
                    src={t.screenshotUrl}
                    alt={t.name || "test screenshot"}
                    loading="lazy"
                    className="aspect-video w-full object-cover transition-transform hover:scale-[1.02]"
                  />
                </button>
              ) : (
                <div className="flex aspect-video w-full items-center justify-center rounded bg-[var(--glass-bg-subtle)] text-[11px] text-[var(--muted)]">
                  No screenshot
                </div>
              )}
              <div className="space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <span
                    className="truncate text-xs font-medium text-[var(--foreground)]"
                    title={t.fullTitle || t.name || ""}
                  >
                    {t.name || t.fullTitle || "Untitled test"}
                  </span>
                  <StatusChip tone={testStatusTone(t.status)}>
                    {(t.status || "—").toLowerCase()}
                  </StatusChip>
                </div>
                {t.spec && (
                  <p
                    className="truncate text-[10px] text-[var(--muted)]"
                    title={t.spec}
                  >
                    {t.spec}
                  </p>
                )}
                {t.errorMessage && (
                  <p
                    className="line-clamp-2 text-[10px] text-[var(--error)]"
                    title={t.errorMessage}
                  >
                    {t.errorMessage}
                  </p>
                )}
                <div className="flex flex-wrap gap-2 pt-1 text-[10px]">
                  {t.videoUrl && (
                    <a
                      href={t.videoUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[var(--brand-primary)] hover:underline"
                    >
                      Video
                    </a>
                  )}
                  {t.traceUrl && (
                    <a
                      href={t.traceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[var(--brand-primary)] hover:underline"
                    >
                      Trace
                    </a>
                  )}
                  <Link
                    href={`/projects/${projectId}/tesbo-reports/runs/${t.runId}`}
                    className="text-[var(--brand-primary)] hover:underline"
                  >
                    Run report
                  </Link>
                </div>
              </div>
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}

function testStatusTone(
  status: string | null
): "brand" | "success" | "warning" | "error" | "neutral" {
  const s = (status || "").toLowerCase();
  if (s === "passed" || s === "pass") return "success";
  if (s === "failed" || s === "fail") return "error";
  if (s === "skipped" || s === "pending") return "warning";
  return "neutral";
}

function ScreenshotLightbox({
  test,
  onClose,
}: {
  test: SeleniumSessionLinkedTest;
  onClose: () => void;
}) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={test.name || "Screenshot"}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div
        className="relative max-h-full max-w-6xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <img
          src={test.screenshotUrl!}
          alt={test.name || "screenshot"}
          className="max-h-[85vh] max-w-full rounded object-contain"
        />
        <button
          type="button"
          onClick={onClose}
          className="absolute -right-2 -top-2 rounded-full bg-[var(--background)] px-2 py-1 text-xs font-medium text-[var(--foreground)] shadow"
        >
          Close ✕
        </button>
        {test.name && (
          <p className="mt-2 text-center text-xs text-white/80">{test.name}</p>
        )}
      </div>
    </div>
  );
}

function NonLivePlaceholder({ session }: { session: SeleniumSession | null }) {
  let title = "Connecting…";
  let body =
    "Waiting for the dashboard to load this session before showing the live browser.";
  if (session?.status === "queued") {
    title = "Waiting for a node slot";
    body =
      "The Selenium hub will show this session live as soon as a browser node is free.";
  } else if (session?.status === "ended") {
    title = "Session ended";
    body =
      "The recorded video usually appears within a minute of the session ending — refresh if it doesn't show up here yet.";
  } else if (session?.status === "abandoned") {
    title = "Session abandoned";
    body =
      "The client never sent a clean quit, so the proxy reaped this session. The video may still be processing.";
  } else if (session?.status === "failed") {
    title = "Session failed to start";
    body =
      session.endReason ||
      "The Selenium hub returned an error before the session got going.";
  } else if (session && !session.liveAvailable) {
    title = "Live view not available";
    body =
      "The proxy hasn't been able to discover which node holds this session. Live VNC may not be enabled in your cluster.";
  }
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-6 text-center text-sm">
      <p className="text-base font-semibold text-[var(--foreground)]">{title}</p>
      <p className="max-w-md text-[var(--muted)]">{body}</p>
    </div>
  );
}

function RecordedVideo({ videoUrl }: { videoUrl: string }) {
  // Cache busting is intentionally left to the browser/CDN — Spaces returns
  // immutable mp4s so a stale CDN entry would still be the right file.
  const [errored, setErrored] = useState(false);

  if (errored) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-6 text-center text-sm">
        <p className="text-base font-semibold text-[var(--foreground)]">
          Video not yet available
        </p>
        <p className="max-w-md text-[var(--muted)]">
          The recording is still being uploaded by the browser node. Try again
          in a few seconds, or open the file directly to retry.
        </p>
        <a
          href={videoUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-[var(--brand-primary)] hover:underline"
        >
          Open video in a new tab
        </a>
      </div>
    );
  }

  return (
    <video
      src={videoUrl}
      controls
      preload="metadata"
      className="h-full w-full bg-black"
      onError={() => setErrored(true)}
    >
      <track kind="captions" />
    </video>
  );
}
