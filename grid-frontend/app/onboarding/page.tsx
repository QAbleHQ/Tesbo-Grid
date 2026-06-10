"use client";

import { Suspense, useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  addWorkspaceMember,
  authMe,
  createWorkspace,
  getWorkspace,
  seedDemoProject,
} from "@/lib/api";
import {
  Banner,
  Button,
  Field,
  FieldError,
  FieldHint,
  FieldLabel,
  Input,
  Textarea,
} from "@/components/ui";

type Step = "workspace" | "team" | "demo-choice";

function OnboardingPageContent() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [step, setStep] = useState<Step>("workspace");
  const [orgName, setOrgName] = useState("");
  const [teamEmails, setTeamEmails] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    async function guard() {
      const me = await authMe();
      if (!me) {
        router.replace("/login");
        return;
      }
      const workspace = await getWorkspace();
      if (workspace) {
        router.replace("/projects");
        return;
      }
      setChecking(false);
    }
    guard();
  }, [router]);

  async function handleCreateWorkspace(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!orgName.trim()) {
      setError("Workspace name is required");
      return;
    }
    setLoading(true);
    try {
      await createWorkspace({ orgName: orgName.trim() });
      setStep("team");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to create workspace"
      );
    } finally {
      setLoading(false);
    }
  }

  async function handleTeamStep(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const emails = Array.from(
        new Set(
          teamEmails
            .split(/[\n,;]+/)
            .map((v) => v.trim().toLowerCase())
            .filter(Boolean)
        )
      );
      for (const email of emails) {
        await addWorkspaceMember({ email, role: "member" });
      }
      setStep("demo-choice");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to add team members"
      );
    } finally {
      setLoading(false);
    }
  }

  function skipTeamStep() {
    setStep("demo-choice");
  }

  async function handleLoadDemo() {
    setError("");
    setLoading(true);
    try {
      const { projectId } = await seedDemoProject();
      router.push(`/projects/${projectId}/dashboard`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create demo project");
      setLoading(false);
    }
  }

  function handleStartFresh() {
    router.push("/projects?create=1&fromOnboarding=1");
    router.refresh();
  }

  if (checking) {
    return (
      <div className="relative min-h-screen overflow-hidden">
        <div className="tesbo-aurora" />
        <div className="relative z-10 flex min-h-screen items-center justify-center px-4">
          <div className="glass-subtle flex items-center gap-3 rounded-2xl px-6 py-4">
            <div className="h-5 w-5 rounded-full border-2 border-[var(--glass-border)] border-t-[var(--brand-primary)] animate-spin" />
            <p className="text-sm text-[var(--muted)]">Setting up your workspace…</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative min-h-screen overflow-hidden">
      <div className="tesbo-aurora" />
      <div className="relative z-10 flex min-h-screen items-center justify-center px-4">
        <div className="w-full max-w-lg space-y-6">
          <div className="text-center">
            {step === "demo-choice" ? (
              <>
                <h1 className="text-2xl font-semibold text-[var(--foreground)]">
                  How would you like to get started?
                </h1>
                <p className="mt-1 text-sm text-[var(--muted)]">
                  Step 3 of 3: explore with sample data or jump straight into your own project.
                </p>
              </>
            ) : (
              <>
                <h1 className="text-2xl font-semibold text-[var(--foreground)]">
                  {step === "workspace"
                    ? "Create your workspace"
                    : "Invite your team (optional)"}
                </h1>
                <p className="mt-1 text-sm text-[var(--muted)]">
                  {step === "workspace"
                    ? "Step 1 of 3: set up your organization. You will be the workspace owner."
                    : "Step 2 of 3: add team members now, or skip and do this later from workspace settings."}
                </p>
              </>
            )}
          </div>

          <div className="glass-strong p-6 rounded-2xl">
            {step === "workspace" && (
              <form onSubmit={handleCreateWorkspace} className="space-y-4">
                {error && <Banner tone="error" description={error} />}
                <Field>
                  <FieldLabel htmlFor="orgName">
                    Organization / workspace name
                  </FieldLabel>
                  <Input
                    id="orgName"
                    type="text"
                    value={orgName}
                    onChange={(e) => setOrgName(e.target.value)}
                    placeholder="My Team"
                    disabled={loading}
                  />
                  <FieldHint>This becomes your workspace slug — you can change it later in settings.</FieldHint>
                </Field>
                <Button type="submit" disabled={loading} fullWidth>
                  {loading ? "Creating…" : "Continue"}
                </Button>
              </form>
            )}

            {step === "team" && (
              <form onSubmit={handleTeamStep} className="space-y-4">
                {error && <Banner tone="error" description={error} />}
                <Field>
                  <FieldLabel htmlFor="teamEmails">Team member emails</FieldLabel>
                  <Textarea
                    id="teamEmails"
                    value={teamEmails}
                    onChange={(e) => setTeamEmails(e.target.value)}
                    rows={5}
                    placeholder={"alice@company.com\nbob@company.com"}
                    disabled={loading}
                  />
                  <FieldHint>One email per line (or comma-separated). All invited members join as <strong>members</strong> — you can change roles in workspace settings.</FieldHint>
                </Field>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={skipTeamStep}
                    disabled={loading}
                    className="flex-1"
                  >
                    Skip — invite later
                  </Button>
                  <Button type="submit" disabled={loading} className="flex-1">
                    {loading ? "Adding…" : "Continue"}
                  </Button>
                </div>
              </form>
            )}

            {step === "demo-choice" && (
              <div className="space-y-4">
                {error && <Banner tone="error" description={error} />}

                {/* Demo data option */}
                <button
                  type="button"
                  onClick={handleLoadDemo}
                  disabled={loading}
                  className="w-full rounded-xl border border-[var(--brand-border)] bg-[var(--brand-soft)] backdrop-blur-sm p-5 text-left transition-all hover:border-[var(--brand-primary)] hover:bg-[var(--brand-surface)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_oklab,var(--brand-primary)_30%,transparent)] disabled:opacity-50 shadow-[inset_0_1px_0_var(--glass-highlight)]"
                >
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-[var(--brand-primary)] text-[var(--surface)]">
                      <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 0 1-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 0 1 4.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0 1 12 15a9.065 9.065 0 0 0-6.23-.693L5 14.5m14.8.8 1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0 1 12 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5" />
                      </svg>
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-[var(--foreground)]">
                        Explore with demo data
                        {loading && <span className="ml-2 text-sm font-normal text-[var(--muted)]">Setting up…</span>}
                      </p>
                      <p className="mt-0.5 text-sm text-[var(--muted)]">
                        Pre-loaded with realistic test runs, analytics, and alerts. You can delete the demo project at any time.
                      </p>
                    </div>
                  </div>
                </button>

                {/* Fresh start option */}
                <button
                  type="button"
                  onClick={handleStartFresh}
                  disabled={loading}
                  className="w-full rounded-xl border border-[var(--glass-border-soft)] bg-[var(--glass-bg-subtle)] backdrop-blur-sm p-5 text-left transition-all hover:border-[var(--glass-border)] hover:bg-[var(--glass-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_oklab,var(--brand-primary)_30%,transparent)] disabled:opacity-50 shadow-[inset_0_1px_0_var(--glass-highlight)]"
                >
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-[var(--glass-bg)] border border-[var(--glass-border-soft)] text-[var(--muted)]">
                      <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                      </svg>
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-[var(--foreground)]">Start from scratch</p>
                      <p className="mt-0.5 text-sm text-[var(--muted)]">
                        Create a blank project and connect your own test suite. Best if you&apos;re ready to integrate immediately.
                      </p>
                    </div>
                  </div>
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const OnboardingFallback = () => (
  <div className="relative min-h-screen overflow-hidden">
    <div className="tesbo-aurora" />
    <div className="relative z-10 flex min-h-screen items-center justify-center px-4">
      <div className="glass-subtle flex items-center gap-3 rounded-2xl px-6 py-4">
        <div className="h-5 w-5 rounded-full border-2 border-[var(--glass-border)] border-t-[var(--brand-primary)] animate-spin" />
        <p className="text-sm text-[var(--muted)]">Loading…</p>
      </div>
    </div>
  </div>
);

export default function OnboardingPage() {
  return (
    <Suspense fallback={<OnboardingFallback />}>
      <OnboardingPageContent />
    </Suspense>
  );
}
