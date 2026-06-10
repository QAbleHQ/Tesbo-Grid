"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Banner,
  Button,
  Card,
  CardBody,
  Field,
  FieldHint,
  FieldLabel,
  Input,
  Select,
  StatusChip,
} from "@/components/ui";
import {
  createGithubIntegration,
  deleteGithubIntegration,
  findGithubInstallationByOwner,
  getGithubAppInstallUrl,
  getGithubIntegration,
  getGithubStatus,
  listGithubInstallationRepos,
  type GithubIntegration,
  type GithubRepo,
} from "@/lib/api";

export default function GithubSection({ projectId }: { projectId: string }) {
  const [status, setStatus] = useState<{ configured: boolean; appName: string | null } | null>(null);
  const [integration, setIntegration] = useState<GithubIntegration | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // State-based pendingInstallationId so React properly tracks changes
  const [pendingInstallationId, setPendingInstallationId] = useState<string | null>(() => {
    if (typeof window !== "undefined") {
      return sessionStorage.getItem(`tesbo-github-install-${projectId}`);
    }
    return null;
  });

  const storePending = useCallback(
    (id: string) => {
      try {
        sessionStorage.setItem(`tesbo-github-install-${projectId}`, id);
      } catch {}
      setPendingInstallationId(id);
    },
    [projectId]
  );

  const clearPending = useCallback(() => {
    try {
      sessionStorage.removeItem(`tesbo-github-install-${projectId}`);
    } catch {}
    setPendingInstallationId(null);
  }, [projectId]);

  const reload = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [s, i] = await Promise.all([getGithubStatus(), getGithubIntegration(projectId)]);
      setStatus(s);
      setIntegration(i);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load GitHub state");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Read installation ID from OAuth callback URL and store it in state
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const installId = url.searchParams.get("github_installation_id");
    if (!installId) return;
    url.searchParams.delete("github_installation_id");
    url.searchParams.delete("github_connected");
    window.history.replaceState({}, "", url.toString());
    storePending(installId);
  }, [projectId, storePending]);

  if (loading) {
    return (
      <Card>
        <CardBody className="p-6">
          <div className="h-5 w-32 animate-pulse rounded bg-[var(--glass-bg-subtle)]" />
        </CardBody>
      </Card>
    );
  }

  if (status && !status.configured) {
    return (
      <Card>
        <CardBody className="p-6">
          <h2 className="text-lg font-semibold text-[var(--foreground)] mb-1">GitHub</h2>
          <p className="text-sm text-[var(--muted)]">
            GitHub App is not configured on this deployment yet. Ask your administrator to register
            the Tesbo Grid GitHub App and set the env vars described in the README.
          </p>
        </CardBody>
      </Card>
    );
  }

  return (
    <Card>
      <CardBody className="p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-[var(--foreground)]">GitHub</h2>
            <p className="text-sm text-[var(--muted)]">
              Trigger runs from a cron schedule or on every pull request.
            </p>
          </div>
          {integration ? (
            <StatusChip tone="success">Connected</StatusChip>
          ) : null}
        </div>

        {error && <Banner tone="error" description={error} className="mt-4" />}

        {!integration ? (
          <NotConnectedView
            projectId={projectId}
            pendingInstallationId={pendingInstallationId}
            onSetPendingInstallation={storePending}
            onConnected={() => {
              clearPending();
              void reload();
            }}
          />
        ) : (
          <ConnectedView
            projectId={projectId}
            integration={integration}
            onChange={reload}
            onDisconnected={(installationId) => {
              // Optimistically clear integration and pre-load repo picker
              setIntegration(null);
              if (installationId) {
                storePending(installationId);
              }
            }}
          />
        )}
      </CardBody>
    </Card>
  );
}

function NotConnectedView({
  projectId,
  pendingInstallationId,
  onSetPendingInstallation,
  onConnected,
}: {
  projectId: string;
  pendingInstallationId: string | null;
  onSetPendingInstallation: (id: string) => void;
  onConnected: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [repos, setRepos] = useState<GithubRepo[] | null>(null);
  const [reposLoading, setReposLoading] = useState(false);
  const [devRepoFullName, setDevRepoFullName] = useState("");
  const [testRepoFullName, setTestRepoFullName] = useState("");
  const [ownerLookup, setOwnerLookup] = useState("");
  const [lookingUp, setLookingUp] = useState(false);

  async function handleStart() {
    setError("");
    setBusy(true);
    try {
      const { url } = await getGithubAppInstallUrl(projectId);
      if (!url) throw new Error("Install URL not available");
      window.location.href = url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start GitHub install");
      setBusy(false);
    }
  }

  async function handleUseExisting(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const owner = ownerLookup.trim();
    if (!owner) {
      setError("Enter your GitHub organization or username");
      return;
    }
    setLookingUp(true);
    try {
      const { installation } = await findGithubInstallationByOwner(owner);
      if (!installation) {
        setError(`Tesbo GitHub App is not installed on "${owner}". Click Connect GitHub to install it.`);
        return;
      }
      // Update state in parent — this triggers repo fetch without remounting this component
      onSetPendingInstallation(installation.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Lookup failed");
    } finally {
      setLookingUp(false);
    }
  }

  // Fetch repos whenever pendingInstallationId changes; remove `repos` from deps
  // to avoid returning early when re-loading for a different installation
  useEffect(() => {
    if (!pendingInstallationId) {
      setRepos(null);
      setReposLoading(false);
      return;
    }
    let cancelled = false;
    setRepos(null);
    setReposLoading(true);
    setError("");
    setDevRepoFullName("");
    setTestRepoFullName("");
    (async () => {
      try {
        const res = await listGithubInstallationRepos(pendingInstallationId);
        if (!cancelled) setRepos(res.repos);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to list repos");
      } finally {
        if (!cancelled) setReposLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pendingInstallationId]);

  async function handleConnect(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!pendingInstallationId) {
      setError("No GitHub installation found. Try installing the app again.");
      return;
    }
    const test = repos?.find((r) => r.fullName === testRepoFullName);
    if (!test) {
      setError("Select a test code repo to continue");
      return;
    }
    const dev = devRepoFullName ? repos?.find((r) => r.fullName === devRepoFullName) : null;
    setBusy(true);
    try {
      await createGithubIntegration({
        projectId,
        installationId: pendingInstallationId,
        devRepo: dev ? { id: dev.id, fullName: dev.fullName, defaultBranch: dev.defaultBranch } : null,
        testRepo: { id: test.id, fullName: test.fullName, defaultBranch: test.defaultBranch },
      });
      onConnected();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save integration");
    } finally {
      setBusy(false);
    }
  }

  // Repos loading state
  if (pendingInstallationId && reposLoading) {
    return (
      <div className="mt-4 space-y-2">
        {error && <Banner tone="error" description={error} />}
        <div className="h-4 w-48 animate-pulse rounded bg-[var(--glass-bg-subtle)]" />
        <p className="text-sm text-[var(--muted)]">Loading repositories…</p>
      </div>
    );
  }

  // Repo selector form (shown after repos are loaded)
  if (pendingInstallationId && repos) {
    return (
      <form className="mt-4 space-y-4" onSubmit={handleConnect}>
        {error && <Banner tone="error" description={error} />}
        <p className="text-sm text-[var(--muted)]">
          App installed. Select which repos this project should use. They can be the same repository
          (when test code lives alongside the application code) or two separate repos.
        </p>
        <Field>
          <FieldLabel htmlFor="ghDevRepo">
            Development code repo{" "}
            <span className="text-[var(--muted)] font-normal">(optional)</span>
          </FieldLabel>
          <Select
            id="ghDevRepo"
            value={devRepoFullName}
            onChange={(e) => setDevRepoFullName(e.target.value)}
            disabled={busy}
          >
            <option value="">— I don&apos;t have access to the dev repo</option>
            {repos.map((r) => (
              <option key={String(r.id)} value={r.fullName}>{r.fullName}</option>
            ))}
          </Select>
          <FieldHint>
            {devRepoFullName
              ? "PR webhooks fire from this repo."
              : "Without a dev repo, PR triggers and dynamic test selection will not be available."}
          </FieldHint>
        </Field>
        <Field>
          <FieldLabel htmlFor="ghTestRepo">Test code repo</FieldLabel>
          <Select
            id="ghTestRepo"
            value={testRepoFullName}
            onChange={(e) => setTestRepoFullName(e.target.value)}
            disabled={busy}
          >
            <option value="">Select a repo…</option>
            {repos.map((r) => (
              <option key={String(r.id)} value={r.fullName}>{r.fullName}</option>
            ))}
          </Select>
          <FieldHint>Tesbo will scan this repo to discover available test suites.</FieldHint>
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="submit" disabled={busy}>{busy ? "Saving…" : "Save integration"}</Button>
        </div>
      </form>
    );
  }

  return (
    <div className="mt-4 space-y-4">
      {error && <Banner tone="error" description={error} />}
      <p className="text-sm text-[var(--muted)]">
        Install the Tesbo Grid GitHub App on your organization, then choose which repos this project
        should use for development and test code.
      </p>
      <Button onClick={handleStart} disabled={busy}>{busy ? "Redirecting…" : "Connect GitHub"}</Button>

      <div className="border-t border-[var(--border-subtle)] pt-4">
        <p className="text-sm text-[var(--muted)] mb-2">
          Already installed the Tesbo GitHub App on your organization? Enter the GitHub
          organization or username to continue without re-installing.
        </p>
        <form onSubmit={handleUseExisting} className="flex flex-wrap items-end gap-2">
          <Field className="flex-1 min-w-[220px]">
            <FieldLabel htmlFor="ghOwner">GitHub organization or username</FieldLabel>
            <Input
              id="ghOwner"
              value={ownerLookup}
              onChange={(e) => setOwnerLookup(e.target.value)}
              placeholder="my-org"
              disabled={lookingUp}
            />
          </Field>
          <Button type="submit" variant="secondary" disabled={lookingUp}>
            {lookingUp ? "Looking up…" : "Use existing installation"}
          </Button>
        </form>
      </div>
    </div>
  );
}

function ConnectedView({
  projectId,
  integration,
  onChange,
  onDisconnected,
}: {
  projectId: string;
  integration: GithubIntegration;
  onChange: () => void;
  onDisconnected: (installationId: string) => void;
}) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState("");

  async function handleRemove() {
    setRemoving(true);
    try {
      await deleteGithubIntegration(projectId);
      onDisconnected(integration.installationId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove integration");
      setConfirmRemove(false);
    } finally {
      setRemoving(false);
    }
  }

  return (
    <div className="mt-4 space-y-4">
      {error && <Banner tone="error" description={error} />}
      <div className="grid gap-3 sm:grid-cols-2">
        <ReadOnlyField label="Organization / account" value={integration.accountLogin} />
        <ReadOnlyField label="Installation ID" value={integration.installationId} />
        <ReadOnlyField
          label="Development repo"
          value={integration.devRepo?.fullName ?? "Not configured"}
        />
        <ReadOnlyField label="Test repo" value={integration.testRepo.fullName} />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border-subtle)] pt-4">
        <p className="text-sm text-[var(--muted)]">
          {integration.schedules.length === 0
            ? "No scheduled runs yet."
            : `${integration.schedules.length} schedule${integration.schedules.length !== 1 ? "s" : ""} configured.`}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {confirmRemove ? (
            <>
              <p className="text-sm text-[var(--muted)]">
                Remove integration? All schedules will be deleted.
              </p>
              <Button
                variant="destructive"
                size="sm"
                onClick={handleRemove}
                disabled={removing}
              >
                {removing ? "Removing…" : "Yes, remove"}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setConfirmRemove(false)}
                disabled={removing}
              >
                Cancel
              </Button>
            </>
          ) : (
            <>
              <Button variant="secondary" onClick={() => setConfirmRemove(true)}>
                Remove integration
              </Button>
              <Link href={`/projects/${projectId}/scheduled-runs`}>
                <Button>Manage scheduled runs →</Button>
              </Link>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ReadOnlyField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-[var(--muted)]">{label}</div>
      <div className="mt-0.5 text-sm font-medium text-[var(--foreground)]">{value}</div>
    </div>
  );
}
