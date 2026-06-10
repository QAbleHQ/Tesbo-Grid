import Link from "next/link";

const settingsNav = [
  {
    href: "/settings/members",
    title: "Members",
    description: "Manage team access, roles, and invite new members to your workspace.",
    icon: (
      <svg className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
      </svg>
    ),
  },
  {
    href: "/settings/integrations",
    title: "API Keys",
    description: "Add and manage AI provider keys (OpenAI, Anthropic) for AI-powered features.",
    icon: (
      <svg className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.78 7.78 5.5 5.5 0 0 1 7.78-7.78zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
      </svg>
    ),
  },
];

export default function SettingsHubPage() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-[var(--foreground)]">Settings</h1>
        <p className="text-sm text-[var(--muted)]">
          Manage your workspace configuration, members, and API keys.
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {settingsNav.map((item) => (
          <Link key={item.href} href={item.href} className="block">
            <div className="tesbo-card flex h-full flex-col gap-3 p-5 transition-all hover:border-[var(--brand-border)] hover:shadow-[var(--shadow-elevated)]">
              <div className="w-fit rounded-xl bg-[var(--brand-soft)] p-2.5 text-[var(--brand-primary)]">
                {item.icon}
              </div>
              <div>
                <p className="text-sm font-semibold text-[var(--foreground)]">{item.title}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-[var(--muted)]">
                  {item.description}
                </p>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
