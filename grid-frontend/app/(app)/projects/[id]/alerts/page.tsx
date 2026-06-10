"use client";

import { use, useEffect, useMemo, useState } from "react";
import {
  Button,
  Card,
  CardBody,
  Field,
  FieldLabel,
  Input,
  Select,
} from "@/components/ui";
import {
  createProjectAlert,
  deleteProjectAlert,
  getProject,
  listProjectAlertEvents,
  listProjectAlerts,
  updateProjectAlert,
  type AlertChannel,
  type AlertMetric,
  type AlertOperator,
  type AlertUnit,
  type ProjectAlert,
  type ProjectAlertEvent,
} from "@/lib/api";

type AlertTab = "alerts" | "history";

type DraftAlert = {
  id: string;
  serverId: string | null; // null = unsaved (only exists locally)
  name: string;
  metric: AlertMetric;
  operator: AlertOperator;
  threshold: number;
  unit: AlertUnit;
  enabled: boolean;
  channel: AlertChannel;
  recipients: string[];
  saving: boolean;
  dirty: boolean;
  error: string | null;
};

const metricOptions: Array<{ value: AlertMetric; label: string; unit: AlertUnit }> = [
  { value: "pass_ratio", label: "Pass ratio", unit: "%" },
  { value: "failure_rate", label: "Failure rate", unit: "%" },
  { value: "flaky_tests", label: "Flaky tests", unit: "tests" },
];

function metricLabel(metric: AlertMetric) {
  return metricOptions.find((option) => option.value === metric)?.label || "Metric";
}

function metricUnit(metric: AlertMetric): AlertUnit {
  return metricOptions.find((option) => option.value === metric)?.unit || "%";
}

function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function localId() {
  return `local-${crypto.randomUUID()}`;
}

function fromServer(alert: ProjectAlert): DraftAlert {
  return {
    id: alert.id,
    serverId: alert.id,
    name: alert.name,
    metric: alert.metric,
    operator: alert.operator,
    threshold: Number(alert.threshold) || 0,
    unit: alert.unit,
    enabled: alert.enabled,
    channel: alert.channel,
    recipients: Array.isArray(alert.recipients) ? alert.recipients : [],
    saving: false,
    dirty: false,
    error: null,
  };
}

function emptyDraft(): DraftAlert {
  return {
    id: localId(),
    serverId: null,
    name: "New alert",
    metric: "pass_ratio",
    operator: "below",
    threshold: 100,
    unit: "%",
    enabled: true,
    channel: "email",
    recipients: [],
    saving: false,
    dirty: true,
    error: null,
  };
}

function toPayload(rule: DraftAlert) {
  return {
    name: rule.name.trim() || "Untitled alert",
    metric: rule.metric,
    operator: rule.operator,
    threshold: Number(rule.threshold) || 0,
    unit: rule.unit,
    channel: rule.channel,
    recipients: rule.recipients,
    enabled: rule.enabled,
  };
}

export default function ProjectAlertsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [activeTab, setActiveTab] = useState<AlertTab>("alerts");
  const [projectName, setProjectName] = useState("");
  const [rules, setRules] = useState<DraftAlert[]>([]);
  const [history, setHistory] = useState<ProjectAlertEvent[]>([]);
  const [recipientDrafts, setRecipientDrafts] = useState<Record<string, string>>({});
  const [recipientErrors, setRecipientErrors] = useState<Record<string, string>>({});
  const [lastCreatedRuleId, setLastCreatedRuleId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);

  const dirtyCount = useMemo(
    () => rules.filter((rule) => rule.dirty || rule.serverId == null).length,
    [rules]
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([getProject(id), listProjectAlerts(id)])
      .then(([project, response]) => {
        if (cancelled) return;
        setProjectName(project.name || "");
        setRules(response.alerts.map(fromServer));
        setPageError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setPageError(err instanceof Error ? err.message : "Failed to load alerts");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(() => {
    if (activeTab !== "history") return;
    let cancelled = false;
    setHistoryLoading(true);
    listProjectAlertEvents(id, 100)
      .then((response) => {
        if (cancelled) return;
        setHistory(response.events);
      })
      .catch(() => {
        if (cancelled) return;
        setHistory([]);
      })
      .finally(() => {
        if (!cancelled) setHistoryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id, activeTab]);

  function patchRule(ruleId: string, patch: Partial<DraftAlert>) {
    setRules((current) =>
      current.map((rule) =>
        rule.id === ruleId ? { ...rule, ...patch, dirty: true, error: null } : rule
      )
    );
  }

  function patchRuleSilent(ruleId: string, patch: Partial<DraftAlert>) {
    setRules((current) =>
      current.map((rule) => (rule.id === ruleId ? { ...rule, ...patch } : rule))
    );
  }

  function addAlertRule() {
    const next = emptyDraft();
    setRules((current) => [next, ...current]);
    setLastCreatedRuleId(next.id);
  }

  async function saveRule(ruleId: string) {
    const rule = rules.find((item) => item.id === ruleId);
    if (!rule) return;

    if (!rule.name.trim()) {
      patchRuleSilent(ruleId, { error: "Name is required." });
      return;
    }
    if (rule.recipients.length === 0 && rule.channel === "email") {
      patchRuleSilent(ruleId, { error: "Add at least one email recipient." });
      return;
    }

    patchRuleSilent(ruleId, { saving: true, error: null });
    try {
      if (rule.serverId == null) {
        const { alert } = await createProjectAlert(id, toPayload(rule));
        setRules((current) =>
          current.map((item) =>
            item.id === ruleId
              ? { ...fromServer(alert), id: ruleId }
              : item
          )
        );
      } else {
        const { alert } = await updateProjectAlert(id, rule.serverId, toPayload(rule));
        setRules((current) =>
          current.map((item) =>
            item.id === ruleId ? { ...fromServer(alert), id: ruleId } : item
          )
        );
      }
    } catch (err) {
      patchRuleSilent(ruleId, {
        saving: false,
        error: err instanceof Error ? err.message : "Failed to save alert",
      });
    }
  }

  async function toggleEnabled(ruleId: string) {
    const rule = rules.find((item) => item.id === ruleId);
    if (!rule) return;
    const next = !rule.enabled;
    if (rule.serverId == null) {
      patchRule(ruleId, { enabled: next });
      return;
    }
    patchRuleSilent(ruleId, { enabled: next, saving: true, error: null });
    try {
      await updateProjectAlert(id, rule.serverId, { enabled: next });
      patchRuleSilent(ruleId, { saving: false, dirty: false });
    } catch (err) {
      patchRuleSilent(ruleId, {
        enabled: !next,
        saving: false,
        error: err instanceof Error ? err.message : "Failed to update alert",
      });
    }
  }

  async function deleteAlertRule(ruleId: string) {
    const rule = rules.find((item) => item.id === ruleId);
    if (!rule) return;
    if (rule.serverId == null) {
      setRules((current) => current.filter((item) => item.id !== ruleId));
      return;
    }
    patchRuleSilent(ruleId, { saving: true, error: null });
    try {
      await deleteProjectAlert(id, rule.serverId);
      setRules((current) => current.filter((item) => item.id !== ruleId));
      setRecipientDrafts((current) => {
        const { [ruleId]: _, ...rest } = current;
        return rest;
      });
      setRecipientErrors((current) => {
        const { [ruleId]: _, ...rest } = current;
        return rest;
      });
    } catch (err) {
      patchRuleSilent(ruleId, {
        saving: false,
        error: err instanceof Error ? err.message : "Failed to delete alert",
      });
    }
  }

  function addRecipient(ruleId: string) {
    const draft = (recipientDrafts[ruleId] || "").trim().toLowerCase();
    const rule = rules.find((item) => item.id === ruleId);
    if (!rule) return;

    if (!draft) {
      setRecipientErrors((current) => ({ ...current, [ruleId]: "Email is required." }));
      return;
    }
    if (!isValidEmail(draft)) {
      setRecipientErrors((current) => ({
        ...current,
        [ruleId]: "Enter a valid email address.",
      }));
      return;
    }
    if (rule.recipients.includes(draft)) {
      setRecipientErrors((current) => ({
        ...current,
        [ruleId]: "Email is already in the notify list.",
      }));
      return;
    }

    patchRule(ruleId, { recipients: [...rule.recipients, draft] });
    setRecipientDrafts((current) => ({ ...current, [ruleId]: "" }));
    setRecipientErrors((current) => ({ ...current, [ruleId]: "" }));
  }

  function removeRecipient(ruleId: string, email: string) {
    const rule = rules.find((item) => item.id === ruleId);
    if (!rule) return;
    patchRule(ruleId, {
      recipients: rule.recipients.filter((recipient) => recipient !== email),
    });
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--foreground)]">
            Alerts
          </h1>
          <p className="text-sm text-[var(--muted)]">
            Configure alerting rules and review triggered events for{" "}
            <span className="font-medium">{projectName || "this project"}</span>.
            {dirtyCount > 0 && activeTab === "alerts" && (
              <span className="ml-2 text-[var(--warning)]">
                {dirtyCount} unsaved change{dirtyCount === 1 ? "" : "s"}.
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {activeTab === "alerts" && <Button onClick={addAlertRule}>Create Alert</Button>}
          <div className="glass-subtle inline-flex items-center p-1">
            <button
              type="button"
              onClick={() => setActiveTab("alerts")}
              aria-pressed={activeTab === "alerts"}
              className={`rounded-xl px-4 py-1.5 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_oklab,var(--brand-primary)_30%,transparent)] ${
                activeTab === "alerts"
                  ? "bg-[var(--glass-bg)] text-[var(--foreground)] shadow-sm"
                  : "text-[var(--muted)] hover:text-[var(--foreground)]"
              }`}
            >
              Alerts
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("history")}
              aria-pressed={activeTab === "history"}
              className={`rounded-xl px-4 py-1.5 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_oklab,var(--brand-primary)_30%,transparent)] ${
                activeTab === "history"
                  ? "bg-[var(--glass-bg)] text-[var(--foreground)] shadow-sm"
                  : "text-[var(--muted)] hover:text-[var(--foreground)]"
              }`}
            >
              Alert History
            </button>
          </div>
        </div>
      </div>

      {pageError && (
        <div className="tesbo-card flex items-start gap-3 border-[var(--error-border)] bg-[var(--error-soft)] p-4">
          <svg className="mt-0.5 h-4 w-4 shrink-0 text-[var(--error)]" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 15.75h.007v.008H12v-.008z" />
          </svg>
          <p className="text-sm text-[var(--error-foreground)]">{pageError}</p>
        </div>
      )}

      {activeTab === "alerts" ? (
        <div className="space-y-4">
          <Card>
            <CardBody className="p-5">
              <p className="text-sm text-[var(--muted)]">
                Create as many alerts as needed. Each alert can define condition,
                threshold, and who should get an email when the condition is met.
                Alerts are evaluated automatically when a run finishes.
              </p>
            </CardBody>
          </Card>

          {loading ? (
            <Card>
              <CardBody className="p-6">
                <p className="text-sm text-[var(--muted)]">Loading alerts…</p>
              </CardBody>
            </Card>
          ) : rules.length === 0 ? (
            <Card>
              <CardBody className="p-6">
                <p className="text-sm text-[var(--muted)]">
                  No alerts yet. Create your first alert to start monitoring run quality.
                </p>
              </CardBody>
            </Card>
          ) : (
            rules.map((rule) => (
              <Card key={rule.id}>
                <CardBody
                  className={`space-y-4 p-6 ${
                    lastCreatedRuleId === rule.id
                      ? "rounded-xl border border-[var(--brand-primary)]"
                      : ""
                  }`}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="w-full max-w-md">
                      <Field>
                        <FieldLabel>Alert name</FieldLabel>
                        <Input
                          value={rule.name}
                          onChange={(e) => patchRule(rule.id, { name: e.target.value })}
                          placeholder="Example: Pass ratio dropped"
                        />
                      </Field>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant={rule.enabled ? "secondary" : "primary"}
                        size="sm"
                        onClick={() => toggleEnabled(rule.id)}
                        disabled={rule.saving}
                      >
                        {rule.enabled ? "Enabled" : "Enable"}
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => saveRule(rule.id)}
                        disabled={rule.saving || (!rule.dirty && rule.serverId != null)}
                      >
                        {rule.saving
                          ? "Saving…"
                          : rule.serverId == null
                          ? "Save"
                          : rule.dirty
                          ? "Save changes"
                          : "Saved"}
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => deleteAlertRule(rule.id)}
                        disabled={rule.saving}
                      >
                        Delete
                      </Button>
                    </div>
                  </div>

                  <div className="grid gap-3 md:grid-cols-4">
                    <Field>
                      <FieldLabel>Metric</FieldLabel>
                      <Select
                        value={rule.metric}
                        onChange={(e) => {
                          const nextMetric = e.target.value as AlertMetric;
                          patchRule(rule.id, {
                            metric: nextMetric,
                            unit: metricUnit(nextMetric),
                          });
                        }}
                      >
                        {metricOptions.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </Select>
                    </Field>

                    <Field>
                      <FieldLabel>Condition</FieldLabel>
                      <Select
                        value={rule.operator}
                        onChange={(e) =>
                          patchRule(rule.id, { operator: e.target.value as AlertOperator })
                        }
                      >
                        <option value="below">Drops below</option>
                        <option value="above">Rises above</option>
                      </Select>
                    </Field>

                    <Field>
                      <FieldLabel>Threshold</FieldLabel>
                      <Input
                        type="number"
                        min={0}
                        max={rule.unit === "%" ? 100 : undefined}
                        value={rule.threshold}
                        onChange={(e) =>
                          patchRule(rule.id, {
                            threshold: Number(e.target.value || 0),
                          })
                        }
                      />
                    </Field>

                    <Field>
                      <FieldLabel>Notify via</FieldLabel>
                      <Select
                        value={rule.channel}
                        onChange={(e) =>
                          patchRule(rule.id, {
                            channel: e.target.value as AlertChannel,
                          })
                        }
                      >
                        <option value="email">Email</option>
                        <option value="in_app">In-app</option>
                        <option value="slack">Slack</option>
                      </Select>
                    </Field>
                  </div>

                  <div className="space-y-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-secondary)] p-4">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm font-medium text-[var(--foreground)]">
                        Whom to notify
                      </p>
                      <p className="text-xs text-[var(--muted)]">
                        Email trigger runs when condition is met.
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Input
                        type="email"
                        placeholder="person@company.com"
                        value={recipientDrafts[rule.id] || ""}
                        onChange={(e) =>
                          setRecipientDrafts((current) => ({
                            ...current,
                            [rule.id]: e.target.value,
                          }))
                        }
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            addRecipient(rule.id);
                          }
                        }}
                        className="max-w-xs"
                      />
                      <Button size="sm" onClick={() => addRecipient(rule.id)}>
                        Add Email
                      </Button>
                    </div>
                    {recipientErrors[rule.id] && (
                      <p className="text-xs text-[var(--error)]">{recipientErrors[rule.id]}</p>
                    )}
                    {rule.recipients.length === 0 ? (
                      <p className="text-xs text-[var(--muted)]">
                        No recipients yet. Add at least one email to receive this alert.
                      </p>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {rule.recipients.map((email) => (
                          <span
                            key={email}
                            className="inline-flex items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--surface)] px-2.5 py-0.5 text-xs text-[var(--foreground)]"
                          >
                            {email}
                            <button
                              type="button"
                              aria-label={`Remove ${email}`}
                              onClick={() => removeRecipient(rule.id, email)}
                              className="text-[var(--muted)] hover:text-[var(--foreground)]"
                            >
                              x
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  <p className="text-xs text-[var(--muted)]">
                    Trigger when <span className="font-medium">{metricLabel(rule.metric)}</span>{" "}
                    is {rule.operator === "below" ? "below" : "above"}{" "}
                    <span className="font-medium">
                      {rule.threshold}
                      {rule.unit === "%" ? "%" : ` ${rule.unit}`}
                    </span>
                    .
                  </p>

                  {rule.error && (
                    <p className="text-xs text-[var(--error)]">{rule.error}</p>
                  )}
                </CardBody>
              </Card>
            ))
          )}
        </div>
      ) : (
        <Card>
          <CardBody className="p-0">
            {historyLoading ? (
              <p className="p-6 text-sm text-[var(--muted)]">Loading alert history…</p>
            ) : history.length === 0 ? (
              <p className="p-6 text-sm text-[var(--muted)]">
                No alert activity yet.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="tesbo-table min-w-[760px]">
                  <thead>
                    <tr>
                      <th>Rule</th>
                      <th>Alert</th>
                      <th>Run</th>
                      <th>Severity</th>
                      <th>Triggered At</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((entry) => (
                      <tr key={entry.id}>
                        <td className="font-medium">{entry.ruleTitle}</td>
                        <td className="text-sm text-[var(--muted)]">
                          {entry.summary}
                        </td>
                        <td>{entry.runName || "—"}</td>
                        <td>
                          <span className="inline-block rounded-full border border-[var(--border-subtle)] bg-[var(--surface-secondary)] px-2.5 py-0.5 text-xs font-medium">
                            {entry.severity}
                          </span>
                        </td>
                        <td className="text-sm text-[var(--muted)]">
                          {new Date(entry.triggeredAt).toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardBody>
        </Card>
      )}
    </div>
  );
}
