"use client";

import { useEffect, useState } from "react";
import {
  createWorkspaceAiKey,
  deleteWorkspaceAiKey,
  listWorkspaceAiKeys,
  type WorkspaceAiKey,
  type WorkspaceAiKeysResponse,
} from "@/lib/api";
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
  Modal,
  Select,
  StatusChip,
  TableSkeleton,
} from "@/components/ui";

export default function IntegrationsPage() {
  const [data, setData] = useState<WorkspaceAiKeysResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [addName, setAddName] = useState("");
  const [addProvider, setAddProvider] = useState<"openai" | "anthropic">(
    "openai"
  );
  const [addKey, setAddKey] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    setLoading(true);
    try {
      setData(await listWorkspaceAiKeys());
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!addName.trim() || !addKey.trim()) {
      setError("Name and API key are required");
      return;
    }
    setAdding(true);
    try {
      await createWorkspaceAiKey({
        name: addName.trim(),
        provider: addProvider,
        apiKey: addKey.trim(),
      });
      setShowAdd(false);
      setAddName("");
      setAddKey("");
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add key");
    } finally {
      setAdding(false);
    }
  }

  async function handleDelete(keyId: string) {
    if (!confirm("Delete this AI key?")) return;
    await deleteWorkspaceAiKey(keyId);
    await loadData();
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="h-16 animate-pulse rounded-xl bg-[var(--glass-bg-subtle)]" />
        <TableSkeleton rows={3} cols={5} />
      </div>
    );
  }

  const keys = data?.keys || [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--foreground)]">
            API Keys
          </h1>
          <p className="text-sm text-[var(--muted)]">
            Manage workspace API keys for AI-powered features
          </p>
        </div>
        <Button onClick={() => setShowAdd(true)}>Add AI Key</Button>
      </div>

      <Card>
        <CardBody className="p-0">
          <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border-subtle)]">
            <h2 className="text-base font-semibold text-[var(--foreground)]">AI Keys</h2>
            <span className="text-xs text-[var(--muted)]">{keys.length} configured</span>
          </div>
          {keys.length === 0 ? (
            <EmptyStateBlock
              title="No AI keys yet"
              description="Add an OpenAI or Anthropic key to enable AI-powered analysis on your test reports."
              action={
                <Button onClick={() => setShowAdd(true)}>Add AI Key</Button>
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="tesbo-table min-w-[760px]">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Provider</th>
                    <th>Key</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {keys.map((k) => (
                    <tr key={k.id}>
                      <td className="font-medium">{k.name}</td>
                      <td className="text-sm capitalize">{k.provider}</td>
                      <td>
                        <code className="rounded bg-[var(--glass-bg-subtle)] px-2 py-0.5 font-mono text-xs text-[var(--muted)]">
                          {k.maskedKey}
                        </code>
                      </td>
                      <td>
                        <StatusChip tone={k.active ? "success" : "error"}>
                          {k.active ? "Active" : "Inactive"}
                        </StatusChip>
                      </td>
                      <td className="text-right">
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => handleDelete(k.id)}
                        >
                          Delete
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      {showAdd && (
        <Modal open onClose={() => setShowAdd(false)} title="Add AI Key">
          <form onSubmit={handleAdd} className="space-y-4">
            {error && <Banner tone="error" description={error} />}
            <Field>
              <FieldLabel htmlFor="keyName">Name</FieldLabel>
              <Input
                id="keyName"
                value={addName}
                onChange={(e) => setAddName(e.target.value)}
                placeholder="Production OpenAI"
                disabled={adding}
                autoFocus
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="keyProvider">Provider</FieldLabel>
              <Select
                id="keyProvider"
                value={addProvider}
                onChange={(e) =>
                  setAddProvider(e.target.value as "openai" | "anthropic")
                }
                disabled={adding}
              >
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic</option>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="keyValue">API Key</FieldLabel>
              <Input
                id="keyValue"
                type="password"
                value={addKey}
                onChange={(e) => setAddKey(e.target.value)}
                placeholder="sk-..."
                disabled={adding}
              />
              <FieldHint>The key is stored encrypted and never shown in full after saving.</FieldHint>
            </Field>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="secondary"
                onClick={() => setShowAdd(false)}
                disabled={adding}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={adding}>
                {adding ? "Adding…" : "Add Key"}
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
