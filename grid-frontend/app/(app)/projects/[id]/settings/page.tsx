"use client";

import { useEffect, useState, use } from "react";
import Link from "next/link";
import {
  createProjectInvitation,
  deleteProject,
  getProject,
  listProjectInvitations,
  listProjectMembers,
  type ProjectDetail,
  type ProjectInvitation,
  removeProjectMember,
  revokeProjectInvitation,
  updateProject,
} from "@/lib/api";
import { useRouter } from "next/navigation";
import {
  Banner,
  Button,
  Card,
  CardBody,
  Field,
  FieldError,
  FieldHint,
  FieldLabel,
  Input,
  Modal,
  Select,
  StatusChip,
  Textarea,
} from "@/components/ui";
import GithubSection from "./GithubSection";
import EnvironmentsSection from "./EnvironmentsSection";

export default function ProjectSettingsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [members, setMembers] = useState<
    { userId: string; email: string; name: string; role: string; joinedAt: string }[]
  >([]);
  const [invitations, setInvitations] = useState<ProjectInvitation[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [memberActionError, setMemberActionError] = useState("");
  const [memberActionSuccess, setMemberActionSuccess] = useState("");
  const [loading, setLoading] = useState(true);
  const [showInvite, setShowInvite] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("member");
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState("");

  useEffect(() => {
    loadData();
  }, [id]);

  async function loadData() {
    setLoading(true);
    try {
      const [proj, mems, invites] = await Promise.all([
        getProject(id),
        listProjectMembers(id),
        listProjectInvitations(id),
      ]);
      setProject(proj);
      setName(proj.name || "");
      setDescription(proj.description || "");
      setMembers(mems);
      setInvitations(invites);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSaving(true);
    try {
      await updateProject(id, { name, description });
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!confirm("Delete this project? This cannot be undone.")) return;
    await deleteProject(id);
    router.push("/projects");
  }

  async function handleRemoveMember(userId: string) {
    if (!confirm("Remove this member?")) return;
    setMemberActionError("");
    setMemberActionSuccess("");
    try {
      await removeProjectMember(id, userId);
      setMemberActionSuccess("Member removed.");
      await loadData();
    } catch (err) {
      setMemberActionError(err instanceof Error ? err.message : "Failed to remove member");
    }
  }

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    setInviteError("");
    setMemberActionError("");
    setMemberActionSuccess("");
    if (!inviteEmail.trim()) {
      setInviteError("Email is required");
      return;
    }
    setInviting(true);
    try {
      const result = await createProjectInvitation(id, {
        email: inviteEmail.trim().toLowerCase(),
        role: inviteRole,
      });
      if (result.mode === "member_added") {
        setMemberActionSuccess("User already had an account and was added to the project.");
      } else {
        setMemberActionSuccess("Invitation created.");
      }
      setShowInvite(false);
      setInviteEmail("");
      setInviteRole("member");
      await loadData();
    } catch (err) {
      setInviteError(err instanceof Error ? err.message : "Failed to invite member");
    } finally {
      setInviting(false);
    }
  }

  async function handleRevokeInvitation(invitationId: string) {
    if (!confirm("Revoke this invitation?")) return;
    setMemberActionError("");
    setMemberActionSuccess("");
    try {
      await revokeProjectInvitation(id, invitationId);
      setMemberActionSuccess("Invitation revoked.");
      await loadData();
    } catch (err) {
      setMemberActionError(err instanceof Error ? err.message : "Failed to revoke invitation");
    }
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="h-16 animate-pulse rounded-xl bg-[var(--glass-bg-subtle)]" />
        <div className="h-48 animate-pulse rounded-xl bg-[var(--glass-bg-subtle)]" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-[var(--foreground)]">
          Project Settings
        </h1>
        <p className="text-sm text-[var(--muted)]">
          Manage settings for{" "}
          <span className="font-medium">{project?.name || ""}</span>
        </p>
      </div>

      {/* Prominent project key */}
      {project?.key && (
        <div className="tesbo-card flex items-center justify-between gap-4 p-5">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-[var(--muted-soft)]">Project Key</p>
            <p className="mt-1 text-xl font-bold font-mono text-[var(--foreground)]">{project.key}</p>
            <p className="mt-0.5 text-xs text-[var(--muted)]">Used in test runner config and CI pipelines</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <StatusChip tone="brand">{project.key}</StatusChip>
            <Button
              size="sm"
              variant="glass"
              onClick={() => {
                navigator.clipboard.writeText(project.key);
              }}
            >
              Copy
            </Button>
          </div>
        </div>
      )}

      <Card>
        <CardBody className="p-5">
          <h2 className="mb-4 text-base font-semibold text-[var(--foreground)]">
            General
          </h2>
          <form onSubmit={handleSave} className="space-y-4 max-w-lg">
            {error && <Banner tone="error" description={error} />}
            <Field>
              <FieldLabel htmlFor="name">Project name</FieldLabel>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={saving}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="desc">Description</FieldLabel>
              <Textarea
                id="desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                disabled={saving}
              />
              <FieldHint>Shown on the projects list and in the sidebar tooltip.</FieldHint>
            </Field>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save Changes"}
            </Button>
          </form>
        </CardBody>
      </Card>

      <TestStackCard project={project} />

      <ConcurrencyLimitsCard project={project} onSaved={loadData} />

      <EnvironmentsSection projectId={id} />

      <GithubSection projectId={id} />

      <Card>
        <CardBody className="p-6">
          <h2 className="text-lg font-semibold text-[var(--foreground)] mb-2">
            API Keys
          </h2>
          <p className="text-sm text-[var(--muted)] mb-4">
            Configure project access key and AI API key required for AI analysis summaries.
          </p>
          <div className="flex flex-wrap gap-2">
            <Link
              href={`/projects/${id}/integration`}
              className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--brand-border)] bg-[var(--brand-soft)] px-3.5 py-1.5 text-sm font-medium text-[var(--brand-primary)] hover:bg-[var(--brand-surface)] transition-colors"
            >
              Manage Project Keys
            </Link>
            <Link
              href="/settings/integrations"
              className="inline-flex items-center rounded-xl border border-[var(--glass-border)] bg-[var(--glass-bg-subtle)] px-3 py-1.5 text-sm font-medium text-[var(--foreground)] hover:bg-[var(--surface-secondary)] transition-colors"
            >
              Manage Workspace AI Keys
            </Link>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardBody className="p-0">
          <div className="px-6 pt-6 pb-4 flex items-start justify-between gap-3">
            <h2 className="text-lg font-semibold text-[var(--foreground)]">
              Members
            </h2>
            <Button size="sm" onClick={() => setShowInvite(true)}>
              Invite Member
            </Button>
          </div>
          {memberActionError && (
            <div className="px-6 pb-4">
              <FieldError>{memberActionError}</FieldError>
            </div>
          )}
          {memberActionSuccess && (
            <p className="px-6 pb-4 text-sm text-[var(--muted)]">{memberActionSuccess}</p>
          )}
          {members.length === 0 ? (
            <p className="px-6 pb-6 text-sm text-[var(--muted)]">No members.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="tesbo-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Email</th>
                    <th>Role</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {members.map((m) => (
                    <tr key={m.userId}>
                      <td className="font-medium">{m.name || "—"}</td>
                      <td className="text-sm text-[var(--muted)]">{m.email}</td>
                      <td>
                        <span className="inline-block rounded-full border border-[var(--border-subtle)] bg-[var(--surface-secondary)] px-2.5 py-0.5 text-xs font-medium">
                          {m.role}
                        </span>
                      </td>
                      <td className="text-right">
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => handleRemoveMember(m.userId)}
                        >
                          Remove
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="border-t border-[var(--border-subtle)] px-6 py-5">
            <h3 className="text-sm font-semibold text-[var(--foreground)] mb-3">
              Pending Invitations
            </h3>
            {invitations.length === 0 ? (
              <p className="text-sm text-[var(--muted)]">No pending invitations.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="tesbo-table min-w-[640px]">
                  <thead>
                    <tr>
                      <th>Email</th>
                      <th>Role</th>
                      <th>Invited</th>
                      <th>Expires</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {invitations.map((invite) => (
                      <tr key={invite.id}>
                        <td className="font-medium">{invite.email}</td>
                        <td>
                          <span className="inline-block rounded-full border border-[var(--border-subtle)] bg-[var(--surface-secondary)] px-2.5 py-0.5 text-xs font-medium">
                            {invite.role}
                          </span>
                        </td>
                        <td className="text-sm text-[var(--muted)]">
                          {new Date(invite.createdAt).toLocaleDateString()}
                        </td>
                        <td className="text-sm text-[var(--muted)]">
                          {new Date(invite.expiresAt).toLocaleDateString()}
                        </td>
                        <td className="text-right">
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => handleRevokeInvitation(invite.id)}
                          >
                            Revoke
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </CardBody>
      </Card>

      {showInvite && (
        <Modal open onClose={() => setShowInvite(false)} title="Invite Project Member">
          <form onSubmit={handleInvite} className="space-y-4">
            <Field>
              <FieldLabel htmlFor="inviteEmail">Email</FieldLabel>
              <Input
                id="inviteEmail"
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="teammate@company.com"
                disabled={inviting}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="inviteRole">Role</FieldLabel>
              <Select
                id="inviteRole"
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value)}
                disabled={inviting}
              >
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </Select>
            </Field>
            {inviteError && <FieldError>{inviteError}</FieldError>}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="secondary"
                onClick={() => setShowInvite(false)}
                disabled={inviting}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={inviting}>
                {inviting ? "Inviting…" : "Send Invite"}
              </Button>
            </div>
          </form>
        </Modal>
      )}

      <Card>
        <CardBody className="p-6">
          <h2 className="text-lg font-semibold text-[var(--error)] mb-2">
            Danger Zone
          </h2>
          <p className="text-sm text-[var(--muted)] mb-4">
            Permanently delete this project and all associated data.
          </p>
          <Button
            variant="secondary"
            onClick={handleDelete}
            className="!border-[var(--error-border)] !text-[var(--error)]"
          >
            Delete Project
          </Button>
        </CardBody>
      </Card>
    </div>
  );
}

function StackChip({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] uppercase tracking-wide text-[var(--muted)]">
        {label}
      </span>
      <span className="inline-flex w-fit items-center rounded-md border border-[var(--border)] bg-[var(--surface-secondary)] px-2.5 py-1 text-sm font-medium capitalize text-[var(--foreground)]">
        {value}
      </span>
    </div>
  );
}

// Per-project Selenium session concurrency cap. Mirrors the validation rules
// in grid-backend/src/routes/projects.js (validateMaxConcurrentSessions) —
// keep them in sync. The hard ceiling is high enough that the cluster's KEDA
// scaler is the real upper bound, not this UI.
const SESSION_CAP_CEILING = 1000;

function ConcurrencyLimitsCard({
  project,
  onSaved,
}: {
  project: ProjectDetail | null;
  onSaved: () => Promise<void> | void;
}) {
  const settings = (project?.settings ?? {}) as Record<string, unknown>;
  const initialCap = settings.maxConcurrentSessions;
  // Empty string in the input == "no per-project cap — cluster capacity is
  // the only ceiling". Any string the user types is validated on submit.
  const initialValue =
    typeof initialCap === "number" && initialCap >= 0 ? String(initialCap) : "";

  const [value, setValue] = useState(initialValue);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  // Reset local state whenever the project payload changes (e.g. after a
  // successful save reloads the page data).
  useEffect(() => {
    setValue(initialValue);
    setError("");
    setSuccess("");
  }, [initialValue, project?.id]);

  const canEdit = project?.role === "owner" || project?.role === "admin";

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!project) return;
    setError("");
    setSuccess("");

    const trimmed = value.trim();
    let parsed: number | null;
    if (trimmed === "") {
      parsed = null;
    } else {
      const n = Number(trimmed);
      if (!Number.isInteger(n) || n < 0) {
        setError("Enter a non-negative whole number, or leave blank for no cap.");
        return;
      }
      if (n > SESSION_CAP_CEILING) {
        setError(`Maximum allowed value is ${SESSION_CAP_CEILING}.`);
        return;
      }
      parsed = n;
    }

    setSaving(true);
    try {
      // The backend merges this into existing settings, so we only need to
      // send the field we're changing.
      await updateProject(project.id, {
        settings: { maxConcurrentSessions: parsed },
      });
      setSuccess(
        parsed === null || parsed === 0
          ? "Saved. No per-project session cap — only the cluster's node capacity applies."
          : `Saved. Up to ${parsed} concurrent Selenium sessions allowed.`
      );
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  const currentDescription = (() => {
    if (typeof initialCap !== "number" || initialCap === 0)
      return "No per-project cap — only the cluster's node capacity applies.";
    return `Capped at ${initialCap} concurrent sessions.`;
  })();

  return (
    <Card>
      <CardBody className="p-6">
        <h2 className="text-lg font-semibold text-[var(--foreground)]">
          Concurrency Limits
        </h2>
        <p className="mt-0.5 text-sm text-[var(--muted)]">
          Maximum number of live Selenium WebDriver sessions this project can
          hold open at once. Requests over this limit are rejected with HTTP
          429 by the grid proxy. {currentDescription}
        </p>
        <form onSubmit={handleSave} className="mt-4 space-y-4 max-w-lg">
          <Field>
            <FieldLabel htmlFor="maxConcurrentSessions">
              Max concurrent Selenium sessions
            </FieldLabel>
            <Input
              id="maxConcurrentSessions"
              type="number"
              inputMode="numeric"
              min={0}
              max={SESSION_CAP_CEILING}
              step={1}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="Leave blank for no cap"
              disabled={!canEdit || saving}
            />
            <p className="mt-1 text-xs text-[var(--muted)]">
              Blank or 0 = no cap (cluster node capacity still applies) ·
              max {SESSION_CAP_CEILING}
            </p>
          </Field>
          {error && <FieldError>{error}</FieldError>}
          {success && (
            <p className="text-sm text-[var(--muted)]">{success}</p>
          )}
          <Button type="submit" disabled={!canEdit || saving}>
            {saving ? "Saving…" : "Save Limit"}
          </Button>
          {!canEdit && (
            <p className="text-xs text-[var(--muted)]">
              Only project admins or owners can change this setting.
            </p>
          )}
        </form>
      </CardBody>
    </Card>
  );
}

function TestStackCard({ project }: { project: ProjectDetail | null }) {
  const settings = (project?.settings as
    | { framework?: string; language?: string; defaultBrowser?: string }
    | null
    | undefined) || {};
  const framework = settings.framework || "—";
  const language = settings.language || "—";
  const defaultBrowser = settings.defaultBrowser || "—";
  const isMissing = !settings.framework || !settings.language || !settings.defaultBrowser;

  return (
    <Card>
      <CardBody className="p-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-[var(--foreground)]">
              Test stack
            </h2>
            <p className="mt-0.5 text-sm text-[var(--muted)]">
              {isMissing
                ? "This project was created before stack selection was required. Visit the Integration page to lock it in."
                : "Set when this project was created. To use a different framework or language, create a new project."}
            </p>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-4">
          <StackChip label="Framework" value={framework} />
          <StackChip label="Language" value={language} />
          <StackChip label="Default browser" value={defaultBrowser} />
        </div>
      </CardBody>
    </Card>
  );
}
