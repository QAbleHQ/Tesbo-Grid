"use client";

import React, { useEffect, useState, useCallback, use } from "react";
import Link from "next/link";
import {
  allocateWorkspaceAiKeyToProject,
  getProject,
  getProjectAccessKey,
  listWorkspaceAiKeys,
  rotateProjectAccessKey,
  updateProject,
  type ProjectDetail,
  type WorkspaceAiKeysResponse,
} from "@/lib/api";
import {
  Banner,
  Button,
  Card,
  CardBody,
  FieldError,
  Modal,
  Select,
  SelectorGroup,
} from "@/components/ui";

// ─── Types ───────────────────────────────────────────────────────────────────

type Framework = "playwright" | "selenium";
type SeleniumLang = "java" | "python";
type CiProvider = "github" | "jenkins" | "gitlab";

// ─── CodeBlock ───────────────────────────────────────────────────────────────

function CodeBlock({ code, language }: { code: string; language?: string }) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(code.trim());
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const CopyIcon = () => (
    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0 0 13.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 0 1-.75.75H9a.75.75 0 0 1-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 0 1-2.25 2.25H6.75A2.25 2.25 0 0 1 4.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 0 1 1.927-.184" />
    </svg>
  );
  const CheckIcon = () => (
    <svg className="h-3.5 w-3.5 text-[var(--success)]" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
    </svg>
  );

  return (
    <div className="group relative glass-subtle overflow-hidden rounded-xl">
      {language && (
        <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-3 py-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted)]">
            {language}
          </span>
          <button
            type="button"
            onClick={handleCopy}
            className="flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-[var(--muted)] hover:bg-[var(--surface)] hover:text-[var(--foreground)] transition-colors"
          >
            {copied ? <><CheckIcon /><span className="text-[var(--success)]">Copied</span></> : <><CopyIcon />Copy</>}
          </button>
        </div>
      )}
      <div className="relative">
        {!language && (
          <button
            type="button"
            onClick={handleCopy}
            className="absolute right-2 top-2 flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-[var(--muted)] opacity-0 group-hover:opacity-100 hover:bg-[var(--surface)] hover:text-[var(--foreground)] transition-all"
          >
            {copied ? <><CheckIcon /><span className="text-[var(--success)]">Copied</span></> : <><CopyIcon />Copy</>}
          </button>
        )}
        <pre className="overflow-x-auto p-4 text-sm whitespace-pre text-[var(--foreground)]">
          <code>{code}</code>
        </pre>
      </div>
    </div>
  );
}

// ─── CI Tabs ─────────────────────────────────────────────────────────────────

const CI_TABS: { id: CiProvider; label: string }[] = [
  { id: "github", label: "GitHub Actions" },
  { id: "jenkins", label: "Jenkins" },
  { id: "gitlab", label: "GitLab CI" },
];

function CiSection({
  framework,
  seleniumLang,
  accessKey,
  keyVisible,
}: {
  framework: Framework;
  seleniumLang: SeleniumLang;
  accessKey: string | null;
  keyVisible: boolean;
}) {
  const [active, setActive] = useState<CiProvider>("github");
  const keyPlaceholder = accessKey && keyVisible ? accessKey : "<your-access-key>";
  const isSelenium = framework === "selenium";
  const isJava = isSelenium && seleniumLang === "java";
  const isPython = isSelenium && seleniumLang === "python";

  // ── CI YAML per combination ──────────────────────────────────────────────

  const githubYaml = isJava
    ? `name: Tesbo Grid Tests

on:
  push:
    branches: [main]
  pull_request:

jobs:
  tesbo:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-java@v4
        with:
          java-version: '17'
          distribution: 'temurin'

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install Tesbo CLI
        run: npm install -g @tesbox/cli

      - name: Run Selenium Java tests on Tesbo Grid
        env:
          TESBOX_API_KEY: \${{ secrets.TESBOX_API_KEY }}
        run: |
          npx tesbox run "src/test/**/*.java" \\
            --framework selenium \\
            --language java \\
            --browser chrome \\
            --start-url https://your-app.com`
    : isPython
    ? `name: Tesbo Grid Tests

on:
  push:
    branches: [main]
  pull_request:

jobs:
  tesbo:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install Tesbo CLI
        run: npm install -g @tesbox/cli

      - name: Run Selenium Python tests on Tesbo Grid
        env:
          TESBOX_API_KEY: \${{ secrets.TESBOX_API_KEY }}
        run: |
          npx tesbox run "tests/test_*.py" \\
            --framework selenium \\
            --language python \\
            --browser chrome \\
            --start-url https://your-app.com`
    : `name: Tesbo Grid Tests

on:
  push:
    branches: [main]
  pull_request:

jobs:
  tesbo:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install dependencies
        run: npm ci

      - name: Run tests on Tesbo Grid
        env:
          TESBOX_API_KEY: \${{ secrets.TESBOX_API_KEY }}
        run: |
          npm install -g @tesbox/cli
          npx tesbox run --spec ./tests/**/*.spec.ts \\
            --execution-mode project`;

  const jenkinsfile = isJava
    ? `pipeline {
  agent any

  environment {
    TESBOX_API_KEY = credentials('tesbox-api-key')
  }

  tools {
    jdk 'jdk17'
    maven 'maven3'
    nodejs 'node20'
  }

  stages {
    stage('Install CLI') {
      steps {
        sh 'npm install -g @tesbox/cli'
      }
    }

    stage('Run Tesbo Grid Tests') {
      steps {
        sh '''
          npx tesbox run "src/test/**/*.java" \\
            --framework selenium \\
            --language java \\
            --browser chrome \\
            --start-url https://your-app.com
        '''
      }
    }
  }

  post {
    always {
      echo "Test run complete — view results in Tesbo Grid dashboard"
    }
  }
}`
    : isPython
    ? `pipeline {
  agent any

  environment {
    TESBOX_API_KEY = credentials('tesbox-api-key')
  }

  tools {
    nodejs 'node20'
  }

  stages {
    stage('Setup') {
      steps {
        sh 'python3 -m pip install --upgrade pip'
        sh 'npm install -g @tesbox/cli'
      }
    }

    stage('Run Tesbo Grid Tests') {
      steps {
        sh '''
          npx tesbox run "tests/test_*.py" \\
            --framework selenium \\
            --language python \\
            --browser chrome \\
            --start-url https://your-app.com
        '''
      }
    }
  }

  post {
    always {
      echo "Test run complete — view results in Tesbo Grid dashboard"
    }
  }
}`
    : `pipeline {
  agent any

  environment {
    TESBOX_API_KEY = credentials('tesbox-api-key')
  }

  stages {
    stage('Install') {
      steps {
        sh 'npm ci'
        sh 'npm install -g @tesbox/cli'
      }
    }

    stage('Run Tesbo Grid Tests') {
      steps {
        sh '''
          npx tesbox run --spec ./tests/**/*.spec.ts \\
            --execution-mode project
        '''
      }
    }
  }

  post {
    always {
      echo "Test run complete — view results in Tesbo Grid dashboard"
    }
  }
}`;

  const gitlabYaml = isJava
    ? `tesbo-grid:
  image: maven:3.9-eclipse-temurin-17
  stage: test
  before_script:
    - curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    - apt-get install -y nodejs
    - npm install -g @tesbox/cli
  script:
    - npx tesbox run "src/test/**/*.java"
        --framework selenium
        --language java
        --browser chrome
        --start-url https://your-app.com
  variables:
    TESBOX_API_KEY: $TESBOX_API_KEY
  only:
    - main
    - merge_requests`
    : isPython
    ? `tesbo-grid:
  image: python:3.12-slim
  stage: test
  before_script:
    - apt-get update -qq && apt-get install -y nodejs npm
    - npm install -g @tesbox/cli
  script:
    - npx tesbox run "tests/test_*.py"
        --framework selenium
        --language python
        --browser chrome
        --start-url https://your-app.com
  variables:
    TESBOX_API_KEY: $TESBOX_API_KEY
  only:
    - main
    - merge_requests`
    : `tesbo-grid:
  image: node:20
  stage: test
  script:
    - npm ci
    - npm install -g @tesbox/cli
    - npx tesbox run --spec ./tests/**/*.spec.ts
        --execution-mode project
  variables:
    TESBOX_API_KEY: $TESBOX_API_KEY
  only:
    - main
    - merge_requests`;

  const secretInstructions: Record<CiProvider, React.ReactNode> = {
    github: (
      <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-secondary)] p-3 space-y-1">
        <p className="text-xs font-semibold text-[var(--foreground)]">Add the secret to GitHub</p>
        <ol className="text-xs text-[var(--muted)] list-decimal list-inside space-y-0.5">
          <li>Go to your repo → <strong>Settings → Secrets and variables → Actions</strong></li>
          <li>Click <strong>New repository secret</strong></li>
          <li>Name: <code className="font-mono text-[11px]">TESBOX_API_KEY</code></li>
          <li>Value: <code className="font-mono text-[11px] break-all">{keyPlaceholder}</code></li>
        </ol>
      </div>
    ),
    jenkins: (
      <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-secondary)] p-3 space-y-1">
        <p className="text-xs font-semibold text-[var(--foreground)]">Add the credential to Jenkins</p>
        <ol className="text-xs text-[var(--muted)] list-decimal list-inside space-y-0.5">
          <li>Go to <strong>Manage Jenkins → Credentials → Global</strong></li>
          <li>Click <strong>Add Credentials</strong> → Kind: <em>Secret text</em></li>
          <li>ID: <code className="font-mono text-[11px]">tesbox-api-key</code></li>
          <li>Secret: <code className="font-mono text-[11px] break-all">{keyPlaceholder}</code></li>
        </ol>
      </div>
    ),
    gitlab: (
      <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-secondary)] p-3 space-y-1">
        <p className="text-xs font-semibold text-[var(--foreground)]">Add the variable to GitLab</p>
        <ol className="text-xs text-[var(--muted)] list-decimal list-inside space-y-0.5">
          <li>Go to your project → <strong>Settings → CI/CD → Variables</strong></li>
          <li>Click <strong>Add variable</strong></li>
          <li>Key: <code className="font-mono text-[11px]">TESBOX_API_KEY</code>, check <strong>Masked</strong></li>
          <li>Value: <code className="font-mono text-[11px] break-all">{keyPlaceholder}</code></li>
        </ol>
      </div>
    ),
  };

  const codeMap: Record<CiProvider, { language: string; code: string; filename: string }> = {
    github: { language: "yaml", code: githubYaml, filename: ".github/workflows/tesbo.yml" },
    jenkins: { language: "groovy", code: jenkinsfile, filename: "Jenkinsfile — place in the root of your repo" },
    gitlab: { language: "yaml", code: gitlabYaml, filename: ".gitlab-ci.yml" },
  };

  return (
    <div className="space-y-4">
      <div className="flex gap-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-secondary)] p-1 w-fit">
        {CI_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActive(tab.id)}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              active === tab.id
                ? "bg-[var(--surface)] text-[var(--foreground)] shadow-sm"
                : "text-[var(--muted)] hover:text-[var(--foreground)]"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {secretInstructions[active]}

      <div>
        <p className="text-xs font-semibold text-[var(--foreground)] mb-1.5">
          {codeMap[active].filename}
        </p>
        <CodeBlock language={codeMap[active].language} code={codeMap[active].code} />
      </div>

      <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface)] p-3 space-y-1.5">
        <p className="text-xs font-semibold text-[var(--foreground)]">Tips</p>
        <ul className="space-y-1 text-xs text-[var(--muted)] list-disc list-inside">
          <li>Store <code className="font-mono text-[11px]">TESBOX_API_KEY</code> as a CI secret — never hard-code it in your workflow file.</li>
          <li>The CLI exits with a non-zero code when tests fail, so your pipeline will correctly mark the build as failed.</li>
          <li>Results stream to your Tesbo Grid dashboard in real time — no need to parse report files or upload artifacts separately.</li>
          {isJava && <li>Make sure <strong>JDK 17</strong> and <strong>Maven 3.x</strong> are available in the build environment.</li>}
          {isPython && <li>The worker auto-installs <code className="font-mono text-[11px]">requirements.txt</code> before running — no pre-install step needed inside the worker.</li>}
          {!isSelenium && <li>Your access key already resolves the target project — no <code className="font-mono text-[11px]">TESBOX_PROJECT_ID</code> needed.</li>}
        </ul>
      </div>
    </div>
  );
}

// ─── Playwright Setup Steps ───────────────────────────────────────────────────

function PlaywrightSteps({ accessKey, keyVisible }: { accessKey: string | null; keyVisible: boolean }) {
  const key = accessKey ? (keyVisible ? accessKey : "<your-access-key>") : "<your-access-key>";

  return (
    <div className="space-y-6">
      <Card>
        <CardBody className="p-6">
          <h2 className="text-lg font-semibold text-[var(--foreground)] mb-4">
            Step 3 — Install &amp; run
          </h2>
          <div className="space-y-5">
            <div>
              <h3 className="text-sm font-semibold text-[var(--foreground)] mb-1">Install the CLI</h3>
              <CodeBlock language="bash" code="npm install -g @tesbox/cli" />
            </div>

            <div className="rounded-lg border border-[var(--warning-border)] bg-[var(--warning-soft)] p-4 space-y-2">
              <div className="flex items-start gap-2">
                <svg className="mt-0.5 h-4 w-4 shrink-0 text-[var(--warning)]" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
                </svg>
                <div className="space-y-1">
                  <p className="text-xs font-semibold text-[var(--warning-foreground)]">
                    If your project has a <code className="font-mono">playwright.config.ts</code> — use project mode
                  </p>
                  <p className="text-xs text-[var(--warning-foreground)] leading-relaxed opacity-90">
                    By default the CLI runs in <code className="font-mono text-[11px] rounded bg-[var(--warning)]/15 px-1">auto</code> mode
                    which ships each test as a standalone script without your config file.
                    Settings like <code className="font-mono text-[11px] rounded bg-[var(--warning)]/15 px-1">baseURL</code>, timeouts, and browser devices are <strong>not</strong> sent to workers.
                    Add <code className="font-mono text-[11px] rounded bg-[var(--warning)]/15 px-1">--execution-mode project</code> to bundle your entire project including the config.
                  </p>
                </div>
              </div>
            </div>

            <div>
              <h3 className="text-sm font-semibold text-[var(--foreground)] mb-1">
                Run your tests (recommended — honours your playwright.config.ts)
              </h3>
              <p className="text-xs text-[var(--muted)] mb-2">Your access key already resolves this project — no project ID needed.</p>
              <CodeBlock language="bash" code={`npx tesbox run --spec ./tests/**/*.spec.ts \\\n  --api-key ${key} \\\n  --execution-mode project`} />
            </div>

            <div>
              <h3 className="text-sm font-semibold text-[var(--foreground)] mb-1">
                Self-contained specs (no playwright.config.ts dependency)
              </h3>
              <p className="text-xs text-[var(--muted)] mb-2">If your tests don&apos;t use a config file, pass the base URL directly:</p>
              <CodeBlock language="bash" code={`npx tesbox run --spec ./tests/**/*.spec.ts \\\n  --api-key ${key} \\\n  --start-url https://your-app.com`} />
            </div>

            <div>
              <h3 className="text-sm font-semibold text-[var(--foreground)] mb-1">Or use an environment variable</h3>
              <CodeBlock language=".env" code={`TESBOX_API_KEY=${key}`} />
              <p className="mt-2 text-xs text-[var(--muted)]">
                Then run: <code className="text-[var(--foreground)]">npx tesbox run &quot;tests/**/*.spec.ts&quot; --execution-mode project</code>
              </p>
            </div>

            <div>
              <h3 className="text-sm font-semibold text-[var(--foreground)] mb-2">Execution modes explained</h3>
              <div className="space-y-2">
                {[
                  { flag: "--execution-mode project", desc: <>Bundles the entire project including <code className="font-mono text-[11px]">playwright.config.ts</code>, fixtures, and helpers. <strong className="text-[var(--foreground)]">Recommended for most projects.</strong></> },
                  { flag: "--execution-mode auto", desc: <>Default. Detects relative imports and bundles only when found. Does <strong>not</strong> detect config file usage — tests that rely on <code className="font-mono text-[11px]">baseURL</code> or device settings will fail.</> },
                  { flag: "--execution-mode script", desc: <>Always sends tests as standalone scripts. Only suitable for fully self-contained specs with no config, fixture, or helper dependencies.</> },
                ].map(({ flag, desc }) => (
                  <div key={flag} className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-secondary)] p-3 space-y-1">
                    <code className="text-xs font-mono text-[var(--foreground)]">{flag}</code>
                    <p className="text-xs text-[var(--muted)]">{desc}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </CardBody>
      </Card>

      {/* Config recommendations */}
      <Card>
        <CardBody className="p-6">
          <h2 className="text-lg font-semibold text-[var(--foreground)] mb-1">
            Step 4 — Run in CI
          </h2>
          <p className="text-sm text-[var(--muted)] mb-5">
            Add Tesbo Grid to your pipeline so every push or pull request runs your full test suite on the grid automatically.
          </p>
          <CiSection framework="playwright" seleniumLang="java" accessKey={accessKey} keyVisible={keyVisible} />
        </CardBody>
      </Card>

      <Card>
        <CardBody className="p-6">
          <h2 className="text-lg font-semibold text-[var(--foreground)] mb-1">
            Step 5 — playwright.config.ts recommended settings
          </h2>
          <p className="text-sm text-[var(--muted)] mb-4">
            When using <code className="font-mono text-xs rounded bg-[var(--surface-secondary)] px-1">--execution-mode project</code>, your entire config is sent to workers. Use these settings to get useful debug artifacts whenever a test fails.
          </p>
          <CodeBlock
            language="typescript"
            code={`// playwright.config.ts
export default defineConfig({
  use: {
    baseURL: "https://your-app.com",  // required — page.goto("/") needs this

    // Capture artifacts on every failure (not just retries)
    video: "retain-on-failure",       // change from "on-first-retry"
    screenshot: "only-on-failure",
    trace: "retain-on-failure",       // change from "on-first-retry"

    navigationTimeout: 60_000,
    actionTimeout: 15_000,
  },
});`}
          />
          <div className="mt-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface)] p-3 space-y-1">
            <p className="text-xs font-semibold text-[var(--foreground)]">Why this matters</p>
            <ul className="space-y-1 text-xs text-[var(--muted)] list-disc list-inside">
              <li><code className="font-mono text-[11px]">video: &quot;on-first-retry&quot;</code> only records during a retry — if retries are 0, you get no video at all.</li>
              <li><code className="font-mono text-[11px]">retain-on-failure</code> records for every failing test, giving you a full debug artifact every time.</li>
              <li><code className="font-mono text-[11px]">baseURL</code> is required if any test uses <code className="font-mono text-[11px]">page.goto(&quot;/&quot;)</code> or other relative paths.</li>
            </ul>
          </div>
        </CardBody>
      </Card>

      {/* Troubleshooting */}
      <Card>
        <CardBody className="p-6">
          <h2 className="text-lg font-semibold text-[var(--foreground)] mb-4">Troubleshooting</h2>
          <div className="space-y-4">
            {[
              {
                title: "All tests fail with a blank browser / blank video",
                body: <>The CLI ran in <code className="font-mono text-[11px]">script</code> mode. Your <code className="font-mono text-[11px]">playwright.config.ts</code> was not sent to the workers, so there is no <code className="font-mono text-[11px]">baseURL</code>.</>,
                fix: `npx tesbox run "tests/**/*.spec.ts" --execution-mode project`,
              },
              {
                title: "Tests fail in under 5 seconds with a navigation or URL error",
                body: <><code className="font-mono text-[11px]">page.goto(&quot;/&quot;)</code> requires a <code className="font-mono text-[11px]">baseURL</code>. Without a config file on the worker, the path is not a valid URL.</>,
                fix: `npx tesbox run "tests/**/*.spec.ts" --execution-mode project`,
              },
              {
                title: "No video recorded for failed tests",
                body: <><code className="font-mono text-[11px]">video: &quot;on-first-retry&quot;</code> only records during a retry. If <code className="font-mono text-[11px]">retries</code> is 0, no video is ever saved.</>,
                fix: `video: "retain-on-failure",   // was "on-first-retry"\ntrace: "retain-on-failure",   // was "on-first-retry"`,
              },
              {
                title: "Tests pass locally but fail on Tesbo Grid",
                body: <>Your local run uses <code className="font-mono text-[11px]">playwright.config.ts</code>; the grid worker does not (in <code className="font-mono text-[11px]">auto</code> or <code className="font-mono text-[11px]">script</code> mode). Device profiles, timeouts, fixtures, and custom reporters are all config-dependent.</>,
                fix: `npx tesbox run "tests/**/*.spec.ts" --execution-mode project`,
              },
            ].map(({ title, body, fix }) => (
              <div key={title} className="rounded-lg border border-[var(--border-subtle)] p-4 space-y-2">
                <div className="flex items-start gap-2">
                  <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--error)]/10 text-[10px] font-bold text-[var(--error)]">!</span>
                  <p className="text-sm font-semibold text-[var(--foreground)]">{title}</p>
                </div>
                <p className="text-xs text-[var(--muted)] leading-relaxed pl-7">{body}</p>
                <div className="pl-7">
                  <p className="text-xs font-semibold text-[var(--foreground)] mb-1">Fix</p>
                  <CodeBlock code={fix} />
                </div>
              </div>
            ))}
          </div>
        </CardBody>
      </Card>
    </div>
  );
}

// ─── Direct Grid URL section (Selenium only) ─────────────────────────────────
//
// Lets users point their existing Selenium suite at the authenticated
// Selenium Grid endpoint (NEXT_PUBLIC_SELENIUM_GRID_DOMAIN) without using
// the `npx tesbox` managed flow.
// The grid-selenium-proxy validates the access key, so the URL embeds the
// project id (basic-auth username) + the project's access key.

function DirectGridUrlSection({
  projectId,
  language,
  accessKey,
  keyVisible,
}: {
  projectId: string;
  language: SeleniumLang;
  accessKey: string | null;
  keyVisible: boolean;
}) {
  const gridDomain =
    process.env.NEXT_PUBLIC_SELENIUM_GRID_DOMAIN || "localhost:4444";
  const keyPlaceholder = accessKey && keyVisible ? accessKey : "<your-access-key>";
  const remoteUrl = `https://${projectId}:${keyPlaceholder}@${gridDomain}/wd/hub`;

  const javaSnippet = `// Point your existing RemoteWebDriver at Tesbo Grid.
// SELENIUM_REMOTE_URL is read by the WebDriver client when no
// command_executor is passed explicitly.
String remote = System.getenv("SELENIUM_REMOTE_URL");
ChromeOptions options = new ChromeOptions();
options.addArguments("--headless=new", "--no-sandbox", "--disable-dev-shm-usage");

// Attach Tesbo metadata so this Selenium session is correlated with the
// matching test row in the report dashboard. \`build\` MUST equal the
// TESBO_BUILD_ID env var that \`tesbox grid-run\` injects — that's how the
// backend joins each test method to the session that produced its
// screenshots/video. \`name\` should equal the TestNG \`<class>.<method>\`
// (e.g. set it inside @BeforeMethod from the ITestResult).
Map<String, Object> tesboOptions = Map.of(
    "build", System.getenv().getOrDefault("TESBO_BUILD_ID", "local"),
    "name",  testName
);
options.setCapability("tesbo:options", tesboOptions);

WebDriver driver = new RemoteWebDriver(URI.create(remote).toURL(), options);`;

  const pythonSnippet = `# Point your existing webdriver.Remote at Tesbo Grid.
import os
from selenium import webdriver
from selenium.webdriver.chrome.options import Options as ChromeOptions

remote = os.environ["SELENIUM_REMOTE_URL"]
options = ChromeOptions()
options.add_argument("--headless=new")
options.add_argument("--no-sandbox")
options.add_argument("--disable-dev-shm-usage")

# Attach Tesbo metadata so this Selenium session is correlated with the
# matching test row in the report dashboard. \`build\` MUST equal the
# TESBO_BUILD_ID env var that \`tesbox grid-run\` injects — that's how the
# backend joins each test to the session that produced its artifacts.
# \`name\` should equal the pytest nodeid (e.g. set it inside a fixture).
options.set_capability("tesbo:options", {
    "build": os.environ.get("TESBO_BUILD_ID", "local"),
    "name":  test_name,
})

driver = webdriver.Remote(command_executor=remote, options=options)`;

  const githubYaml = `# .github/workflows/selenium-on-tesbo-grid.yml
name: Selenium on Tesbo Grid
on:
  push:
    branches: [main]
  pull_request:

jobs:
  ${language === "java" ? "selenium-java" : "selenium-python"}:
    runs-on: ubuntu-latest
    env:
      SELENIUM_REMOTE_URL: \${{ secrets.SELENIUM_REMOTE_URL }}
    steps:
      - uses: actions/checkout@v4
${
  language === "java"
    ? `      - uses: actions/setup-java@v4
        with:
          java-version: '17'
          distribution: 'temurin'
      - name: Run TestNG suite
        run: mvn -B test`
    : `      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'
      - name: Install dependencies
        run: pip install -r requirements.txt
      - name: Run pytest suite
        run: pytest -q`
}`;

  return (
    <Card>
      <CardBody className="p-6">
        <div className="flex items-center gap-2 mb-1">
          <h2 className="text-lg font-semibold text-[var(--foreground)]">
            Direct Grid URL — run from your CI
          </h2>
          <span className="rounded-full border border-[var(--brand-border)] bg-[var(--brand-soft)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--brand-primary)]">
            Vendor-style
          </span>
        </div>
        <p className="text-sm text-[var(--muted)] mb-4">
          Use this when you want to keep running your existing Selenium suite locally or
          in your own CI, but offload the browser to Tesbo Grid. The grid is public,
          authenticated by your project access key, and tracks every session.
        </p>

        <div className="space-y-5">
          <div>
            <h3 className="text-sm font-semibold text-[var(--foreground)] mb-1.5">
              Set <code className="font-mono">SELENIUM_REMOTE_URL</code>
            </h3>
            <CodeBlock language="bash" code={`export SELENIUM_REMOTE_URL="${remoteUrl}"`} />
            <div className="mt-2 grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
              <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-secondary)] p-2.5">
                <p className="font-semibold text-[var(--foreground)]">Project id</p>
                <code className="font-mono text-[11px] break-all text-[var(--muted)]">
                  {projectId}
                </code>
              </div>
              <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-secondary)] p-2.5">
                <p className="font-semibold text-[var(--foreground)]">Access key</p>
                <code className="font-mono text-[11px] break-all text-[var(--muted)]">
                  {accessKey
                    ? keyVisible
                      ? accessKey
                      : "••••••••••••"
                    : "<your-access-key>"}
                </code>
              </div>
              <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-secondary)] p-2.5">
                <p className="font-semibold text-[var(--foreground)]">Grid domain</p>
                <code className="font-mono text-[11px] text-[var(--muted)]">
                  {gridDomain}
                </code>
              </div>
            </div>
            <p className="mt-2 text-xs text-[var(--muted)]">
              Treat <code className="font-mono text-[11px]">SELENIUM_REMOTE_URL</code> as
              a secret — it carries your access key in the basic-auth slot.
            </p>
          </div>

          <div>
            <h3 className="text-sm font-semibold text-[var(--foreground)] mb-1.5">
              Update your test bootstrap
            </h3>
            <CodeBlock
              language={language === "java" ? "java" : "python"}
              code={language === "java" ? javaSnippet : pythonSnippet}
            />
          </div>

          <div>
            <h3 className="text-sm font-semibold text-[var(--foreground)] mb-1.5">
              CI example
            </h3>
            <CodeBlock language="yaml" code={githubYaml} />
            <p className="mt-2 text-xs text-[var(--muted)]">
              Store <code className="font-mono text-[11px]">SELENIUM_REMOTE_URL</code> in
              your CI secret store (e.g. <strong>Settings → Secrets and variables →
              Actions</strong>) — the value is the full
              <code className="font-mono text-[11px]"> https://&lt;projectId&gt;:&lt;key&gt;@…/wd/hub</code> URL
              shown above.
            </p>
          </div>

          <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface)] p-3 space-y-1.5">
            <p className="text-xs font-semibold text-[var(--foreground)]">Tips</p>
            <ul className="space-y-1 text-xs text-[var(--muted)] list-disc list-inside">
              <li>Concurrent sessions are capped per project — tune in workspace settings.</li>
              <li>Custom browser binaries and capabilities like <code className="font-mono text-[11px]">--user-data-dir</code> are stripped at the proxy.</li>
              <li>Every session is recorded — find the videos under the Live Sessions view.</li>
              <li>For long suites, the LB idle timeout is 600s — keep individual commands under that.</li>
            </ul>
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

// ─── Selenium mode switcher ──────────────────────────────────────────────────
//
// For Selenium projects we ship two modes side-by-side: the managed `npx tesbox`
// CLI (bundles + runs your tests on Tesbo workers) and the Direct Grid URL
// (point your existing suite at the authenticated grid LB). Pick once at the
// top of the guide; the rest of the page is the same regardless of the
// project language.

type SeleniumMode = "managed" | "direct";

function SeleniumModeTabs({
  active,
  onChange,
}: {
  active: SeleniumMode;
  onChange: (mode: SeleniumMode) => void;
}) {
  const tabs: { id: SeleniumMode; label: string; description: string }[] = [
    {
      id: "managed",
      label: "Managed CLI",
      description: "Tesbo bundles & runs your suite — zero infra setup.",
    },
    {
      id: "direct",
      label: "Direct Grid URL",
      description: "Point your existing RemoteWebDriver at your Selenium Grid endpoint.",
    },
  ];
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {tabs.map((tab) => {
        const selected = active === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onChange(tab.id)}
            className={`flex flex-col items-start gap-1 rounded-xl border px-4 py-3 text-left transition-colors ${
              selected
                ? "border-[var(--brand-border)] bg-[var(--brand-soft)]"
                : "border-[var(--border-subtle)] bg-[var(--surface)] hover:border-[var(--brand-border)]"
            }`}
          >
            <span
              className={`text-sm font-semibold ${
                selected ? "text-[var(--brand-primary)]" : "text-[var(--foreground)]"
              }`}
            >
              {tab.label}
            </span>
            <span className="text-xs text-[var(--muted)]">{tab.description}</span>
          </button>
        );
      })}
    </div>
  );
}

// ─── Session-linking docs (framework-agnostic) ───────────────────────────────

type LinkLang = "java-helper" | "java-inline" | "python" | "javascript";

function SessionLinkingDocs({ defaultLang = "java-helper" }: { defaultLang?: LinkLang }) {
  const [lang, setLang] = useState<LinkLang>(defaultLang);

  // The drop-in helper is the same source we ship with the Tesbo testing-main
  // template; users can paste it into any project unchanged. Any change here
  // should be mirrored in:
  //   nevvon/testing-main/src/main/java/io/unity/framework/remotegrid/TesboCapabilities.java
  const helperSource = `// TesboCapabilities.java
//
// Drop this single file into ANY project that talks to a Tesbo grid
// (TestNG, JUnit, Cucumber, plain main(), ...). No extra dependencies
// required beyond Selenium itself.
//
// What it sets on the capabilities:
//   "tesbo:options": { "build": "<id>", "name": "<Class>.<method>" }
//
// Where <id> comes from (in order):
//   1. TESBO_BUILD_ID environment variable (exported by \`tesbox grid-run\`)
//   2. -Dtesbo.build.id=... JVM system property
//   3. value previously passed to TesboCapabilities.setDefaultBuild(...)
//   4. literal "local"
package your.package.helpers;

import org.openqa.selenium.MutableCapabilities;
import org.openqa.selenium.remote.DesiredCapabilities;

import java.lang.reflect.Method;
import java.util.HashMap;
import java.util.Map;

public final class TesboCapabilities {
    public static final String CAPABILITY_KEY = "tesbo:options";
    public static final String BUILD_ENV       = "TESBO_BUILD_ID";
    public static final String BUILD_SYS_PROP  = "tesbo.build.id";
    public static final String BUILD_FALLBACK  = "local";

    private static volatile String defaultBuild = null;

    private TesboCapabilities() {}

    public static void setDefaultBuild(String build) {
        if (build == null || build.trim().isEmpty()) return;
        defaultBuild = build.trim();
    }

    public static void apply(MutableCapabilities capabilities, String testName) {
        if (capabilities == null) return;
        Map<String, Object> tesbo = mergeWithExisting(capabilities.getCapability(CAPABILITY_KEY));
        tesbo.put("build", buildId());
        if (testName != null && !testName.trim().isEmpty()) {
            tesbo.put("name", testName.trim());
        }
        capabilities.setCapability(CAPABILITY_KEY, tesbo);
    }

    public static void apply(DesiredCapabilities capabilities, String testName) {
        apply((MutableCapabilities) capabilities, testName);
    }

    public static String testNameFor(Method method) {
        if (method == null) return null;
        return method.getDeclaringClass().getSimpleName() + "." + method.getName();
    }

    public static String buildId() {
        String fromEnv = System.getenv(BUILD_ENV);
        if (fromEnv != null && !fromEnv.trim().isEmpty()) return fromEnv.trim();
        String fromSys = System.getProperty(BUILD_SYS_PROP);
        if (fromSys != null && !fromSys.trim().isEmpty()) return fromSys.trim();
        if (defaultBuild != null) return defaultBuild;
        return BUILD_FALLBACK;
    }

    private static Map<String, Object> mergeWithExisting(Object existing) {
        Map<String, Object> out = new HashMap<>();
        if (existing instanceof Map) {
            for (Map.Entry<?, ?> e : ((Map<?, ?>) existing).entrySet()) {
                out.put(String.valueOf(e.getKey()), e.getValue());
            }
        }
        return out;
    }
}`;

  const helperUsage = `// Usage in any TestNG @BeforeMethod (or JUnit @BeforeEach with the
// equivalent rule). The Method param is injected by TestNG automatically.
import your.package.helpers.TesboCapabilities;
import java.lang.reflect.Method;

@BeforeMethod(alwaysRun = true)
public void setUp(Method testMethod) throws Exception {
    ChromeOptions opts = new ChromeOptions();
    opts.addArguments("--headless=new", "--no-sandbox");

    // ONE LINE — tags this WebDriver session with build + <Class>.<method>.
    TesboCapabilities.apply(opts, TesboCapabilities.testNameFor(testMethod));

    driver = new RemoteWebDriver(URI.create(System.getenv("SELENIUM_REMOTE_URL")).toURL(), opts);
}`;

  const javaInline = `// No helper file — paste these 5 lines directly into your @BeforeMethod.
// Same effect as the helper, but you'll repeat it in every framework class.
import java.lang.reflect.Method;
import java.util.HashMap;
import java.util.Map;

@BeforeMethod(alwaysRun = true)
public void setUp(Method testMethod) throws Exception {
    ChromeOptions opts = new ChromeOptions();
    opts.addArguments("--headless=new", "--no-sandbox");

    // ── Tesbo session ⇄ test-row correlation ─────────────────────────
    Map<String, Object> tesbo = new HashMap<>();
    String buildId = System.getenv("TESBO_BUILD_ID");
    tesbo.put("build", (buildId == null || buildId.isBlank()) ? "local" : buildId);
    tesbo.put("name",  testMethod.getDeclaringClass().getSimpleName()
                      + "." + testMethod.getName());
    opts.setCapability("tesbo:options", tesbo);

    driver = new RemoteWebDriver(URI.create(System.getenv("SELENIUM_REMOTE_URL")).toURL(), opts);
}`;

  const pythonSnippet = `# conftest.py — works for any pytest project that talks to Tesbo Grid.
# Pytest exposes the test nodeid via the \`request\` fixture; we use that
# as the Tesbo session name so each request can be matched to its row.
import os
import pytest
from selenium import webdriver
from selenium.webdriver.chrome.options import Options as ChromeOptions

@pytest.fixture
def driver(request):
    opts = ChromeOptions()
    opts.add_argument("--headless=new")
    opts.add_argument("--no-sandbox")

    # ── Tesbo session ⇄ test-row correlation ─────────────────────────
    opts.set_capability("tesbo:options", {
        "build": os.environ.get("TESBO_BUILD_ID", "local"),
        # request.node.nodeid -> "tests/test_login.py::test_signin"
        "name":  request.node.nodeid,
    })

    drv = webdriver.Remote(
        command_executor=os.environ["SELENIUM_REMOTE_URL"],
        options=opts,
    )
    yield drv
    drv.quit()`;

  const jsSnippet = `// Mocha / WebdriverIO / plain selenium-webdriver — same idea.
// Set tesbo:options on the capabilities before building the session.
import { Builder, Capabilities } from "selenium-webdriver";
import { Options as ChromeOptions } from "selenium-webdriver/chrome.js";

beforeEach(async function () {
  const opts = new ChromeOptions().addArguments(
    "--headless=new",
    "--no-sandbox",
  );

  // ── Tesbo session ⇄ test-row correlation ─────────────────────────
  opts.set("tesbo:options", {
    build: process.env.TESBO_BUILD_ID || "local",
    // \`this.currentTest.fullTitle()\` -> "Login > rejects bad creds"
    name: this.currentTest?.fullTitle() ?? this.currentTest?.title ?? "anonymous",
  });

  this.driver = await new Builder()
    .usingServer(process.env.SELENIUM_REMOTE_URL)
    .withCapabilities(Capabilities.chrome().merge(opts))
    .build();
});`;

  const code =
    lang === "java-helper" ? helperUsage :
    lang === "java-inline" ? javaInline :
    lang === "python" ? pythonSnippet :
    jsSnippet;

  const langLabel: Record<LinkLang, string> = {
    "java-helper": "java",
    "java-inline": "java",
    python: "python",
    javascript: "javascript",
  };

  const tabs: { id: LinkLang; label: string; sub: string }[] = [
    { id: "java-helper", label: "Java — drop-in helper", sub: "TestNG / JUnit / Cucumber" },
    { id: "java-inline", label: "Java — inline", sub: "no extra file" },
    { id: "python", label: "Python — pytest", sub: "any pytest project" },
    { id: "javascript", label: "JavaScript — mocha / wdio", sub: "selenium-webdriver" },
  ];

  return (
    <Card>
      <CardBody className="p-6">
        <div className="flex items-center gap-2 mb-1">
          <h2 className="text-lg font-semibold text-[var(--foreground)]">
            Link sessions to test results
          </h2>
          <span className="rounded-full border border-[var(--brand-border)] bg-[var(--brand-soft)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--brand-primary)]">
            Recommended
          </span>
        </div>
        <p className="text-sm text-[var(--muted)] mb-4">
          Tag each WebDriver session with <code className="font-mono text-xs">tesbo:options.&#123;build,name&#125;</code>{" "}
          so the report dashboard can jump from a failed test row straight to its live VNC stream,
          its session recording, and its WebDriver command timeline. Works the same way in any
          test framework — TestNG, JUnit, Cucumber, pytest, mocha, or anything that lets you set
          Selenium capabilities.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-5">
          {[
            { title: "Live VNC", desc: "While the session is still active, click into a tab to watch the browser in real time." },
            { title: "Session recording", desc: "After the session ends, the same row links the post-mortem mp4 of the entire run." },
            { title: "Command timeline", desc: "Open the command modal to step through every WebDriver call the test made — request, response, duration." },
          ].map(({ title, desc }) => (
            <div key={title} className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-secondary)] p-3">
              <p className="text-xs font-semibold text-[var(--foreground)] mb-1">{title}</p>
              <p className="text-[11px] leading-relaxed text-[var(--muted)]">{desc}</p>
            </div>
          ))}
        </div>

        <div className="mb-4 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-secondary)] p-3 text-xs">
          <p className="font-semibold text-[var(--foreground)] mb-1">How the link is computed</p>
          <ol className="list-decimal pl-5 space-y-1 text-[var(--muted)] leading-relaxed">
            <li>
              Your @BeforeMethod / fixture sets{" "}
              <code className="font-mono text-[11px]">tesbo:options.build</code> = the
              build id and{" "}
              <code className="font-mono text-[11px]">tesbo:options.name</code> = a stable
              per-test identifier (e.g. <em>Class.method</em>).
            </li>
            <li>
              <code className="font-mono text-[11px]">grid-selenium-proxy</code> persists those
              fields on the <code className="font-mono text-[11px]">selenium_sessions</code> row
              when the session is created.
            </li>
            <li>
              When <code className="font-mono text-[11px]">tesbox</code> uploads the report, the
              backend joins each test method back to its session by{" "}
              <code className="font-mono text-[11px]">(project_id, build, name)</code> and
              writes the link onto the <code className="font-mono text-[11px]">report_tests</code>{" "}
              row. No explicit tagging? It falls back to a time-window heuristic per build.
            </li>
          </ol>
        </div>

        <div>
          <p className="text-xs font-semibold text-[var(--foreground)] mb-2">Implementation</p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
            {tabs.map((tab) => {
              const selected = lang === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setLang(tab.id)}
                  className={`flex flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-left transition-colors ${
                    selected
                      ? "border-[var(--brand-border)] bg-[var(--brand-soft)]"
                      : "border-[var(--border-subtle)] bg-[var(--surface)] hover:border-[var(--brand-border)]"
                  }`}
                >
                  <span className={`text-xs font-semibold ${selected ? "text-[var(--brand-primary)]" : "text-[var(--foreground)]"}`}>
                    {tab.label}
                  </span>
                  <span className="text-[10px] text-[var(--muted)]">{tab.sub}</span>
                </button>
              );
            })}
          </div>

          <CodeBlock language={langLabel[lang]} code={code} />

          {lang === "java-helper" && (
            <div className="mt-3">
              <p className="text-xs font-semibold text-[var(--foreground)] mb-1.5">
                The helper class — paste it into any package in your codebase
              </p>
              <CodeBlock language="java" code={helperSource} />
            </div>
          )}
        </div>

        <div className="mt-4 rounded-lg border border-[var(--brand-border)] bg-[var(--brand-soft)] p-3 text-xs">
          <p className="font-semibold text-[var(--brand-primary)] mb-1">About <code className="font-mono text-[11px]">TESBO_BUILD_ID</code></p>
          <p className="text-[var(--muted)] leading-relaxed">
            <code className="font-mono text-[11px]">tesbox grid-run</code> exports{" "}
            <code className="font-mono text-[11px]">TESBO_BUILD_ID</code> automatically — every
            session and every test row created during that run share the same build id, so the
            join is exact. For local <code className="font-mono text-[11px]">mvn test</code> /{" "}
            <code className="font-mono text-[11px]">pytest</code> runs, either{" "}
            <code className="font-mono text-[11px]">export TESBO_BUILD_ID=local-$(git rev-parse --short HEAD)</code>{" "}
            yourself, or — for the Java helper — call{" "}
            <code className="font-mono text-[11px]">TesboCapabilities.setDefaultBuild(yourBuildName)</code>{" "}
            once in <code className="font-mono text-[11px]">@BeforeSuite</code> so your existing
            build-naming convention is reused.
          </p>
        </div>
      </CardBody>
    </Card>
  );
}

// ─── Selenium Java Steps ──────────────────────────────────────────────────────

function SeleniumJavaSteps({
  projectId,
  accessKey,
  keyVisible,
}: {
  projectId: string;
  accessKey: string | null;
  keyVisible: boolean;
}) {
  const [mode, setMode] = useState<SeleniumMode>("managed");
  const key = accessKey ? (keyVisible ? accessKey : "<your-access-key>") : "<your-access-key>";

  if (mode === "direct") {
    return (
      <div className="space-y-6">
        <SeleniumModeTabs active={mode} onChange={setMode} />
        <DirectGridUrlSection
          projectId={projectId}
          language="java"
          accessKey={accessKey}
          keyVisible={keyVisible}
        />
        <SessionLinkingDocs defaultLang="java-helper" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <SeleniumModeTabs active={mode} onChange={setMode} />

      {/* Prerequisites */}
      <Card>
        <CardBody className="p-6">
          <h2 className="text-lg font-semibold text-[var(--foreground)] mb-1">Step 3 — Prerequisites</h2>
          <p className="text-sm text-[var(--muted)] mb-4">Ensure your project has the following before connecting to Tesbo Grid.</p>
          <div className="space-y-3">
            <div className="flex items-start gap-3 rounded-lg border border-[var(--border-subtle)] p-3">
              <span className="mt-0.5 text-xs font-semibold text-[var(--brand-primary)] bg-[var(--brand-primary)]/10 rounded px-1.5 py-0.5">JDK</span>
              <div>
                <p className="text-sm font-medium text-[var(--foreground)]">Java 17+</p>
                <p className="text-xs text-[var(--muted)]">Workers run inside a JDK 17 container. Compile your project with Java 17 or higher.</p>
              </div>
            </div>
            <div className="flex items-start gap-3 rounded-lg border border-[var(--border-subtle)] p-3">
              <span className="mt-0.5 text-xs font-semibold text-[var(--brand-primary)] bg-[var(--brand-primary)]/10 rounded px-1.5 py-0.5">Maven</span>
              <div>
                <p className="text-sm font-medium text-[var(--foreground)]">Maven 3.x + pom.xml</p>
                <p className="text-xs text-[var(--muted)]">The worker runs <code className="font-mono text-[11px]">mvn -B -Dtest=&quot;ClassName#methodName&quot; test</code> per test. Include Selenium 4 + TestNG in your <code className="font-mono text-[11px]">pom.xml</code>.</p>
              </div>
            </div>
          </div>

          <div className="mt-4">
            <p className="text-xs font-semibold text-[var(--foreground)] mb-1.5">pom.xml — minimum dependencies</p>
            <CodeBlock
              language="xml"
              code={`<dependencies>
  <!-- Selenium 4 -->
  <dependency>
    <groupId>org.seleniumhq.selenium</groupId>
    <artifactId>selenium-java</artifactId>
    <version>4.20.0</version>
  </dependency>

  <!-- TestNG -->
  <dependency>
    <groupId>org.testng</groupId>
    <artifactId>testng</artifactId>
    <version>7.10.2</version>
    <scope>test</scope>
  </dependency>
</dependencies>

<build>
  <plugins>
    <plugin>
      <groupId>org.apache.maven.plugins</groupId>
      <artifactId>maven-surefire-plugin</artifactId>
      <version>3.2.5</version>
    </plugin>
  </plugins>
</build>`}
            />
          </div>
        </CardBody>
      </Card>

      {/* BaseTest setup */}
      <Card>
        <CardBody className="p-6">
          <h2 className="text-lg font-semibold text-[var(--foreground)] mb-1">Step 4 — Configure BaseTest</h2>
          <p className="text-sm text-[var(--muted)] mb-4">
            The Tesbo Grid worker injects environment variables at runtime. Your <code className="font-mono text-xs">BaseTest</code> should read these to connect to the remote Selenium Hub.
          </p>

          <div className="mb-4 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-secondary)] p-3">
            <p className="text-xs font-semibold text-[var(--foreground)] mb-2">Environment variables injected by the worker</p>
            <div className="space-y-1">
              {[
                { name: "SELENIUM_REMOTE_URL", value: "http://selenium-hub:4444/wd/hub", desc: "Grid endpoint — always set automatically" },
                { name: "SELENIUM_BROWSER", value: "chrome", desc: "Set via --browser flag on the CLI" },
                { name: "BASE_URL", value: "https://your-app.com", desc: "Set via --start-url flag on the CLI" },
                { name: "TESBOX_RUN_ID", value: "(current run id)", desc: "Useful for tagging and tracing" },
                { name: "TESBO_BUILD_ID", value: "(generated per build)", desc: "Set tesbo:options.build to this so the report's Live VNC / Session recording link works" },
              ].map(({ name, value, desc }) => (
                <div key={name} className="grid grid-cols-[180px_1fr] gap-2 text-xs">
                  <code className="font-mono text-[var(--foreground)]">{name}</code>
                  <span className="text-[var(--muted)]">{desc} <em>(default: {value})</em></span>
                </div>
              ))}
            </div>
          </div>

          <CodeBlock
            language="java"
            code={`// BaseTest.java
public abstract class BaseTest {
    protected WebDriver driver;
    protected String baseUrl;

    @BeforeMethod(alwaysRun = true)
    public void setUp(java.lang.reflect.Method testMethod) throws Exception {
        String remote  = envOr("SELENIUM_REMOTE_URL", "http://selenium-hub:4444/wd/hub");
        String browser = envOr("SELENIUM_BROWSER", "chrome").toLowerCase();
        baseUrl        = envOr("BASE_URL", "https://your-app.com");

        MutableCapabilities options;
        switch (browser) {
            case "firefox": options = headlessFirefox(); break;
            default:        options = headlessChrome();  break;
        }

        // ── Tesbo session ⇄ test-row correlation ─────────────────────────
        // Tag the WebDriver session with the build id and the
        // <Class>.<method> name. The grid-selenium-proxy stores both on
        // the session row, then the report ingest joins each TestNG
        // method back to the session that produced its screenshots/video.
        // Result: the dashboard shows a "Live VNC" or "Session recording"
        // link on every failed test row.
        Map<String, Object> tesbo = new HashMap<>();
        tesbo.put("build", envOr("TESBO_BUILD_ID", "local"));
        tesbo.put("name",  testMethod.getDeclaringClass().getSimpleName()
                          + "." + testMethod.getName());
        options.setCapability("tesbo:options", tesbo);

        driver = new RemoteWebDriver(URI.create(remote).toURL(), options);
        driver.manage().timeouts().implicitlyWait(Duration.ofSeconds(10));
    }

    @AfterMethod(alwaysRun = true)
    public void tearDown() {
        if (driver != null) driver.quit();
    }

    private static ChromeOptions headlessChrome() {
        ChromeOptions o = new ChromeOptions();
        o.addArguments("--headless=new", "--no-sandbox", "--disable-dev-shm-usage");
        return o;
    }

    private static String envOr(String name, String fallback) {
        String v = System.getenv(name);
        return (v == null || v.isBlank()) ? fallback : v;
    }
}`}
          />
        </CardBody>
      </Card>

      {/* Session ⇄ test correlation (Java) */}
      <SessionLinkingDocs defaultLang="java-helper" />

      {/* Install & run */}
      <Card>
        <CardBody className="p-6">
          <h2 className="text-lg font-semibold text-[var(--foreground)] mb-1">Step 5 — Install CLI &amp; run</h2>
          <p className="text-sm text-[var(--muted)] mb-4">
            The Tesbo CLI detects Java automatically from your <code className="font-mono text-xs">pom.xml</code>. Pass <code className="font-mono text-xs">--framework selenium</code> to be explicit.
          </p>
          <div className="space-y-4">
            <div>
              <h3 className="text-sm font-semibold text-[var(--foreground)] mb-1">Install the CLI</h3>
              <CodeBlock language="bash" code="npm install -g @tesbox/cli" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-[var(--foreground)] mb-1">Run (auto-detect)</h3>
              <p className="text-xs text-[var(--muted)] mb-2">The CLI infers Java + Selenium from your <code className="font-mono text-[11px]">pom.xml</code>.</p>
              <CodeBlock
                language="bash"
                code={`npx tesbox run "src/test/**/*.java" \\
  --browser chrome \\
  --start-url https://your-app.com \\
  --api-key ${key}`}
              />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-[var(--foreground)] mb-1">Run (explicit flags)</h3>
              <CodeBlock
                language="bash"
                code={`npx tesbox run "src/test/**/*.java" \\
  --framework selenium \\
  --language java \\
  --browser chrome \\
  --start-url https://your-app.com \\
  --api-key ${key}`}
              />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-[var(--foreground)] mb-1">Or use an environment variable</h3>
              <CodeBlock language=".env" code={`TESBOX_API_KEY=${key}`} />
            </div>
          </div>
        </CardBody>
      </Card>

      {/* run-build (orchestrated mvn flow) */}
      <Card>
        <CardBody className="p-6">
          <div className="flex items-center gap-2 mb-1">
            <h2 className="text-lg font-semibold text-[var(--foreground)]">
              Step 6 — Already have <code className="font-mono text-base">mvn test</code> working? Use <code className="font-mono text-base">run-build</code>
            </h2>
            <span className="rounded-full border border-[var(--brand-border)] bg-[var(--brand-soft)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--brand-primary)]">
              Recommended
            </span>
          </div>
          <p className="text-sm text-[var(--muted)] mb-4">
            Wrap your existing Maven command with <code className="font-mono text-xs">tesbox run-build</code>.
            The CLI registers a build row in your dashboard <strong>before</strong> tests start (visible
            immediately as &quot;Running&quot;), executes <code className="font-mono text-xs">mvn test</code> locally,
            and auto-uploads <code className="font-mono text-xs">target/surefire-reports/*.xml</code> /
            <code className="font-mono text-xs"> testng-results.xml</code> to the same row when it finishes.
            One row per execution — no duplicates, no manual linking.
          </p>

          <div className="space-y-4">
            <div>
              <h3 className="text-sm font-semibold text-[var(--foreground)] mb-1">Basic — wrap your Maven command</h3>
              <p className="text-xs text-[var(--muted)] mb-2">
                Everything after <code className="font-mono text-[11px]">--</code> is your real Maven command, executed as-is.
              </p>
              <CodeBlock
                language="bash"
                code={`npx tesbox run-build --api-key ${key} -- mvn test`}
              />
            </div>

            <div>
              <h3 className="text-sm font-semibold text-[var(--foreground)] mb-1">With Maven flags</h3>
              <p className="text-xs text-[var(--muted)] mb-2">Pass <code className="font-mono text-[11px]">-B</code>, profiles, suite files, or any other Maven argument normally.</p>
              <CodeBlock
                language="bash"
                code={`npx tesbox run-build --api-key ${key} -- \\
  mvn -B -DsuiteXmlFile=testng.xml test`}
              />
            </div>

            <div>
              <h3 className="text-sm font-semibold text-[var(--foreground)] mb-1">CI-friendly — stable build id</h3>
              <p className="text-xs text-[var(--muted)] mb-2">
                Use your CI build id so retries / shards land on the same dashboard row.
              </p>
              <CodeBlock
                language="bash"
                code={`npx tesbox run-build --api-key ${key} \\
  --build-id $GITHUB_RUN_ID \\
  --run-name "PR #\${PR_NUMBER}" \\
  -- mvn -B test`}
              />
            </div>

            <div>
              <h3 className="text-sm font-semibold text-[var(--foreground)] mb-1">Run on Tesbo Grid browsers — <code className="font-mono">grid-run</code></h3>
              <p className="text-xs text-[var(--muted)] mb-2">
                Same orchestration as <code className="font-mono text-[11px]">run-build</code>, but also injects
                <code className="font-mono text-[11px]"> SELENIUM_REMOTE_URL</code> so the browser runs on Tesbo Grid
                while your Maven process runs locally.
              </p>
              <CodeBlock
                language="bash"
                code={`npx tesbox grid-run --api-key ${key} --browser chrome \\
  -- mvn -B test`}
              />
            </div>
          </div>

          <div className="mt-4 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface)] p-3 space-y-1.5">
            <p className="text-xs font-semibold text-[var(--foreground)]">Tips</p>
            <ul className="space-y-1 text-xs text-[var(--muted)] list-disc list-inside">
              <li>The CLI exits with the same code as your Maven command — failed tests still fail your CI build.</li>
              <li>Add <code className="font-mono text-[11px]">--results-path target</code> if your reports live in a non-default location.</li>
              <li>Add <code className="font-mono text-[11px]">--skip-upload</code> to register the build but skip auto-upload (useful for local debugging).</li>
              <li>You can do the same with the alias: <code className="font-mono text-[11px]">tesbox run-build -- mvn test</code> when <code className="font-mono text-[11px]">@tesbox/cli</code> is installed globally.</li>
            </ul>
          </div>
        </CardBody>
      </Card>

      {/* Maven + TestNG combinations */}
      <Card>
        <CardBody className="p-6">
          <h2 className="text-lg font-semibold text-[var(--foreground)] mb-1">
            Step 7 — Maven + TestNG run combinations
          </h2>
          <p className="text-sm text-[var(--muted)] mb-5">
            Anything after <code className="font-mono text-xs">--</code> is forwarded to Maven verbatim, so any
            valid <code className="font-mono text-xs">mvn</code> + TestNG invocation works. Pick the pattern that
            matches your suite — each one auto-registers a build, runs locally, and uploads
            <code className="font-mono text-xs"> testng-results.xml</code> /
            <code className="font-mono text-xs"> surefire-reports/*.xml</code> to the same dashboard row.
          </p>

          <div className="space-y-5">
            {[
              {
                title: "Run the entire test suite",
                desc: "Picks up every @Test method discovered by Surefire / TestNG.",
                code: `npx tesbox run-build --api-key ${key} -- mvn -B test`,
              },
              {
                title: "Run a TestNG suite XML file",
                desc: "Use this when your test selection lives in a testng.xml (groups, listeners, parallel config, etc.).",
                code: `npx tesbox run-build --api-key ${key} -- \\
  mvn -B -DsuiteXmlFile=testng.xml test`,
              },
              {
                title: "Run a single test class",
                desc: "Surefire passes -Dtest straight to TestNG.",
                code: `npx tesbox run-build --api-key ${key} -- \\
  mvn -B -Dtest=HelloGridTest test`,
              },
              {
                title: "Run a single @Test method",
                desc: "Use ClassName#methodName. Useful for re-running a single failure locally.",
                code: `npx tesbox run-build --api-key ${key} -- \\
  mvn -B -Dtest=HelloGridTest#testHomePageLoads test`,
              },
              {
                title: "Run multiple classes / methods",
                desc: "Comma-separate selectors. Wildcards (*) are supported by Surefire.",
                code: `npx tesbox run-build --api-key ${key} -- \\
  mvn -B -Dtest="LoginTest,CheckoutTest#happyPath,Smoke*" test`,
              },
              {
                title: "Run by TestNG groups",
                desc: "Filter @Test(groups = \"smoke\") methods. Combine groups with commas.",
                code: `npx tesbox run-build --api-key ${key} -- \\
  mvn -B -Dgroups=smoke,regression test`,
              },
              {
                title: "Exclude TestNG groups",
                desc: "Skip slow or quarantined groups for fast feedback.",
                code: `npx tesbox run-build --api-key ${key} -- \\
  mvn -B -Dgroups=smoke -DexcludedGroups=flaky test`,
              },
              {
                title: "Parallel execution",
                desc: "TestNG runs methods in parallel using N threads. Pair with thread-safe page objects.",
                code: `npx tesbox run-build --api-key ${key} -- \\
  mvn -B -DsuiteXmlFile=testng.xml \\
    -Dparallel=methods -DthreadCount=4 test`,
              },
              {
                title: "With a Maven profile",
                desc: "Switch between staging / production / smoke profiles defined in your pom.xml.",
                code: `npx tesbox run-build --api-key ${key} -- \\
  mvn -B -Pregression test`,
              },
              {
                title: "Pass system properties to your tests",
                desc: "Anything -DfooBar=baz becomes System.getProperty(\"fooBar\") inside your tests.",
                code: `npx tesbox run-build --api-key ${key} -- \\
  mvn -B \\
    -Denv=staging \\
    -DbaseUrl=https://staging.your-app.com \\
    -DsuiteXmlFile=testng.xml test`,
              },
              {
                title: "Don't fail the build when no tests match",
                desc: "Useful in shards / CI matrices where some workers may legitimately have nothing to run.",
                code: `npx tesbox run-build --api-key ${key} -- \\
  mvn -B -Dtest=HelloGridTest -DfailIfNoTests=false test`,
              },
              {
                title: "Re-run only failed tests",
                desc: "Surefire writes failsafe-reports; -DrerunFailingTestsCount asks TestNG to retry transient failures before reporting.",
                code: `npx tesbox run-build --api-key ${key} -- \\
  mvn -B -DsuiteXmlFile=testng.xml \\
    -DrerunFailingTestsCount=2 test`,
              },
              {
                title: "Run on Tesbo Grid browsers (browser remote, Maven local)",
                desc: "grid-run injects SELENIUM_REMOTE_URL automatically — your RemoteWebDriver picks it up, no config change needed.",
                code: `npx tesbox grid-run --api-key ${key} --browser chrome -- \\
  mvn -B -DsuiteXmlFile=testng.xml test`,
              },
              {
                title: "Stable build id for CI shards / retries",
                desc: "Reuse one build row across parallel shards — set --build-id to your CI run id.",
                code: `npx tesbox run-build --api-key ${key} \\
  --build-id $GITHUB_RUN_ID \\
  --run-name "PR #\${PR_NUMBER}" \\
  -- mvn -B -DsuiteXmlFile=testng.xml test`,
              },
            ].map(({ title, desc, code }) => (
              <div key={title}>
                <h3 className="text-sm font-semibold text-[var(--foreground)] mb-0.5">{title}</h3>
                <p className="text-xs text-[var(--muted)] mb-2">{desc}</p>
                <CodeBlock language="bash" code={code} />
              </div>
            ))}
          </div>

          <div className="mt-5 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface)] p-3 space-y-1.5">
            <p className="text-xs font-semibold text-[var(--foreground)]">Notes</p>
            <ul className="space-y-1 text-xs text-[var(--muted)] list-disc list-inside">
              <li><code className="font-mono text-[11px]">-B</code> = batch mode (no interactive output) — recommended for CI logs.</li>
              <li>Combine flags freely: <code className="font-mono text-[11px]">-DsuiteXmlFile</code> + <code className="font-mono text-[11px]">-Dgroups</code> + <code className="font-mono text-[11px]">-Dparallel</code> all play together.</li>
              <li>If reports land somewhere non-standard, add <code className="font-mono text-[11px]">--results-path target/custom-reports</code> to <code className="font-mono text-[11px]">tesbox run-build</code>.</li>
              <li>Want to debug locally without uploading? Add <code className="font-mono text-[11px]">--skip-upload</code>.</li>
              <li>The CLI exits with the same code as <code className="font-mono text-[11px]">mvn</code> — failed tests still fail your CI build.</li>
            </ul>
          </div>
        </CardBody>
      </Card>

      {/* CI */}
      <Card>
        <CardBody className="p-6">
          <h2 className="text-lg font-semibold text-[var(--foreground)] mb-1">Step 8 — Run in CI</h2>
          <p className="text-sm text-[var(--muted)] mb-5">Add Tesbo Grid to your pipeline — every push runs your Java/TestNG suite on the grid automatically.</p>
          <CiSection framework="selenium" seleniumLang="java" accessKey={accessKey} keyVisible={keyVisible} />
        </CardBody>
      </Card>

      {/* Troubleshooting */}
      <Card>
        <CardBody className="p-6">
          <h2 className="text-lg font-semibold text-[var(--foreground)] mb-4">Troubleshooting</h2>
          <div className="space-y-4">
            {[
              {
                title: "mvn: command not found inside the worker",
                body: "The Selenium Java worker image must include Maven. Make sure you're using the correct Docker image (maven:3.9-eclipse-temurin-17) or that Maven is pre-installed in your worker environment.",
                fix: null,
              },
              {
                title: "Could not start a new session",
                body: "The worker cannot reach the Selenium Hub. Confirm the Hub is healthy and SELENIUM_REMOTE_URL is correctly set.",
                fix: `curl http://localhost:4444/wd/hub/status`,
              },
              {
                title: "Tests run but report 'Skipped'",
                body: "The --test selector didn't match. The CLI generates ClassName#methodName. Check the exact class and method name combination in your job log.",
                fix: null,
              },
              {
                title: "Tests fail immediately with a URL error",
                body: "BASE_URL is not set correctly. Pass --start-url to the CLI or set it as an environment variable in your BaseTest as a fallback.",
                fix: `npx tesbox run "src/test/**/*.java" --browser chrome --start-url https://your-app.com`,
              },
            ].map(({ title, body, fix }) => (
              <div key={title} className="rounded-lg border border-[var(--border-subtle)] p-4 space-y-2">
                <div className="flex items-start gap-2">
                  <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--error)]/10 text-[10px] font-bold text-[var(--error)]">!</span>
                  <p className="text-sm font-semibold text-[var(--foreground)]">{title}</p>
                </div>
                <p className="text-xs text-[var(--muted)] leading-relaxed pl-7">{body}</p>
                {fix && (
                  <div className="pl-7">
                    <CodeBlock code={fix} />
                  </div>
                )}
              </div>
            ))}
          </div>
        </CardBody>
      </Card>
    </div>
  );
}

// ─── Selenium Python Steps ────────────────────────────────────────────────────

function SeleniumPythonSteps({
  projectId,
  accessKey,
  keyVisible,
}: {
  projectId: string;
  accessKey: string | null;
  keyVisible: boolean;
}) {
  const [mode, setMode] = useState<SeleniumMode>("managed");
  const key = accessKey ? (keyVisible ? accessKey : "<your-access-key>") : "<your-access-key>";

  if (mode === "direct") {
    return (
      <div className="space-y-6">
        <SeleniumModeTabs active={mode} onChange={setMode} />
        <DirectGridUrlSection
          projectId={projectId}
          language="python"
          accessKey={accessKey}
          keyVisible={keyVisible}
        />
        <SessionLinkingDocs defaultLang="python" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <SeleniumModeTabs active={mode} onChange={setMode} />

      {/* Prerequisites */}
      <Card>
        <CardBody className="p-6">
          <h2 className="text-lg font-semibold text-[var(--foreground)] mb-1">Step 3 — Prerequisites</h2>
          <p className="text-sm text-[var(--muted)] mb-4">Ensure your project is set up correctly before connecting to Tesbo Grid.</p>
          <div className="space-y-3">
            <div className="flex items-start gap-3 rounded-lg border border-[var(--border-subtle)] p-3">
              <span className="mt-0.5 text-xs font-semibold text-[var(--brand-primary)] bg-[var(--brand-primary)]/10 rounded px-1.5 py-0.5">Python</span>
              <div>
                <p className="text-sm font-medium text-[var(--foreground)]">Python 3.12+</p>
                <p className="text-xs text-[var(--muted)]">Workers run inside a Python 3.12 container. Dependencies are installed from <code className="font-mono text-[11px]">requirements.txt</code> before each test.</p>
              </div>
            </div>
            <div className="flex items-start gap-3 rounded-lg border border-[var(--border-subtle)] p-3">
              <span className="mt-0.5 text-xs font-semibold text-[var(--brand-primary)] bg-[var(--brand-primary)]/10 rounded px-1.5 py-0.5">Pytest</span>
              <div>
                <p className="text-sm font-medium text-[var(--foreground)]">pytest + pytest-json-report</p>
                <p className="text-xs text-[var(--muted)]">The worker runs one test function per job and reads <code className="font-mono text-[11px]">report.json</code> (with <code className="font-mono text-[11px]">test-results/junit.xml</code> as fallback).</p>
              </div>
            </div>
          </div>

          <div className="mt-4">
            <p className="text-xs font-semibold text-[var(--foreground)] mb-1.5">requirements.txt — minimum dependencies</p>
            <CodeBlock
              language="text"
              code={`selenium>=4.20.0
pytest>=8.0.0
pytest-json-report>=1.5.0`}
            />
          </div>
        </CardBody>
      </Card>

      {/* conftest.py setup */}
      <Card>
        <CardBody className="p-6">
          <h2 className="text-lg font-semibold text-[var(--foreground)] mb-1">Step 4 — Configure conftest.py</h2>
          <p className="text-sm text-[var(--muted)] mb-4">
            The Tesbo Grid worker injects environment variables at runtime. Your <code className="font-mono text-xs">conftest.py</code> fixtures should read these to connect to the remote Selenium Hub.
          </p>

          <div className="mb-4 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-secondary)] p-3">
            <p className="text-xs font-semibold text-[var(--foreground)] mb-2">Environment variables injected by the worker</p>
            <div className="space-y-1">
              {[
                { name: "SELENIUM_REMOTE_URL", desc: "Grid endpoint — always set automatically", default: "http://selenium-hub:4444/wd/hub" },
                { name: "SELENIUM_BROWSER", desc: "Set via --browser flag on the CLI", default: "chrome" },
                { name: "BASE_URL", desc: "Set via --start-url flag on the CLI", default: "https://your-app.com" },
                { name: "TESBOX_RUN_ID", desc: "Useful for tagging and tracing", default: "(current run id)" },
              ].map(({ name, desc, default: d }) => (
                <div key={name} className="grid grid-cols-[180px_1fr] gap-2 text-xs">
                  <code className="font-mono text-[var(--foreground)]">{name}</code>
                  <span className="text-[var(--muted)]">{desc} <em>(default: {d})</em></span>
                </div>
              ))}
            </div>
          </div>

          <CodeBlock
            language="python"
            code={`# conftest.py
import os
import pytest
from selenium import webdriver
from selenium.webdriver.chrome.options import Options as ChromeOptions
from selenium.webdriver.firefox.options import Options as FirefoxOptions


def _env(name: str, default: str) -> str:
    value = os.getenv(name)
    return value if value else default


def _build_options(browser: str):
    if browser == "firefox":
        opts = FirefoxOptions()
        opts.add_argument("-headless")
        return opts
    opts = ChromeOptions()
    opts.add_argument("--headless=new")
    opts.add_argument("--no-sandbox")
    opts.add_argument("--disable-dev-shm-usage")
    return opts


@pytest.fixture()
def browser() -> str:
    return _env("SELENIUM_BROWSER", "chrome").lower()


@pytest.fixture()
def base_url() -> str:
    return _env("BASE_URL", "https://your-app.com")


@pytest.fixture()
def driver(browser: str):
    remote_url = _env("SELENIUM_REMOTE_URL", "http://selenium-hub:4444/wd/hub")
    web_driver = webdriver.Remote(
        command_executor=remote_url,
        options=_build_options(browser),
    )
    web_driver.implicitly_wait(10)
    web_driver.set_page_load_timeout(30)
    try:
        yield web_driver
    finally:
        web_driver.quit()`}
          />
        </CardBody>
      </Card>

      {/* Session ⇄ test correlation (Python) */}
      <SessionLinkingDocs defaultLang="python" />

      {/* Install & run */}
      <Card>
        <CardBody className="p-6">
          <h2 className="text-lg font-semibold text-[var(--foreground)] mb-1">Step 5 — Install CLI &amp; run</h2>
          <p className="text-sm text-[var(--muted)] mb-4">
            The Tesbo CLI detects Python automatically from your <code className="font-mono text-xs">requirements.txt</code>. Pass <code className="font-mono text-xs">--framework selenium</code> to be explicit.
          </p>
          <div className="space-y-4">
            <div>
              <h3 className="text-sm font-semibold text-[var(--foreground)] mb-1">Install the CLI</h3>
              <CodeBlock language="bash" code="npm install -g @tesbox/cli" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-[var(--foreground)] mb-1">Run (auto-detect)</h3>
              <p className="text-xs text-[var(--muted)] mb-2">The CLI infers Python + Selenium from <code className="font-mono text-[11px]">requirements.txt</code>.</p>
              <CodeBlock
                language="bash"
                code={`npx tesbox run "tests/test_*.py" \\
  --browser chrome \\
  --start-url https://your-app.com \\
  --api-key ${key}`}
              />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-[var(--foreground)] mb-1">Run (explicit flags)</h3>
              <CodeBlock
                language="bash"
                code={`npx tesbox run "tests/test_*.py" \\
  --framework selenium \\
  --language python \\
  --browser chrome \\
  --start-url https://your-app.com \\
  --api-key ${key}`}
              />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-[var(--foreground)] mb-1">Or use an environment variable</h3>
              <CodeBlock language=".env" code={`TESBOX_API_KEY=${key}`} />
            </div>
          </div>
        </CardBody>
      </Card>

      {/* CI */}
      <Card>
        <CardBody className="p-6">
          <h2 className="text-lg font-semibold text-[var(--foreground)] mb-1">Step 6 — Run in CI</h2>
          <p className="text-sm text-[var(--muted)] mb-5">Add Tesbo Grid to your pipeline — every push runs your Python/Pytest suite on the grid automatically.</p>
          <CiSection framework="selenium" seleniumLang="python" accessKey={accessKey} keyVisible={keyVisible} />
        </CardBody>
      </Card>

      {/* Troubleshooting */}
      <Card>
        <CardBody className="p-6">
          <h2 className="text-lg font-semibold text-[var(--foreground)] mb-4">Troubleshooting</h2>
          <div className="space-y-4">
            {[
              {
                title: "pytest-json-report not installed",
                body: "The worker auto-installs requirements.txt before running. If you've removed pytest-json-report from requirements.txt, the worker falls back to test-results/junit.xml. Add it back to get richer test results.",
                fix: null,
              },
              {
                title: "MaxRetryError connecting to the Grid",
                body: "The worker cannot reach the Selenium Hub. Confirm the Hub is healthy and SELENIUM_REMOTE_URL is correctly set.",
                fix: `curl http://localhost:4444/wd/hub/status`,
              },
              {
                title: "Tests show as 'Skipped'",
                body: "The node ID selector didn't match. The CLI generates tests/test_file.py::test_function_name. Check the exact module path and function name in your job log.",
                fix: null,
              },
              {
                title: "Tests fail immediately with a URL or navigation error",
                body: "BASE_URL is not set. Pass --start-url to the CLI, or add a fallback default in your conftest.py base_url fixture.",
                fix: `npx tesbox run "tests/test_*.py" --browser chrome --start-url https://your-app.com`,
              },
            ].map(({ title, body, fix }) => (
              <div key={title} className="rounded-lg border border-[var(--border-subtle)] p-4 space-y-2">
                <div className="flex items-start gap-2">
                  <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--error)]/10 text-[10px] font-bold text-[var(--error)]">!</span>
                  <p className="text-sm font-semibold text-[var(--foreground)]">{title}</p>
                </div>
                <p className="text-xs text-[var(--muted)] leading-relaxed pl-7">{body}</p>
                {fix && (
                  <div className="pl-7">
                    <CodeBlock code={fix} />
                  </div>
                )}
              </div>
            ))}
          </div>
        </CardBody>
      </Card>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function IntegrationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [accessKey, setAccessKey] = useState<string | null>(null);
  const [keyVisible, setKeyVisible] = useState(false);
  const [keyCopied, setKeyCopied] = useState(false);
  const [keyLoading, setKeyLoading] = useState(true);
  const [rotating, setRotating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [aiData, setAiData] = useState<WorkspaceAiKeysResponse | null>(null);
  const [selectedAiKeyId, setSelectedAiKeyId] = useState("");
  const [savingAiKey, setSavingAiKey] = useState(false);
  const [aiMessage, setAiMessage] = useState("");
  const [aiError, setAiError] = useState("");

  // Test stack lock-in modal state (for legacy projects whose settings are missing
  // framework/language/defaultBrowser).
  const [showStackLock, setShowStackLock] = useState(false);
  const [lockFramework, setLockFramework] = useState<Framework>("playwright");
  const [lockLanguage, setLockLanguage] = useState<
    "javascript" | "typescript" | "python" | "java"
  >("typescript");
  const [lockBrowser, setLockBrowser] = useState<"chrome" | "firefox" | "edge">("chrome");
  const [lockSaving, setLockSaving] = useState(false);
  const [lockError, setLockError] = useState("");

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [proj, keyRes, workspaceAi] = await Promise.all([
        getProject(id),
        getProjectAccessKey(id),
        listWorkspaceAiKeys(),
      ]);
      setProject(proj);
      setAiData(workspaceAi);

      const allocation = workspaceAi.projects.find((p) => p.projectId === id);
      setSelectedAiKeyId(allocation?.workspaceAiKeyId || "");

      if (keyRes.ingestionApiKey) {
        setAccessKey(keyRes.ingestionApiKey);
        setKeyLoading(false);
      } else {
        const rotated = await rotateProjectAccessKey(id);
        setAccessKey(rotated.ingestionApiKey);
        setKeyLoading(false);
      }
    } catch {
      setKeyLoading(false);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  async function handleRotateKey() {
    if (!confirm("Regenerate access key? The current key will stop working immediately.")) return;
    setRotating(true);
    try {
      const result = await rotateProjectAccessKey(id);
      setAccessKey(result.ingestionApiKey);
      setKeyVisible(true);
    } catch {
      // silent
    } finally {
      setRotating(false);
    }
  }

  function copyKey() {
    if (!accessKey) return;
    navigator.clipboard.writeText(accessKey);
    setKeyCopied(true);
    setTimeout(() => setKeyCopied(false), 2000);
  }

  async function handleSaveAiKeyAllocation() {
    setAiMessage("");
    setAiError("");
    setSavingAiKey(true);
    try {
      await allocateWorkspaceAiKeyToProject({
        projectId: id,
        workspaceAiKeyId: selectedAiKeyId || undefined,
      });
      setAiMessage(
        selectedAiKeyId
          ? "AI key linked. Failed tests will receive AI analysis summaries."
          : "AI key removed. AI analysis is disabled for this project."
      );
      await loadData();
    } catch (err) {
      setAiError(err instanceof Error ? err.message : "Failed to save AI key allocation");
    } finally {
      setSavingAiKey(false);
    }
  }

  async function handleLockStack(e: React.FormEvent) {
    e.preventDefault();
    setLockError("");
    setLockSaving(true);
    try {
      await updateProject(id, {
        settings: {
          framework: lockFramework,
          language: lockLanguage,
          defaultBrowser: lockBrowser,
        },
        lockMissingStackKeys: true,
      });
      setShowStackLock(false);
      await loadData();
    } catch (err) {
      setLockError(err instanceof Error ? err.message : "Failed to lock test stack");
    } finally {
      setLockSaving(false);
    }
  }

  if (loading) {
    return <p className="text-[var(--muted)]">Loading…</p>;
  }

  const maskedKey = accessKey ? accessKey.slice(0, 10) + "••••••••••••••••••••••••" : "";
  const workspaceKeys = aiData?.keys || [];
  const aiEnabledForProject = !!selectedAiKeyId;

  // Resolve the project's test stack from settings.  Projects created before
  // Phase 1 may have missing keys — we default to Playwright/TypeScript/Chrome
  // for rendering, and show a one-time "Lock in your test stack" banner so the
  // user can persist the real values.
  const projectSettings = (project?.settings as
    | {
        framework?: string;
        language?: string;
        defaultBrowser?: string;
      }
    | null
    | undefined) || {};
  const stackMissing =
    !projectSettings.framework ||
    !projectSettings.language ||
    !projectSettings.defaultBrowser;
  const framework: Framework =
    projectSettings.framework === "selenium" ? "selenium" : "playwright";
  const seleniumLang: SeleniumLang =
    projectSettings.language === "python" ? "python" : "java";
  const defaultBrowser = projectSettings.defaultBrowser || "chrome";

  const projectLanguage = (projectSettings.language || "typescript") as
    | "typescript"
    | "javascript"
    | "python"
    | "java";

  const stackLabel =
    framework === "playwright"
      ? `Playwright · ${projectLanguage[0].toUpperCase()}${projectLanguage.slice(1)}`
      : `Selenium · ${seleniumLang[0].toUpperCase()}${seleniumLang.slice(1)}`;
  const stackChipLabel = `${stackLabel} · ${
    defaultBrowser[0].toUpperCase() + defaultBrowser.slice(1)
  }`;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--foreground)]">
            Integration Guide
          </h1>
          <p className="text-sm text-[var(--muted)]">
            Connect your test framework to Tesbo Grid
          </p>
        </div>
        {!stackMissing && (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border-subtle)] bg-[var(--surface-secondary)] px-3 py-1 text-[11px] font-medium text-[var(--muted)]">
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--brand-primary)]" />
            {stackChipLabel}
          </span>
        )}
      </div>

      {stackMissing && (
        <Card>
          <CardBody className="p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-[var(--foreground)]">
                  Lock in your test stack
                </p>
                <p className="mt-1 text-xs text-[var(--muted)]">
                  This project was created before stack selection was required. Confirm
                  your framework and language to see the exact integration steps. This
                  choice can&apos;t be changed once locked.
                </p>
              </div>
              <Button
                size="sm"
                onClick={() => {
                  setLockError("");
                  setShowStackLock(true);
                }}
              >
                Lock in stack
              </Button>
            </div>
          </CardBody>
        </Card>
      )}

      {/* ── Step 1: Access Key ───────────────────────────────────────────────── */}
      <Card>
        <CardBody className="p-6">
          <h2 className="text-lg font-semibold text-[var(--foreground)] mb-4">
            Step 1 — Your project access key
          </h2>

          {keyLoading ? (
            <p className="text-sm text-[var(--muted)]">Preparing access key…</p>
          ) : accessKey ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <svg className="h-4 w-4 text-[var(--success)]" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0 1 12 2.944a11.955 11.955 0 0 1 8.618 3.04A12.02 12.02 0 0 1 12 21.035a12.02 12.02 0 0 1-8.618-15.091z" />
                  </svg>
                  <p className="text-sm font-semibold text-[var(--foreground)]">Access key ready</p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setKeyVisible((v) => !v)}
                    className="rounded px-2 py-1 text-xs font-medium text-[var(--muted)] hover:bg-[var(--surface)] hover:text-[var(--foreground)] transition-colors flex items-center gap-1"
                  >
                    {keyVisible ? (
                      <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M3.98 8.223A10.477 10.477 0 0 0 1.934 12c1.292 4.338 5.31 7.5 10.066 7.5.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0 1 12 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 0 1-4.293 5.774M6.228 6.228 3 3m3.228 3.228 3.65 3.65m7.894 7.894L21 21m-3.228-3.228-3.65-3.65m0 0a3 3 0 1 0-4.243-4.243m4.242 4.242L9.88 9.88" />
                      </svg>
                    ) : (
                      <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z" />
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                      </svg>
                    )}
                    {keyVisible ? "Hide" : "Show"}
                  </button>
                  <Button type="button" variant="secondary" size="sm" onClick={copyKey}>
                    {keyCopied ? "Copied!" : "Copy key"}
                  </Button>
                </div>
              </div>

              <code className="block rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)] px-3 py-2 font-mono text-sm break-all text-[var(--foreground)] select-all">
                {keyVisible ? accessKey : maskedKey}
              </code>

              <div className="flex items-center justify-between">
                <p className="text-xs text-[var(--muted)]">
                  This key authenticates CLI runs and syncs results to your dashboard.
                </p>
                <button
                  type="button"
                  onClick={handleRotateKey}
                  disabled={rotating}
                  className="text-xs font-medium text-[var(--muted)] hover:text-[var(--error)] transition-colors"
                >
                  {rotating ? "Regenerating…" : "Regenerate key"}
                </button>
              </div>
            </div>
          ) : (
            <p className="text-sm text-[var(--error)]">Failed to create access key. Please reload the page.</p>
          )}
        </CardBody>
      </Card>

      {/* ── Step 2: AI Summary Key ───────────────────────────────────────────── */}
      <Card>
        <CardBody className="p-6">
          <h2 className="text-lg font-semibold text-[var(--foreground)] mb-1">
            Step 2 — Enable AI error analysis
          </h2>
          <p className="text-sm text-[var(--muted)] mb-4">
            Assign a workspace AI API key to get AI-based failure summaries for your test runs.
          </p>

          {workspaceKeys.length === 0 ? (
            <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)] p-4">
              <p className="text-sm text-[var(--muted)]">No workspace AI key found. Add one first to use AI summaries.</p>
              <Link
                href="/settings/integrations"
                className="mt-3 inline-flex items-center gap-1.5 rounded-xl border border-[var(--brand-border)] bg-[var(--brand-soft)] px-3.5 py-1.5 text-xs font-medium text-[var(--brand-primary)] hover:bg-[var(--brand-surface)] transition-colors"
              >
                Add AI API key
              </Link>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-3">
                <Select
                  value={selectedAiKeyId}
                  onChange={(e) => setSelectedAiKeyId(e.target.value)}
                  className="min-w-[280px]"
                >
                  <option value="">Disable AI analysis for this project</option>
                  {workspaceKeys.map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.name} ({k.provider})
                    </option>
                  ))}
                </Select>
                <Button onClick={handleSaveAiKeyAllocation} disabled={savingAiKey}>
                  {savingAiKey ? "Saving..." : "Save AI Key"}
                </Button>
              </div>
              <p className="text-xs text-[var(--muted)]">
                Status:{" "}
                <span className="font-medium text-[var(--foreground)]">
                  {aiEnabledForProject ? "Enabled" : "Disabled"}
                </span>
              </p>
              {aiMessage && <p className="text-xs text-[var(--muted)]">{aiMessage}</p>}
              {aiError && <p className="text-xs text-[var(--error)]">{aiError}</p>}
            </div>
          )}
        </CardBody>
      </Card>

      {/* ── GitHub Scheduled Runs ──────────────────────────────────────────── */}
      <Card id="github-scheduled-runs">
        <CardBody className="p-6">
          <h2 className="text-lg font-semibold text-[var(--foreground)] mb-1">
            GitHub-triggered scheduled runs
          </h2>
          <p className="text-sm text-[var(--muted)] mb-4">
            Optional. Use this if you want Tesbo Grid to dispatch runs on a cron
            schedule or on every pull request via a workflow that lives in your
            test repo. Tests still execute on Tesbo Grid&apos;s infrastructure —
            GitHub Actions only triggers the run and streams live logs.
          </p>

          <div className="space-y-4 text-sm text-[var(--foreground)]">
            <div>
              <p className="font-semibold">How it works</p>
              <ol className="list-decimal pl-5 mt-1 space-y-1 text-[var(--muted)]">
                <li>
                  Install the Tesbo Grid GitHub App on your test repo from the
                  project&apos;s Integration page.
                </li>
                <li>
                  Create a schedule on the{" "}
                  <Link
                    href={`/projects/${id}/scheduled-runs`}
                    className="underline text-[var(--brand-primary)]"
                  >
                    Scheduled Runs
                  </Link>{" "}
                  page. Tesbo Grid opens a PR adding a workflow file under{" "}
                  <code className="bg-[var(--surface-secondary)] px-1 rounded">
                    .github/workflows/tesbo-grid-*.yml
                  </code>.
                </li>
                <li>
                  Merge the PR. From then on, Tesbo Grid dispatches the workflow
                  on your cron schedule (or on PR events).
                </li>
              </ol>
            </div>

            <div>
              <p className="font-semibold">
                Required repo secret:{" "}
                <code className="bg-[var(--surface-secondary)] px-1 rounded">
                  TESBO_GRID_API_KEY
                </code>
              </p>
              <p className="mt-1 text-[var(--muted)]">
                The workflow runs <code className="bg-[var(--surface-secondary)] px-1 rounded">npx @tesbox/cli run</code>,
                which authenticates against Tesbo Grid using the{" "}
                <code className="bg-[var(--surface-secondary)] px-1 rounded">TESBOX_API_KEY</code>{" "}
                env variable. The generated YAML maps it from a repo secret named{" "}
                <code className="bg-[var(--surface-secondary)] px-1 rounded">TESBO_GRID_API_KEY</code>:
              </p>
              <CodeBlock
                language="yaml"
                code={`env:
  TESBOX_API_KEY: \${{ secrets.TESBO_GRID_API_KEY }}
run: |
  npx -y @tesbox/cli run "**/*.{spec,test}.{ts,tsx,js,jsx,mjs,cjs,py,java}" \\
    --api-url "$TESBO_RUNNER_API_URL" \\
    --project-id <your-project-id> \\
    --framework playwright --language typescript`}
              />
              <p className="mt-2 text-[var(--muted)]">
                When you create a schedule, Tesbo Grid tries to mint a
                project-scoped API key and push it to the repo automatically.
                That requires the GitHub App to have{" "}
                <span className="font-medium text-[var(--foreground)]">
                  Secrets: Read &amp; Write
                </span>{" "}
                on the repo. If auto-config fails, the Scheduled Runs page shows
                a warning with two options:
              </p>
              <ul className="list-disc pl-5 mt-1 space-y-1 text-[var(--muted)]">
                <li>
                  <span className="font-medium text-[var(--foreground)]">
                    Re-try secret setup
                  </span>{" "}
                  — re-mints a key and pushes it through the App. Use this after
                  re-authorizing the App with secret-write permission.
                </li>
                <li>
                  <span className="font-medium text-[var(--foreground)]">
                    Add it manually on GitHub
                  </span>{" "}
                  — opens the repo&apos;s{" "}
                  <em>Settings → Secrets and variables → Actions</em> page
                  pre-filled with the secret name. Paste a Tesbo Grid project
                  API key as the value.
                </li>
              </ul>
            </div>

            <div>
              <p className="font-semibold">Common failure: <em>&quot;API key required&quot;</em></p>
              <p className="mt-1 text-[var(--muted)]">
                If a manual or scheduled run fails inside GitHub Actions with{" "}
                <code className="bg-[var(--surface-secondary)] px-1 rounded">
                  API key required. Use --api-key or set TESBOX_API_KEY env variable
                </code>
                , the repo secret is missing or empty. GitHub silently expands{" "}
                <code className="bg-[var(--surface-secondary)] px-1 rounded">
                  &#36;&#123;&#123; secrets.TESBO_GRID_API_KEY &#125;&#125;
                </code>{" "}
                to an empty string when the secret doesn&apos;t exist, so the
                CLI sees no key and exits. Fix it from the alert on the{" "}
                <Link
                  href={`/projects/${id}/scheduled-runs`}
                  className="underline text-[var(--brand-primary)]"
                >
                  Scheduled Runs
                </Link>{" "}
                page or add the secret manually using the steps above.
              </p>
            </div>

            <div>
              <p className="font-semibold">Forwarding test environment variables</p>
              <p className="mt-1 text-[var(--muted)]">
                Variables defined on a Tesbo Grid project environment are
                inlined into the workflow YAML (non-secrets) or pushed as
                separate repo secrets (secrets), and forwarded to the worker
                via the CLI&apos;s{" "}
                <code className="bg-[var(--surface-secondary)] px-1 rounded">--env-from</code>{" "}
                flag. You don&apos;t need to wire those secrets manually.
              </p>
            </div>
          </div>
        </CardBody>
      </Card>

      {/* ── Framework-specific steps (only the section that matches the
            project's locked-in stack is rendered). ───────────────────────── */}
      {framework === "playwright" && (
        <PlaywrightSteps accessKey={accessKey} keyVisible={keyVisible} />
      )}
      {framework === "selenium" && seleniumLang === "java" && (
        <SeleniumJavaSteps
          projectId={id}
          accessKey={accessKey}
          keyVisible={keyVisible}
        />
      )}
      {framework === "selenium" && seleniumLang === "python" && (
        <SeleniumPythonSteps
          projectId={id}
          accessKey={accessKey}
          keyVisible={keyVisible}
        />
      )}

      {showStackLock && (
        <Modal
          open
          onClose={() => setShowStackLock(false)}
          title="Lock in your test stack"
        >
          <form onSubmit={handleLockStack} className="space-y-4">
            <div className="rounded-lg border border-[var(--brand-border)] bg-[var(--brand-soft)] px-3 py-2.5 text-xs text-[var(--brand-primary)]">
              <span className="font-semibold">Heads up:</span> framework and language
              can&apos;t be changed after they&apos;re locked. To use a different stack
              later, create a new project.
            </div>

            <SelectorGroup<Framework>
              label="Test framework"
              value={lockFramework}
              onChange={(v) => {
                setLockFramework(v);
                if (v === "selenium" && lockLanguage !== "java" && lockLanguage !== "python") {
                  setLockLanguage("java");
                }
                if (v === "playwright" && lockLanguage !== "typescript" && lockLanguage !== "javascript" && lockLanguage !== "python" && lockLanguage !== "java") {
                  setLockLanguage("typescript");
                }
              }}
              options={[
                { id: "playwright", label: "Playwright", description: "Modern, all-in-one browser automation" },
                { id: "selenium", label: "Selenium", description: "Industry-standard WebDriver" },
              ]}
            />

            <SelectorGroup<"javascript" | "typescript" | "python" | "java">
              label="Language"
              value={lockLanguage}
              onChange={setLockLanguage}
              options={
                lockFramework === "playwright"
                  ? [
                      { id: "typescript", label: "TypeScript" },
                      { id: "javascript", label: "JavaScript" },
                      { id: "python", label: "Python" },
                      { id: "java", label: "Java" },
                    ]
                  : [
                      { id: "java", label: "Java" },
                      { id: "python", label: "Python" },
                    ]
              }
            />

            <SelectorGroup<"chrome" | "firefox" | "edge">
              label="Default browser"
              value={lockBrowser}
              onChange={setLockBrowser}
              options={[
                { id: "chrome", label: "Chrome" },
                { id: "firefox", label: "Firefox" },
                { id: "edge", label: "Edge" },
              ]}
            />

            {lockError && <FieldError>{lockError}</FieldError>}

            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="secondary"
                onClick={() => setShowStackLock(false)}
                disabled={lockSaving}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={lockSaving}>
                {lockSaving ? "Locking…" : "Lock stack"}
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
