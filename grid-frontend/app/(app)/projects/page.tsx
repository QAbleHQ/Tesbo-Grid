"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  createProject,
  deleteProject,
  listProjects,
  type CreateProjectResponse,
  type ProjectBrowser,
  type ProjectFramework,
  type ProjectLanguage,
  type ProjectSummary,
} from "@/lib/api";
import {
  Banner,
  Button,
  Card,
  CardBody,
  EmptyStateBlock,
  Field,
  FieldError,
  FieldHint,
  FieldLabel,
  Input,
  Modal,
  Select,
  SelectorGroup,
  StatusChip,
  Textarea,
} from "@/components/ui";

const FRAMEWORK_OPTIONS: { id: ProjectFramework; label: string; description: string }[] = [
  { id: "playwright", label: "Playwright", description: "Modern, all-in-one browser automation" },
  { id: "selenium", label: "Selenium", description: "Industry-standard WebDriver" },
];

const LANGUAGE_OPTIONS_BY_FRAMEWORK: Record<
  ProjectFramework,
  { id: ProjectLanguage; label: string }[]
> = {
  playwright: [
    { id: "typescript", label: "TypeScript" },
    { id: "javascript", label: "JavaScript" },
    { id: "python", label: "Python" },
    { id: "java", label: "Java" },
  ],
  selenium: [
    { id: "java", label: "Java" },
    { id: "python", label: "Python" },
  ],
};

const BROWSER_OPTIONS: { id: ProjectBrowser; label: string }[] = [
  { id: "chrome", label: "Chrome" },
  { id: "firefox", label: "Firefox" },
  { id: "edge", label: "Edge" },
];

const FRAMEWORK_LABEL: Record<ProjectFramework, string> = {
  playwright: "Playwright",
  selenium: "Selenium",
};

function ProjectsPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const shouldCreate =
    searchParams.get("create") === "1" ||
    searchParams.get("fromOnboarding") === "1";
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [sortBy, setSortBy] = useState<"recent" | "name" | "created">("recent");
  const [showCreate, setShowCreate] = useState(false);
  const [createStep, setCreateStep] = useState<1 | 2>(1);
  const [createName, setCreateName] = useState("");
  const [createKey, setCreateKey] = useState("");
  const [createDesc, setCreateDesc] = useState("");
  const [createFramework, setCreateFramework] = useState<ProjectFramework>("playwright");
  const [createLanguage, setCreateLanguage] = useState<ProjectLanguage>("typescript");
  const [createBrowser, setCreateBrowser] = useState<ProjectBrowser>("chrome");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [confirmDeleteDemoId, setConfirmDeleteDemoId] = useState<string | null>(null);
  const [deletingDemo, setDeletingDemo] = useState(false);

  function resetCreateState() {
    setCreateStep(1);
    setCreateName("");
    setCreateKey("");
    setCreateDesc("");
    setCreateFramework("playwright");
    setCreateLanguage("typescript");
    setCreateBrowser("chrome");
    setError("");
  }

  function closeCreateModal() {
    setShowCreate(false);
    resetCreateState();
  }

  function handleFrameworkChange(framework: ProjectFramework) {
    setCreateFramework(framework);
    const allowed = LANGUAGE_OPTIONS_BY_FRAMEWORK[framework];
    if (!allowed.some((l) => l.id === createLanguage)) {
      setCreateLanguage(allowed[0].id);
    }
  }

  function handleStep1Submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!createName.trim()) {
      setError("Project name is required");
      return;
    }
    setCreateStep(2);
  }

  useEffect(() => {
    loadProjects();
  }, []);

  useEffect(() => {
    if (shouldCreate && !loading && projects.length === 0) {
      setShowCreate(true);
    }
  }, [shouldCreate, loading, projects.length]);

  async function loadProjects() {
    setLoading(true);
    try {
      const list = await listProjects();
      setProjects(list);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!createName.trim()) {
      setError("Project name is required");
      setCreateStep(1);
      return;
    }
    setCreating(true);
    try {
      const result: CreateProjectResponse = await createProject({
        name: createName.trim(),
        key: createKey.trim() || undefined,
        description: createDesc.trim() || undefined,
        framework: createFramework,
        language: createLanguage,
        defaultBrowser: createBrowser,
      });
      setShowCreate(false);
      resetCreateState();
      await loadProjects();
      router.push(`/projects/${result.id}/dashboard`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create project");
    } finally {
      setCreating(false);
    }
  }

  async function handleDeleteDemo() {
    if (!confirmDeleteDemoId) return;
    setDeletingDemo(true);
    try {
      await deleteProject(confirmDeleteDemoId);
      setConfirmDeleteDemoId(null);
      await loadProjects();
    } catch {
      // silent — project list will stay as-is
    } finally {
      setDeletingDemo(false);
    }
  }

  const sortedProjects = [...projects].sort((a, b) => {
    if (sortBy === "name") return a.name.localeCompare(b.name);
    if (sortBy === "created") return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--foreground)]">
            Grid Projects
          </h1>
          <p className="text-sm text-[var(--muted)]">
            Manage your test execution projects and runners{projects.length > 0 ? ` · ${projects.length} project${projects.length !== 1 ? "s" : ""}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {!loading && projects.length > 1 && (
            <Select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
              className="w-44"
            >
              <option value="recent">Sort: Recent</option>
              <option value="name">Sort: Name</option>
              <option value="created">Sort: Created</option>
            </Select>
          )}
          {!loading && projects.length > 0 && (
            <Button onClick={() => setShowCreate(true)}>New Project</Button>
          )}
        </div>
      </div>

      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="skeleton h-40 rounded-[var(--radius-card)]" />
          ))}
        </div>
      ) : projects.length === 0 ? (
        <EmptyStateBlock
          title="No projects yet"
          description="Create your first Grid project to start running automated tests."
          icon={
            <svg className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 7h8l2 2h8v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
            </svg>
          }
          action={
            <Button onClick={() => setShowCreate(true)}>
              New Project
            </Button>
          }
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {sortedProjects.map((project) => (
            <div key={project.id} className="relative group">
              <Link href={`/projects/${project.id}/dashboard`}>
                <Card className="cursor-pointer transition-all duration-200 hover:shadow-md hover:border-[var(--brand-border)]">
                  <CardBody className="h-full p-5">
                    <div className="flex items-start justify-between">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="inline-flex items-center rounded-md bg-[var(--brand-soft)] px-2 py-0.5 text-[11px] font-bold tracking-wider text-[var(--brand-primary)]">
                            {project.key}
                          </span>
                          {project.isDemo && (
                            <StatusChip tone="warning">Demo</StatusChip>
                          )}
                        </div>
                        <h3 className="mt-2 truncate text-base font-semibold text-[var(--foreground)] group-hover:text-[var(--brand-primary)] transition-colors">
                          {project.name}
                        </h3>
                        {project.description && (
                          <p className="mt-1 line-clamp-2 text-sm text-[var(--muted)]">
                            {project.description}
                          </p>
                        )}
                      </div>
                      <svg className="h-5 w-5 shrink-0 text-[var(--muted-soft)] group-hover:text-[var(--brand-primary)] transition-colors" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
                      </svg>
                    </div>
                    <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-[var(--border-subtle)] pt-3">
                      {(project as ProjectSummary & { settings?: { framework?: string; language?: string } }).settings?.framework && (
                        <StatusChip tone="brand">
                          {(project as ProjectSummary & { settings?: { framework?: string } }).settings?.framework}
                        </StatusChip>
                      )}
                      {(project as ProjectSummary & { settings?: { language?: string } }).settings?.language && (
                        <StatusChip tone="neutral">
                          {(project as ProjectSummary & { settings?: { language?: string } }).settings?.language}
                        </StatusChip>
                      )}
                      <span className="ml-auto text-xs text-[var(--muted)]">
                        {new Date(project.createdAt).toLocaleDateString()}
                      </span>
                    </div>
                  </CardBody>
                </Card>
              </Link>

              {project.isDemo && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setConfirmDeleteDemoId(project.id);
                  }}
                  title="Delete demo project"
                  className="absolute right-2 top-2 z-10 hidden rounded-xl p-1.5 text-[var(--muted)] transition-colors hover:bg-[var(--error-soft)] hover:text-[var(--error)] group-hover:flex focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_oklab,var(--error)_30%,transparent)]"
                >
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
                  </svg>
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Delete demo confirmation modal */}
      {confirmDeleteDemoId && (
        <Modal
          open
          onClose={() => setConfirmDeleteDemoId(null)}
          title="Delete demo project?"
        >
          <p className="text-sm text-[var(--muted)]">
            This will permanently delete the demo project and all its sample data. Your real projects won&apos;t be affected.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setConfirmDeleteDemoId(null)}
              disabled={deletingDemo}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={handleDeleteDemo}
              disabled={deletingDemo}
            >
              {deletingDemo ? "Deleting…" : "Delete Demo Project"}
            </Button>
          </div>
        </Modal>
      )}

      {showCreate && (
        <Modal
          open
          onClose={closeCreateModal}
          title={
            createStep === 1
              ? "Create Grid Project — Step 1 of 2"
              : "Create Grid Project — Step 2 of 2"
          }
        >
          {createStep === 1 ? (
            <form onSubmit={handleStep1Submit} className="space-y-4">
              {error && <Banner tone="error" description={error} />}
              <Field>
                <FieldLabel htmlFor="projectName">Project name</FieldLabel>
                <Input
                  id="projectName"
                  value={createName}
                  onChange={(e) => setCreateName(e.target.value)}
                  placeholder="My Automation Suite"
                  disabled={creating}
                  autoFocus
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="projectKey">
                  Project key (optional)
                </FieldLabel>
                <Input
                  id="projectKey"
                  value={createKey}
                  onChange={(e) =>
                    setCreateKey(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))
                  }
                  placeholder="AUTO"
                  maxLength={8}
                  disabled={creating}
                />
                <FieldHint>
                  Short identifier shown on test runs. Auto-generated from the name if left blank.
                </FieldHint>
              </Field>
              <Field>
                <FieldLabel htmlFor="projectDesc">
                  Description (optional)
                </FieldLabel>
                <Textarea
                  id="projectDesc"
                  value={createDesc}
                  onChange={(e) => setCreateDesc(e.target.value)}
                  rows={2}
                  disabled={creating}
                />
              </Field>
              <div className="flex justify-end gap-2">
                <Button type="button" variant="secondary" onClick={closeCreateModal}>
                  Cancel
                </Button>
                <Button type="submit">Continue</Button>
              </div>
            </form>
          ) : (
            <form onSubmit={handleCreate} className="space-y-4">
              {error && <Banner tone="error" description={error} />}
              <Banner
                tone="brand"
                title="Stack is permanent"
                description="Framework and language can't be changed after the project is created. To use a different stack later, create a new project."
              />

              <SelectorGroup<ProjectFramework>
                label="Test framework"
                value={createFramework}
                onChange={handleFrameworkChange}
                options={FRAMEWORK_OPTIONS}
              />

              <SelectorGroup<ProjectLanguage>
                label="Language"
                value={createLanguage}
                onChange={setCreateLanguage}
                options={LANGUAGE_OPTIONS_BY_FRAMEWORK[createFramework]}
              />

              <SelectorGroup<ProjectBrowser>
                label="Default browser"
                value={createBrowser}
                onChange={setCreateBrowser}
                options={BROWSER_OPTIONS}
              />

              <div className="flex justify-between gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    setError("");
                    setCreateStep(1);
                  }}
                  disabled={creating}
                >
                  Back
                </Button>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={closeCreateModal}
                    disabled={creating}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" disabled={creating}>
                    {creating
                      ? "Creating…"
                      : `Create ${FRAMEWORK_LABEL[createFramework]} project`}
                  </Button>
                </div>
              </div>
            </form>
          )}
        </Modal>
      )}
    </div>
  );
}

export default function ProjectsPage() {
  return (
    <Suspense fallback={
      <div className="space-y-6">
        <div className="skeleton h-8 w-48 rounded-lg" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="skeleton h-40 rounded-[var(--radius-card)]" />
          ))}
        </div>
      </div>
    }>
      <ProjectsPageContent />
    </Suspense>
  );
}
