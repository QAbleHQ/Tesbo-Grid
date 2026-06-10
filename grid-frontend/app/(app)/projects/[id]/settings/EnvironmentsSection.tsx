"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Banner,
  Button,
  Card,
  CardBody,
  EmptyStateBlock,
  Field,
  FieldHint,
  FieldLabel,
  Input,
  StatusChip,
} from "@/components/ui";
import {
  createProjectEnvironment,
  deleteProjectEnvironment,
  listProjectEnvironments,
  type ProjectEnvironment,
  type ProjectEnvironmentVariable,
  updateProjectEnvironment,
} from "@/lib/api";

const VAR_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

type DraftVariable = ProjectEnvironmentVariable & { _tmpId: string };

function makeTmpId() {
  return `tmp_${Math.random().toString(36).slice(2)}`;
}

function freshVariables(): DraftVariable[] {
  return [];
}

function toDraft(vars: ProjectEnvironmentVariable[]): DraftVariable[] {
  return vars.map((v) => ({ ...v, _tmpId: makeTmpId() }));
}

export default function EnvironmentsSection({ projectId }: { projectId: string }) {
  const [environments, setEnvironments] = useState<ProjectEnvironment[] | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [editingId, setEditingId] = useState<string | "new" | null>(null);

  const reload = useCallback(async () => {
    setLoadError("");
    try {
      const r = await listProjectEnvironments(projectId);
      setEnvironments(r.environments);
      setCanManage(r.canManage);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load environments");
    }
  }, [projectId]);

  useEffect(() => { void reload(); }, [reload]);

  return (
    <Card>
      <CardBody className="p-6">
        <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
          <div>
            <h2 className="text-lg font-semibold text-[var(--foreground)]">Environments</h2>
            <p className="text-sm text-[var(--muted)] mt-0.5">
              Define where your tests should run — e.g. <span className="font-medium">Staging</span> at{" "}
              <code className="bg-[var(--glass-bg-subtle)] px-1 rounded text-xs">https://staging.example.com</code>.
              Pick one when creating a scheduled run; the URL is injected as{" "}
              <code className="bg-[var(--glass-bg-subtle)] px-1 rounded text-xs">PLAYWRIGHT_BASE_URL</code>.
            </p>
          </div>
          {canManage && editingId !== "new" && (
            <Button size="sm" onClick={() => setEditingId("new")}>+ Add environment</Button>
          )}
        </div>

        {loadError && <Banner tone="error" description={loadError} />}

        {editingId === "new" && (
          <div className="mb-4 rounded-xl border border-[var(--brand-border)] bg-[var(--brand-soft)] p-4">
            <h3 className="text-sm font-semibold mb-3">New environment</h3>
            <EnvironmentForm
              projectId={projectId}
              onCancel={() => setEditingId(null)}
              onSaved={() => { setEditingId(null); void reload(); }}
            />
          </div>
        )}

        {environments === null ? (
          <div className="h-12 animate-pulse rounded bg-[var(--glass-bg-subtle)]" />
        ) : environments.length === 0 && editingId !== "new" ? (
          <EmptyStateBlock
            title="No environments yet"
            description={
              canManage
                ? "Add your first environment to point scheduled runs at a deployed copy of your app."
                : "No environments have been configured for this project."
            }
          />
        ) : (
          <ul className="space-y-2">
            {environments.map((env) => (
              <EnvironmentRow
                key={env.id}
                projectId={projectId}
                env={env}
                canManage={canManage}
                editing={editingId === env.id}
                onEdit={() => setEditingId(env.id)}
                onCancel={() => setEditingId(null)}
                onSaved={() => { setEditingId(null); void reload(); }}
                onDeleted={() => void reload()}
              />
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

function EnvironmentRow({
  projectId,
  env,
  canManage,
  editing,
  onEdit,
  onCancel,
  onSaved,
  onDeleted,
}: {
  projectId: string;
  env: ProjectEnvironment;
  canManage: boolean;
  editing: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  async function handleDelete() {
    setBusy(true);
    setError("");
    try {
      await deleteProjectEnvironment(projectId, env.id);
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete");
    } finally {
      setBusy(false);
      setConfirmDelete(false);
    }
  }

  if (editing) {
    return (
      <li className="rounded-xl border border-[var(--brand-border)] bg-[var(--brand-soft)] p-4">
        <EnvironmentForm
          projectId={projectId}
          initial={env}
          onCancel={onCancel}
          onSaved={onSaved}
        />
      </li>
    );
  }

  const visibleVars = env.variables.length;

  return (
    <li className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-primary)] px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h4 className="text-sm font-semibold text-[var(--foreground)]">{env.name}</h4>
            {env.isDefault && <StatusChip tone="brand">Default</StatusChip>}
          </div>
          {env.baseUrl && (
            <p className="mt-0.5 text-sm text-[var(--muted)] font-mono break-all">{env.baseUrl}</p>
          )}
          <p className="mt-1 text-xs text-[var(--muted)]">
            {visibleVars === 0
              ? "Base URL only"
              : `${visibleVars} extra variable${visibleVars === 1 ? "" : "s"}`}
          </p>
          {error && <p className="mt-1 text-xs text-[var(--error,#c0392b)]">{error}</p>}
        </div>
        {canManage && (
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <Button size="sm" variant="secondary" onClick={onEdit} disabled={busy}>Edit</Button>
            {confirmDelete ? (
              <>
                <Button size="sm" variant="destructive" onClick={handleDelete} disabled={busy}>
                  {busy ? "Deleting…" : "Confirm"}
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setConfirmDelete(false)} disabled={busy}>
                  Cancel
                </Button>
              </>
            ) : (
              <Button size="sm" variant="secondary" onClick={() => setConfirmDelete(true)} disabled={busy}>
                Delete
              </Button>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

function EnvironmentForm({
  projectId,
  initial,
  onCancel,
  onSaved,
}: {
  projectId: string;
  initial?: ProjectEnvironment;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(initial?.name || "");
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl || "");
  const [isDefault, setIsDefault] = useState(Boolean(initial?.isDefault));
  const [vars, setVars] = useState<DraftVariable[]>(
    initial ? toDraft(initial.variables) : freshVariables()
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  function addVar() {
    setVars((prev) => [...prev, { _tmpId: makeTmpId(), key: "", value: "", isSecret: false }]);
  }
  function removeVar(tmpId: string) {
    setVars((prev) => prev.filter((v) => v._tmpId !== tmpId));
  }
  function updateVar(tmpId: string, patch: Partial<ProjectEnvironmentVariable>) {
    setVars((prev) => prev.map((v) => (v._tmpId === tmpId ? { ...v, ...patch } : v)));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const trimmedName = name.trim();
    if (!trimmedName) { setError("Name is required"); return; }

    // Local validation matching the backend's allowed key shape — gives faster
    // feedback than waiting for the 400.
    const cleanedVars: ProjectEnvironmentVariable[] = [];
    const seenKeys = new Set<string>();
    for (const v of vars) {
      const key = v.key.trim();
      if (!key) continue;
      if (!VAR_KEY_RE.test(key)) {
        setError(`"${key}" isn't a valid variable name (letters, digits, underscore; must not start with a digit)`);
        return;
      }
      if (seenKeys.has(key)) {
        setError(`Duplicate variable "${key}"`);
        return;
      }
      seenKeys.add(key);
      cleanedVars.push({ key, value: v.value, isSecret: v.isSecret });
    }

    setSubmitting(true);
    try {
      if (initial) {
        await updateProjectEnvironment(projectId, initial.id, {
          name: trimmedName,
          baseUrl: baseUrl.trim() || null,
          variables: cleanedVars,
          isDefault,
        });
      } else {
        await createProjectEnvironment(projectId, {
          name: trimmedName,
          baseUrl: baseUrl.trim() || null,
          variables: cleanedVars,
          isDefault,
        });
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && <Banner tone="error" description={error} />}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="envName">Name</FieldLabel>
          <Input
            id="envName"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={submitting}
            placeholder="Staging"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="envBaseUrl">Base URL</FieldLabel>
          <Input
            id="envBaseUrl"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            disabled={submitting}
            placeholder="https://staging.example.com"
            type="url"
          />
          <FieldHint>
            Injected as <code>PLAYWRIGHT_BASE_URL</code> and <code>TESBO_BASE_URL</code> when this environment runs.
          </FieldHint>
        </Field>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={isDefault}
          onChange={(e) => setIsDefault(e.target.checked)}
          disabled={submitting}
        />
        Make this the default environment
      </label>

      <div>
        <div className="flex items-center justify-between mb-2">
          <FieldLabel>Additional variables</FieldLabel>
          <Button type="button" size="sm" variant="secondary" onClick={addVar} disabled={submitting}>
            + Add variable
          </Button>
        </div>
        {vars.length === 0 ? (
          <p className="text-xs text-[var(--muted)] italic">No extra variables. The base URL above is usually enough.</p>
        ) : (
          <div className="space-y-2">
            {vars.map((v) => (
              <div key={v._tmpId} className="flex flex-wrap items-start gap-2">
                <Input
                  value={v.key}
                  onChange={(e) => updateVar(v._tmpId, { key: e.target.value })}
                  placeholder="MY_VAR"
                  disabled={submitting}
                  className="flex-1 min-w-[8rem]"
                />
                <Input
                  value={v.value}
                  onChange={(e) => updateVar(v._tmpId, { value: e.target.value })}
                  placeholder={v.isSecret ? "(stored as GitHub secret)" : "value"}
                  disabled={submitting}
                  type={v.isSecret ? "password" : "text"}
                  className="flex-[2] min-w-[10rem]"
                />
                <label className="flex items-center gap-1.5 text-xs whitespace-nowrap pt-2">
                  <input
                    type="checkbox"
                    checked={v.isSecret}
                    onChange={(e) => updateVar(v._tmpId, { isSecret: e.target.checked })}
                    disabled={submitting}
                  />
                  Secret
                </label>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => removeVar(v._tmpId)}
                  disabled={submitting}
                >
                  ✕
                </Button>
              </div>
            ))}
            <p className="text-xs text-[var(--muted)]">
              <strong>Secret</strong> values are pushed to the test repo's GitHub Actions Secrets and referenced via{" "}
              <code>${'{{'} secrets.NAME {'}}'}</code>. Non-secret values are inlined into the committed workflow YAML.
            </p>
          </div>
        )}
      </div>

      <div className="flex justify-end gap-2 pt-2 border-t border-[var(--brand-border)]">
        <Button type="button" variant="secondary" onClick={onCancel} disabled={submitting}>Cancel</Button>
        <Button type="submit" disabled={submitting}>
          {submitting ? "Saving…" : initial ? "Save changes" : "Create environment"}
        </Button>
      </div>
    </form>
  );
}
