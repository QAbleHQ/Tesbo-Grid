"use client";

import { useEffect, useRef, useState } from "react";

// Lightweight wrapper around `@novnc/novnc`. The library only works in the
// browser, so we dynamic-import it inside useEffect to avoid pulling it into
// the SSR bundle (it touches `window`, `document`, `navigator` at the top
// level).
//
// Reconnect strategy: if the WebSocket disconnects, we surface the error and
// let the user click "Reconnect" — endless silent retries hide real failures
// (auth expired, session ended, hub crash) and run up VNC handshake cost.

type Props = {
  wsUrl: string;
  className?: string;
  onStatus?: (status: VncStatus) => void;
};

export type VncStatus =
  | { kind: "connecting" }
  | { kind: "connected" }
  | { kind: "disconnected"; reason: string; code?: number };

// grid-backend/src/routes/seleniumLiveVnc.js closes the WebSocket with one
// of these app-level codes (RFC 6455 reserves 4000-4999 for applications)
// when the live viewer can be set up but the upstream stream isn't usable.
// Keeping the mapping client-side lets us localise messages and avoid
// leaking the precise infra reason to users.
function describeCloseCode(code: number | undefined, clean: boolean): string {
  switch (code) {
    case 4401:
      return "Sign-in expired — reload the page and sign in again.";
    case 4403:
      return "You don't have access to this project's live sessions.";
    case 4404:
      return "Session not found on the selenium proxy — it may have been reaped.";
    case 4409:
      return "Session is no longer active. Once a test ends the recorded video will appear here.";
    case 4502:
      // Most commonly hit immediately after session start, before the
      // selenium-proxy has discovered which node holds the session.
      return "The dashboard hasn't located the browser node yet. This usually clears within a few seconds — we'll keep retrying.";
    case 4503:
      return "Live viewer service is not configured on this deployment.";
    case 4500:
      return "Live viewer hit an internal error.";
    default:
      break;
  }
  if (clean || code === 1000 || code === 1001) return "Live view ended.";
  if (code === 1006) {
    return "Connection lost — the live viewer service or session is unavailable.";
  }
  if (code === 1011) return "Live viewer service hit an internal error.";
  if (code === 1012) return "Live viewer service is restarting.";
  if (code === 1013) return "Live viewer service is overloaded — try again.";
  if (code === 1015) return "TLS handshake failed reaching the live viewer.";
  return `Connection closed (code ${code ?? "unknown"}).`;
}

// Close codes that mean "the session is alive but the viewer infrastructure
// is briefly unavailable" — typically a race during the first second or two
// of a new session, before the proxy has found the browser node. Auto-retry
// with backoff instead of demanding a manual click.
function isTransientCloseCode(code: number | undefined): boolean {
  return code === 4502 || code === 1006 || code === 1011 || code === 1012 || code === 1013;
}

export default function LiveVncViewer({ wsUrl, className, onStatus }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // `RFB` is `any` because `@novnc/novnc` ships no types — see NoVNC issue
  // #1521. We only use a small surface so the loose typing is contained here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rfbRef = useRef<any>(null);
  const [status, setStatus] = useState<VncStatus>({ kind: "connecting" });
  const [reconnectKey, setReconnectKey] = useState(0);
  // Counts consecutive transient failures so we can back off and surface a
  // slightly different message after a few attempts (helps users distinguish
  // "still warming up" from "this will never work").
  const transientAttemptsRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    setStatus({ kind: "connecting" });

    (async () => {
      // Dynamic import keeps noVNC out of the SSR bundle.
      const mod = await import("@novnc/novnc");
      if (cancelled || !containerRef.current) return;
      const RFB = mod.default;

      try {
        const rfb = new RFB(containerRef.current, wsUrl, {
          // The selenium-node websockify is unauthenticated by default —
          // grid-selenium-proxy gates access to it via the project's API
          // key, so we don't surface a VNC password prompt.
          credentials: { password: process.env.NEXT_PUBLIC_VNC_PASSWORD || "" },
          wsProtocols: ["binary"],
        });
        rfb.scaleViewport = true;
        rfb.resizeSession = false;
        rfb.background = "#0d0d0d";
        rfb.viewOnly = false;
        rfb.qualityLevel = 6;
        rfb.compressionLevel = 2;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        rfb.addEventListener("connect", () => {
          if (cancelled) return;
          transientAttemptsRef.current = 0;
          const next: VncStatus = { kind: "connected" };
          setStatus(next);
          onStatus?.(next);
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        rfb.addEventListener("disconnect", (event: any) => {
          if (cancelled) return;
          const detail = event?.detail || {};
          const code: number | undefined =
            typeof detail.code === "number" ? detail.code : undefined;
          const clean: boolean = !!detail.clean;

          // Auto-retry transient failures. The dominant case in the wild is
          // "session was just created and the proxy hasn't finished
          // discovering the node yet" — manual reconnect is awful UX for
          // something that resolves itself in 1–3 seconds.
          if (isTransientCloseCode(code) && transientAttemptsRef.current < 6) {
            transientAttemptsRef.current += 1;
            const delay = Math.min(
              1000 * 2 ** (transientAttemptsRef.current - 1),
              8000
            );
            setStatus({ kind: "connecting" });
            window.setTimeout(() => {
              if (cancelled) return;
              setReconnectKey((n) => n + 1);
            }, delay);
            return;
          }

          const next: VncStatus = {
            kind: "disconnected",
            reason: describeCloseCode(code, clean),
            code,
          };
          setStatus(next);
          onStatus?.(next);
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        rfb.addEventListener("securityfailure", (event: any) => {
          if (cancelled) return;
          const next: VncStatus = {
            kind: "disconnected",
            reason:
              event?.detail?.reason || "VNC security handshake failed",
          };
          setStatus(next);
          onStatus?.(next);
        });

        rfbRef.current = rfb;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Could not start the VNC viewer";
        const next: VncStatus = { kind: "disconnected", reason: message };
        setStatus(next);
        onStatus?.(next);
      }
    })();

    return () => {
      cancelled = true;
      const rfb = rfbRef.current;
      if (rfb) {
        try { rfb.disconnect(); } catch { /* noop */ }
      }
      rfbRef.current = null;
    };
    // reconnectKey is in the deps so clicking "Reconnect" re-runs the effect.
  }, [wsUrl, reconnectKey, onStatus]);

  return (
    <div className={`relative ${className ?? ""}`}>
      {/* noVNC injects a <canvas> into this element. The fixed dark bg
          avoids a flash of light theme during the WS handshake. */}
      <div
        ref={containerRef}
        className="h-full w-full overflow-hidden rounded-xl bg-[#0d0d0d]"
      />
      {status.kind !== "connected" && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-xl bg-black/40 text-sm">
          <div className="glass-strong pointer-events-auto flex max-w-md flex-col items-center gap-3 px-5 py-4 text-center text-[var(--foreground)]">
            {status.kind === "connecting" ? (
              <>
                <span className="inline-flex h-2 w-2 animate-ping rounded-full bg-[var(--success)]" />
                <span className="text-[var(--muted)]">Connecting to live browser…</span>
              </>
            ) : (
              <>
                <span className="text-[var(--muted)]">{status.reason}</span>
                {typeof status.code === "number" && status.code > 0 && (
                  <span className="font-mono text-[10px] text-[var(--muted)]">
                    code {status.code}
                  </span>
                )}
                <button
                  type="button"
                  className="rounded-xl border border-[var(--glass-border)] bg-[var(--glass-bg-subtle)] px-4 py-1.5 text-xs font-medium text-[var(--foreground)] backdrop-blur-md hover:bg-[var(--glass-bg)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_oklab,var(--brand-primary)_30%,transparent)]"
                  onClick={() => {
                    transientAttemptsRef.current = 0;
                    setReconnectKey((n) => n + 1);
                  }}
                >
                  Reconnect
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
