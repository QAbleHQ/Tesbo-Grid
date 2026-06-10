"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  authMe,
  getProject,
  listProjects,
  logout,
  type ProjectDetail,
  type ProjectSummary,
} from "@/lib/api";
import BrandLogo from "@/components/BrandLogo";
import ThemeToggle from "@/components/ThemeToggle";

type NavItemConfig = {
  href: string;
  label: string;
  icon: MenuIconName;
  seleniumOnly?: boolean;
};

type NavScope = "workspace" | "project";

const workspaceNavItems: NavItemConfig[] = [
  { href: "/projects", label: "Projects", icon: "runs" },
  { href: "/settings/members", label: "Members", icon: "users" },
  { href: "/settings/integrations", label: "API Keys", icon: "key" },
];

const projectNavSections: Array<{ section: string; items: NavItemConfig[] }> = [
  {
    section: "Overview",
    items: [
      { href: "dashboard", label: "Dashboard", icon: "dashboard" },
      { href: "integration", label: "Integration Guide", icon: "plug" },
    ],
  },
  {
    section: "Execution",
    items: [
      { href: "tesbo-reports/runs", label: "Automation Runs", icon: "runs" },
      { href: "tesbo-reports/specs", label: "Spec Intelligence", icon: "specs" },
      { href: "tesbo-reports/tests", label: "Test Intelligence", icon: "tests" },
      { href: "tesbo-reports/analytics", label: "Analytics", icon: "analytics" },
      { href: "sessions", label: "Live Sessions", icon: "live", seleniumOnly: true },
    ],
  },
  {
    section: "Configuration",
    items: [
      { href: "scheduled-runs", label: "Scheduled Runs", icon: "calendar" },
      { href: "alerts", label: "Alerts", icon: "bell" },
      { href: "settings", label: "Settings", icon: "settings" },
    ],
  },
];

type MenuIconName =
  | "home" | "dashboard" | "project" | "runs" | "specs" | "tests"
  | "analytics" | "settings" | "users" | "plug" | "logout"
  | "chevronLeft" | "chevronRight" | "key" | "bell" | "billing" | "live" | "calendar";

function MenuIcon({ name, className = "h-[18px] w-[18px]" }: { name: MenuIconName; className?: string }) {
  const common = { className, fill: "none", stroke: "currentColor", strokeWidth: 1.75, viewBox: "0 0 24 24" } as const;
  switch (name) {
    case "home": return <svg {...common}><path strokeLinecap="round" strokeLinejoin="round" d="M3 11.5l9-7 9 7" /><path strokeLinecap="round" strokeLinejoin="round" d="M5 10v10h14V10" /></svg>;
    case "dashboard": return <svg {...common}><path strokeLinecap="round" strokeLinejoin="round" d="M4 4h7v7H4zM13 4h7v5h-7zM13 11h7v9h-7zM4 13h7v7H4z" /></svg>;
    case "project": return <svg {...common}><path strokeLinecap="round" strokeLinejoin="round" d="M3 7h8l2 2h8v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" /></svg>;
    case "runs": return <svg {...common}><path strokeLinecap="round" strokeLinejoin="round" d="M4 4h16v16H4z" /><path strokeLinecap="round" strokeLinejoin="round" d="M9 8v8l7-4-7-4z" /></svg>;
    case "specs": return <svg {...common}><path strokeLinecap="round" strokeLinejoin="round" d="M7 4h10v16l-5-3-5 3V4z" /></svg>;
    case "tests": return <svg {...common}><path strokeLinecap="round" strokeLinejoin="round" d="M8 4h8M9 4v4l-4 7a4 4 0 0 0 3.5 6h7a4 4 0 0 0 3.5-6l-4-7V4" /></svg>;
    case "analytics": return <svg {...common}><path strokeLinecap="round" strokeLinejoin="round" d="M4 20V10M10 20V4M16 20v-8M22 20v-4" /></svg>;
    case "settings": return <svg {...common}><circle cx="12" cy="12" r="3" /><path strokeLinecap="round" strokeLinejoin="round" d="M19.4 15a1 1 0 0 0 .2 1.1l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1 1 0 0 0-1.1-.2 1 1 0 0 0-.6.9V20a2 2 0 1 1-4 0v-.1a1 1 0 0 0-.7-.9 1 1 0 0 0-1.1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1 1 0 0 0 .2-1.1 1 1 0 0 0-.9-.6H4a2 2 0 1 1 0-4h.1a1 1 0 0 0 .9-.7 1 1 0 0 0-.2-1.1l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1 1 0 0 0 1.1.2h.1a1 1 0 0 0 .6-.9V4a2 2 0 1 1 4 0v.1a1 1 0 0 0 .6.9h.1a1 1 0 0 0 1.1-.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1 1 0 0 0-.2 1.1v.1a1 1 0 0 0 .9.6H20a2 2 0 1 1 0 4h-.1a1 1 0 0 0-.9.6z" /></svg>;
    case "users": return <svg {...common}><path strokeLinecap="round" strokeLinejoin="round" d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path strokeLinecap="round" strokeLinejoin="round" d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></svg>;
    case "plug": return <svg {...common}><path strokeLinecap="round" strokeLinejoin="round" d="M9 3v6M15 3v6M7 9h10v2a5 5 0 0 1-5 5v5" /></svg>;
    case "logout": return <svg {...common}><path strokeLinecap="round" strokeLinejoin="round" d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" /></svg>;
    case "chevronLeft": return <svg {...common}><path strokeLinecap="round" strokeLinejoin="round" d="M15 18l-6-6 6-6" /></svg>;
    case "chevronRight": return <svg {...common}><path strokeLinecap="round" strokeLinejoin="round" d="M9 18l6-6-6-6" /></svg>;
    case "key": return <svg {...common}><path strokeLinecap="round" strokeLinejoin="round" d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.78 7.78 5.5 5.5 0 0 1 7.78-7.78zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" /></svg>;
    case "bell": return <svg {...common}><path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 0 0 5.454-1.31A8.967 8.967 0 0 1 18 9.75V9A6 6 0 0 0 6 9v.75a8.967 8.967 0 0 1-2.312 6.022c1.733.64 3.558 1.081 5.454 1.31m5.715 0a24.255 24.255 0 0 1-5.714 0m5.714 0a3 3 0 1 1-5.714 0" /></svg>;
    case "billing": return <svg {...common}><rect x="3" y="6" width="18" height="13" rx="2" /><path strokeLinecap="round" d="M3 10h18M7 15h3" /></svg>;
    case "live": return <svg {...common}><circle cx="12" cy="12" r="3" /><path strokeLinecap="round" d="M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8M8.4 8.4a5 5 0 0 0 0 7.2M15.6 8.4a5 5 0 0 1 0 7.2" /></svg>;
    case "calendar": return <svg {...common}><rect x="3" y="4" width="18" height="18" rx="2" /><path strokeLinecap="round" d="M16 2v4M8 2v4M3 10h18" /><path strokeLinecap="round" d="M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01" /></svg>;
    default: return null;
  }
}

function NavLink({
  href,
  label,
  icon,
  collapsed = false,
  active = false,
}: {
  href: string;
  label: string;
  icon: MenuIconName;
  collapsed?: boolean;
  active?: boolean;
}) {
  return (
    <Link
      href={href}
      title={collapsed ? label : undefined}
      aria-label={label}
      className={`group relative flex items-center overflow-hidden rounded-xl py-2 text-[13px] font-medium transition-all duration-150 ${
        collapsed ? "justify-center px-2" : "gap-2.5 pl-4 pr-3.5"
      } ${
        active
          ? "bg-[var(--sidebar-active-bg)] text-[var(--sidebar-text-active)] shadow-sm"
          : "text-[var(--sidebar-text)] hover:bg-[var(--sidebar-hover)] hover:text-[var(--sidebar-text-active)]"
      }`}
    >
      {active && (
        <span
          className="absolute inset-y-1.5 left-0 w-[3px] rounded-r-full bg-[var(--sidebar-accent)]"
          aria-hidden
        />
      )}
      <MenuIcon
        name={icon}
        className={`h-[18px] w-[18px] shrink-0 transition-colors ${
          active ? "text-[var(--sidebar-accent)]" : ""
        }`}
      />
      {!collapsed && <span className="truncate">{label}</span>}
    </Link>
  );
}

function SidebarInner() {
  const pathname = usePathname();
  const router = useRouter();
  const [collapsed, setCollapsed] = useState(false);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [currentProject, setCurrentProject] = useState<ProjectDetail | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);

  const projectMatch = useMemo(() => {
    const m = pathname.match(/^\/projects\/([^/]+)/);
    return m ? m[1] : null;
  }, [pathname]);

  const navScope: NavScope = projectMatch ? "project" : "workspace";

  useEffect(() => {
    listProjects().then(setProjects).catch(() => {});
    authMe().then((me) => {
      if (me && "isPlatformAdmin" in me) setIsAdmin(Boolean(me.isPlatformAdmin));
    });
  }, []);

  useEffect(() => {
    if (projectMatch) {
      getProject(projectMatch).then(setCurrentProject).catch(() => setCurrentProject(null));
    } else {
      setCurrentProject(null);
    }
  }, [projectMatch]);

  async function handleLogout() {
    await logout();
    router.push("/login");
    router.refresh();
  }

  return (
    <aside
      className={`group/sidebar glass-pane flex flex-col transition-[width] duration-200 ${
        collapsed ? "w-[60px]" : "w-[260px]"
      }`}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[var(--glass-border-soft)] px-3 py-3">
        {!collapsed ? (
          <Link href="/projects" className="flex items-center gap-2 truncate">
            <BrandLogo width={140} height={32} className="h-7 w-auto" />
          </Link>
        ) : (
          <Link href="/projects" className="flex items-center justify-center">
            <BrandLogo variant="mark" width={28} height={28} className="h-7 w-7" />
          </Link>
        )}
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="rounded-xl p-1.5 text-[var(--sidebar-text)] hover:bg-[var(--sidebar-hover)] hover:text-[var(--sidebar-text-active)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_oklab,var(--brand-primary)_30%,transparent)]"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          <MenuIcon name={collapsed ? "chevronRight" : "chevronLeft"} />
        </button>
      </div>

      {/* Back to workspace when in project scope */}
      {navScope === "project" && (
        <div className="border-b border-[var(--glass-border-soft)] px-3 py-2">
          <button
            onClick={() => router.push("/projects")}
            className="flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-xs text-[var(--sidebar-text)] hover:bg-[var(--sidebar-hover)] hover:text-[var(--sidebar-text-active)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_oklab,var(--brand-primary)_30%,transparent)]"
          >
            <MenuIcon name="chevronLeft" className="h-3.5 w-3.5" />
            {!collapsed && (
              <span className="truncate">
                {currentProject
                  ? `${currentProject.key || ""} — ${currentProject.name || ""}`
                  : "All Projects"}
              </span>
            )}
          </button>
        </div>
      )}

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-2 py-3">
        {navScope === "workspace" ? (
          <div className="space-y-0.5">
            {workspaceNavItems.map((item) => (
              <NavLink
                key={item.href}
                href={item.href}
                label={item.label}
                icon={item.icon}
                collapsed={collapsed}
                active={pathname === item.href || pathname.startsWith(item.href + "/")}
              />
            ))}
          </div>
        ) : (
          projectNavSections.map((section) => {
            const projectFramework =
              (currentProject?.settings as { framework?: string } | null | undefined)
                ?.framework || null;
            const items = section.items.filter((item) => {
              if (!item.seleniumOnly) return true;
              return projectFramework === "selenium";
            });
            if (items.length === 0) return null;
            return (
            <div key={section.section} className="mb-4">
              {!collapsed && (
                <p className="mb-1.5 px-4 text-[11px] font-semibold uppercase tracking-wider text-[var(--sidebar-section-label)]">
                  {section.section}
                </p>
              )}
              <div className="space-y-0.5">
                {items.map((item) => {
                  const fullHref = `/projects/${projectMatch}/${item.href}`;
                  const isActive =
                    pathname === fullHref ||
                    pathname.startsWith(fullHref + "/") ||
                    (item.href === "dashboard" && pathname === `/projects/${projectMatch}`);
                  return (
                    <NavLink
                      key={item.href}
                      href={fullHref}
                      label={item.label}
                      icon={item.icon}
                      collapsed={collapsed}
                      active={isActive}
                    />
                  );
                })}
              </div>
            </div>
            );
          })
        )}
      </nav>

      {/* Footer */}
      <div className="border-t border-[var(--glass-border-soft)] px-3 py-3 space-y-1">
        <ThemeToggle collapsed={collapsed} />
        <button
          onClick={handleLogout}
          className={`flex w-full items-center rounded-xl py-2 text-[13px] font-medium text-[var(--sidebar-text)] transition-colors hover:bg-[var(--sidebar-hover)] hover:text-[var(--sidebar-text-active)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_oklab,var(--brand-primary)_30%,transparent)] ${
            collapsed ? "justify-center px-2" : "gap-2.5 pl-4 pr-3.5"
          }`}
        >
          <MenuIcon name="logout" className="h-[18px] w-[18px]" />
          {!collapsed && <span>Log out</span>}
        </button>
      </div>
    </aside>
  );
}

export default function Sidebar() {
  return <SidebarInner />;
}
