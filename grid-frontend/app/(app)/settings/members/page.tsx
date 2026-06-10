"use client";

import { useEffect, useState } from "react";
import {
  addWorkspaceMember,
  getWorkspace,
  listWorkspaceMembers,
  removeWorkspaceMember,
  type WorkspaceInfo,
  type WorkspaceMember,
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

const ROLE_OPTIONS = [
  { value: "member", label: "Member — can view all projects and run reports" },
  { value: "admin", label: "Admin — can manage projects, keys, and members" },
];

export default function MembersPage() {
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [addEmail, setAddEmail] = useState("");
  const [addRole, setAddRole] = useState("member");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    setLoading(true);
    try {
      const [ws, mems] = await Promise.all([
        getWorkspace(),
        listWorkspaceMembers(),
      ]);
      setWorkspace(ws);
      setMembers(mems.sort((a, b) => new Date(b.joinedAt).getTime() - new Date(a.joinedAt).getTime()));
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!addEmail.trim()) {
      setError("Email is required");
      return;
    }
    setAdding(true);
    try {
      await addWorkspaceMember({
        email: addEmail.trim().toLowerCase(),
        role: addRole,
      });
      setShowAdd(false);
      setAddEmail("");
      setAddRole("member");
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add member");
    } finally {
      setAdding(false);
    }
  }

  async function handleRemove(userId: string) {
    if (!confirm("Remove this member from the workspace?")) return;
    await removeWorkspaceMember(userId);
    await loadData();
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="h-16 animate-pulse rounded-xl bg-[var(--glass-bg-subtle)]" />
        <TableSkeleton rows={5} cols={5} />
      </div>
    );
  }

  const seatCount = members.length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--foreground)]">
            Workspace Members
          </h1>
          <p className="text-sm text-[var(--muted)]">
            <span className="font-medium">{workspace?.name || "Your workspace"}</span>
            {" · "}
            {seatCount} {seatCount === 1 ? "member" : "members"}
          </p>
        </div>
        <Button onClick={() => { setError(""); setShowAdd(true); }}>Add Member</Button>
      </div>

      <Card>
        <CardBody className="p-0">
          {members.length === 0 ? (
            <EmptyStateBlock
              title="No members yet"
              description="Add team members to give them access to projects and reports."
              action={
                <Button onClick={() => setShowAdd(true)}>Add first member</Button>
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="tesbo-table min-w-[760px]">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Email</th>
                    <th>Role</th>
                    <th>Joined</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {members.map((m) => (
                    <tr key={m.userId}>
                      <td className="font-medium">{m.name || "—"}</td>
                      <td className="text-sm text-[var(--muted)]">{m.email}</td>
                      <td>
                        <StatusChip
                          tone={
                            m.role === "owner"
                              ? "brand"
                              : m.role === "admin"
                              ? "ai"
                              : "neutral"
                          }
                        >
                          {m.role}
                        </StatusChip>
                      </td>
                      <td className="text-sm text-[var(--muted)]">
                        {new Date(m.joinedAt).toLocaleDateString()}
                      </td>
                      <td className="text-right">
                        {m.role !== "owner" && (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => handleRemove(m.userId)}
                          >
                            Remove
                          </Button>
                        )}
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
        <Modal open onClose={() => setShowAdd(false)} title="Add Member">
          <form onSubmit={handleAdd} className="space-y-4">
            {error && <Banner tone="error" description={error} />}
            <Field>
              <FieldLabel htmlFor="memberEmail">Email address</FieldLabel>
              <Input
                id="memberEmail"
                type="email"
                value={addEmail}
                onChange={(e) => setAddEmail(e.target.value)}
                placeholder="colleague@company.com"
                disabled={adding}
                autoFocus
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="memberRole">Role</FieldLabel>
              <Select
                id="memberRole"
                value={addRole}
                onChange={(e) => setAddRole(e.target.value)}
                disabled={adding}
              >
                {ROLE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
              <FieldHint>You can change the role later from this table.</FieldHint>
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
                {adding ? "Adding…" : "Add Member"}
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
