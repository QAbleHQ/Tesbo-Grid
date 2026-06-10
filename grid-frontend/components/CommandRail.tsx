"use client";

import { useMemo } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { ChevronRight } from "lucide-react";

type Crumb = { label: string; href?: string };

function buildBreadcrumbs(pathname: string): Crumb[] {
  const crumbs: Crumb[] = [];

  const projectMatch = pathname.match(/^\/projects\/([^/]+)(\/(.*))?$/);

  if (!projectMatch) {
    if (pathname === "/projects") return [{ label: "Projects" }];
    if (pathname.startsWith("/settings/members")) return [{ label: "Settings" }, { label: "Members" }];
    if (pathname.startsWith("/settings/integrations")) return [{ label: "Settings" }, { label: "API Keys" }];
    return [{ label: "Workspace" }];
  }

  const projectId = projectMatch[1];
  const suffix = projectMatch[3] || "";
  crumbs.push({ label: "Projects", href: "/projects" });

  if (!suffix || suffix === "dashboard") {
    crumbs.push({ label: "Dashboard" });
    return crumbs;
  }

  crumbs.push({ label: "Dashboard", href: `/projects/${projectId}/dashboard` });

  if (suffix.startsWith("tesbo-reports/runs/")) {
    crumbs.push({ label: "Runs", href: `/projects/${projectId}/tesbo-reports/runs` });
    crumbs.push({ label: "Run Detail" });
  } else if (suffix === "tesbo-reports/runs") {
    crumbs.push({ label: "Automation Runs" });
  } else if (suffix.startsWith("tesbo-reports/specs/detail")) {
    crumbs.push({ label: "Spec Intelligence", href: `/projects/${projectId}/tesbo-reports/specs` });
    crumbs.push({ label: "Spec Detail" });
  } else if (suffix === "tesbo-reports/specs") {
    crumbs.push({ label: "Spec Intelligence" });
  } else if (suffix.startsWith("tesbo-reports/tests/detail")) {
    crumbs.push({ label: "Test Intelligence", href: `/projects/${projectId}/tesbo-reports/tests` });
    crumbs.push({ label: "Test Detail" });
  } else if (suffix === "tesbo-reports/tests") {
    crumbs.push({ label: "Test Intelligence" });
  } else if (suffix === "tesbo-reports/analytics") {
    crumbs.push({ label: "Analytics" });
  } else   if (suffix === "integration") {
    crumbs.push({ label: "Integration Guide" });
  } else if (suffix === "alerts") {
    crumbs.push({ label: "Alerts" });
  } else if (suffix === "settings") {
    crumbs.push({ label: "Settings" });
  } else if (suffix === "sessions") {
    crumbs.push({ label: "Live Sessions" });
  } else if (suffix.startsWith("sessions/")) {
    const sessionId = suffix.replace("sessions/", "");
    crumbs.push({ label: "Live Sessions", href: `/projects/${projectId}/sessions` });
    crumbs.push({ label: `Session ${sessionId.slice(0, 8)}…` });
  } else {
    const last = suffix.split("/").pop() || "Page";
    crumbs.push({ label: last.charAt(0).toUpperCase() + last.slice(1) });
  }

  return crumbs;
}

export default function CommandRail() {
  const pathname = usePathname();
  const breadcrumbs = useMemo(() => buildBreadcrumbs(pathname), [pathname]);

  return (
    <header className="glass-rail sticky top-0 z-20">
      <div className="flex h-12 items-center px-4 md:px-6">
        <nav className="flex min-w-0 items-center gap-1 text-sm" aria-label="Breadcrumb">
          {breadcrumbs.map((crumb, i) => {
            const isLast = i === breadcrumbs.length - 1;
            return (
              <span key={i} className="flex items-center gap-1 min-w-0">
                {i > 0 && (
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--muted-soft)]" />
                )}
                {crumb.href && !isLast ? (
                  <Link
                    href={crumb.href}
                    className="truncate text-[var(--muted)] hover:text-[var(--foreground)] transition-colors"
                  >
                    {crumb.label}
                  </Link>
                ) : (
                  <span className={`truncate ${isLast ? "font-medium text-[var(--foreground)]" : "text-[var(--muted)]"}`}>
                    {crumb.label}
                  </span>
                )}
              </span>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
