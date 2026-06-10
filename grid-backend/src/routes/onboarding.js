import { Router } from "express";
import crypto from "node:crypto";
import { query, transaction } from "../db/database.js";
import { requireAuth } from "../middleware/session.js";
import { logger } from "../logger.js";
import { validateProjectStack } from "./projects.js";

const router = Router();

function normalizeStackInput(input) {
  if (!input || typeof input !== "object") return null;
  const framework = typeof input.framework === "string" ? input.framework.toLowerCase() : null;
  const language = typeof input.language === "string" ? input.language.toLowerCase() : null;
  const defaultBrowser = typeof input.defaultBrowser === "string"
    ? input.defaultBrowser.toLowerCase()
    : null;
  return { framework, language, defaultBrowser };
}

function generateSlug(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(?:^-)|(?:-$)/g, "")
    .slice(0, 48) +
    "-" +
    crypto.randomBytes(3).toString("hex");
}

function generateProjectKey(name) {
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "")
    .slice(0, 6) ||
    "EXEC";
}

router.post("/workspace", requireAuth, async (req, res) => {
  try {
    const { orgName } = req.body || {};
    if (!orgName || typeof orgName !== "string" || orgName.trim().length < 2) {
      return res.status(400).json({ error: "Organization name is required (min 2 chars)" });
    }

    const existing = await query(
      `SELECT om.organization_id FROM organization_members om
       WHERE om.user_id = $1 LIMIT 1`,
      [req.userId]
    );
    if (existing.rows.length > 0) {
      return res.json({ organizationId: existing.rows[0].organization_id });
    }

    const slug = generateSlug(orgName.trim());
    const result = await transaction(async (client) => {
      const org = await client.query(
        "INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id",
        [orgName.trim(), slug]
      );
      const orgId = org.rows[0].id;

      await client.query(
        "INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'owner')",
        [orgId, req.userId]
      );
      return orgId;
    });

    res.json({ organizationId: result });
  } catch (err) {
    logger.error("Onboarding workspace error:", err);
    res.status(500).json({ error: "Failed to create workspace" });
  }
});

router.post("/org-and-project", requireAuth, async (req, res) => {
  try {
    const { orgName, projectKey, projectName, projectDescription } =
      req.body || {};
    if (!orgName || !projectName) {
      return res
        .status(400)
        .json({ error: "Organization name and project name are required" });
    }

    const stackValidation = validateProjectStack(normalizeStackInput(req.body));
    if (!stackValidation.ok) {
      return res.status(400).json({ error: stackValidation.error });
    }
    const initialSettings = { ...stackValidation.value };

    const slug = generateSlug(orgName.trim());
    const key = (projectKey || generateProjectKey(projectName)).toUpperCase().trim();

    const result = await transaction(async (client) => {
      // 1. Create or find org
      let orgId;
      const existing = await client.query(
        `SELECT om.organization_id FROM organization_members om
         WHERE om.user_id = $1 LIMIT 1`,
        [req.userId]
      );
      if (existing.rows.length > 0) {
        orgId = existing.rows[0].organization_id;
      } else {
        const org = await client.query(
          "INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id",
          [orgName.trim(), slug]
        );
        orgId = org.rows[0].id;
        await client.query(
          "INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'owner')",
          [orgId, req.userId]
        );
      }

      // 2. Create execute project
      const proj = await client.query(
        `INSERT INTO execute_projects (organization_id, key, name, description, settings)
         VALUES ($1, $2, $3, $4, $5) RETURNING id, key`,
        [orgId, key, projectName.trim(), projectDescription || null, JSON.stringify(initialSettings)]
      );
      const projectId = proj.rows[0].id;
      const projectKeyResult = proj.rows[0].key;

      // 3. Add creator as project admin
      await client.query(
        `INSERT INTO execute_project_members (execute_project_id, user_id, role)
         VALUES ($1, $2, 'admin')`,
        [projectId, req.userId]
      );

      return { organizationId: orgId, projectId, projectKey: projectKeyResult };
    });

    res.json(result);
  } catch (err) {
    logger.error("Onboarding org+project error:", err);
    res.status(500).json({ error: "Failed to create workspace and project" });
  }
});

// ---------------------------------------------------------------------------
// POST /onboarding/seed-demo
// Creates a demo project populated with realistic sample data so new users
// can explore the app without connecting real test infrastructure.
// ---------------------------------------------------------------------------

const DEMO_SPECS = [
  "tests/checkout/payment.spec.ts",
  "tests/checkout/cart.spec.ts",
  "tests/auth/login.spec.ts",
  "tests/auth/signup.spec.ts",
  "tests/products/catalog.spec.ts",
  "tests/products/search.spec.ts",
  "tests/orders/history.spec.ts",
  "tests/profile/settings.spec.ts",
];

const DEMO_TESTS_BY_SPEC = {
  "tests/checkout/payment.spec.ts": [
    "should complete checkout with valid card",
    "should reject expired card",
    "should handle 3DS authentication",
    "should apply discount code correctly",
    "should calculate tax based on shipping address",
  ],
  "tests/checkout/cart.spec.ts": [
    "should add item to cart",
    "should remove item from cart",
    "should update item quantity",
    "should persist cart across sessions",
    "should show out-of-stock warning",
  ],
  "tests/auth/login.spec.ts": [
    "should login with valid credentials",
    "should reject invalid password",
    "should lock account after 5 failed attempts",
    "should redirect to intended page after login",
    "should support SSO login",
  ],
  "tests/auth/signup.spec.ts": [
    "should register new user",
    "should reject duplicate email",
    "should validate password strength",
    "should send verification email",
  ],
  "tests/products/catalog.spec.ts": [
    "should display product grid",
    "should filter by category",
    "should sort by price ascending",
    "should sort by price descending",
    "should show product details on click",
    "should paginate results",
  ],
  "tests/products/search.spec.ts": [
    "should return results for valid query",
    "should show empty state for no results",
    "should highlight search terms",
    "should support autocomplete",
  ],
  "tests/orders/history.spec.ts": [
    "should list past orders",
    "should show order details",
    "should allow order cancellation",
    "should display tracking information",
  ],
  "tests/profile/settings.spec.ts": [
    "should update display name",
    "should change email address",
    "should update notification preferences",
    "should delete account",
  ],
};

function demoDate(daysAgo, hoursOffset = 0) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(d.getHours() - hoursOffset);
  return d;
}

function buildDemoRuns() {
  return [
    {
      runName: "Nightly Regression",
      status: "COMPLETED",
      daysAgo: 0,
      passRate: 0.92,
      totalTests: 38,
      duration: 284000,
    },
    {
      runName: "Smoke Tests — Pre-deploy",
      status: "COMPLETED",
      daysAgo: 1,
      passRate: 1.0,
      totalTests: 12,
      duration: 48000,
    },
    {
      runName: "Nightly Regression",
      status: "COMPLETED",
      daysAgo: 2,
      passRate: 0.79,
      totalTests: 38,
      duration: 296000,
    },
    {
      runName: "Checkout Flow — Critical Path",
      status: "FAILED",
      daysAgo: 3,
      passRate: 0.4,
      totalTests: 10,
      duration: 91000,
    },
    {
      runName: "Nightly Regression",
      status: "COMPLETED",
      daysAgo: 4,
      passRate: 0.87,
      totalTests: 38,
      duration: 271000,
    },
    {
      runName: "API Integration Tests",
      status: "COMPLETED",
      daysAgo: 5,
      passRate: 0.95,
      totalTests: 20,
      duration: 135000,
    },
    {
      runName: "Full Regression Suite",
      status: "COMPLETED",
      daysAgo: 7,
      passRate: 0.72,
      totalTests: 38,
      duration: 318000,
    },
    {
      runName: "Smoke Tests — Pre-deploy",
      status: "COMPLETED",
      daysAgo: 8,
      passRate: 1.0,
      totalTests: 12,
      duration: 51000,
    },
  ];
}

function pickStatus(passRate, idx) {
  const rand = (idx * 2654435761) % 1000;
  const threshold = Math.floor(passRate * 1000);
  if (rand < threshold) return "Passed";
  if (rand < threshold + 50) return "Skipped";
  return "Failed";
}

router.post("/seed-demo", requireAuth, async (req, res) => {
  try {
    const orgId = await query(
      "SELECT organization_id FROM organization_members WHERE user_id = $1 LIMIT 1",
      [req.userId]
    ).then((r) => r.rows[0]?.organization_id ?? null);

    if (!orgId) {
      return res.status(400).json({ error: "Create a workspace first" });
    }

    const existing = await query(
      "SELECT id FROM execute_projects WHERE organization_id = $1 AND is_demo = true AND archived_at IS NULL LIMIT 1",
      [orgId]
    );
    if (existing.rows.length > 0) {
      return res.json({ projectId: existing.rows[0].id, alreadyExists: true });
    }

    const projectId = await transaction(async (client) => {
      // Create the demo project
      const proj = await client.query(
        `INSERT INTO execute_projects (organization_id, key, name, description, is_demo, settings)
         VALUES ($1, 'DEMO', 'Demo — E-Commerce App', 'Sample project pre-loaded with realistic automation data so you can explore Tesbo Grid features.', true, $2)
         RETURNING id`,
        [
          orgId,
          JSON.stringify({
            framework: "playwright",
            language: "typescript",
            defaultBrowser: "chrome",
          }),
        ]
      );
      const pid = proj.rows[0].id;

      await client.query(
        `INSERT INTO execute_project_members (execute_project_id, user_id, role) VALUES ($1, $2, 'admin')`,
        [pid, req.userId]
      );

      // Seed report runs + tests
      const demoRuns = buildDemoRuns();
      for (let ri = 0; ri < demoRuns.length; ri++) {
        const run = demoRuns[ri];
        const startedAt = demoDate(run.daysAgo, 2);
        const completedAt = new Date(startedAt.getTime() + run.duration);
        const passed = Math.round(run.totalTests * run.passRate);
        const failed = run.totalTests - passed;

        const runRow = await client.query(
          `INSERT INTO report_runs
             (project_id, run_name, source_type, status, total_tests, passed, failed, skipped, duration_ms, started_at, completed_at)
           VALUES ($1,$2,'TESBOX_EXECUTION',$3,$4,$5,$6,0,$7,$8,$9)
           RETURNING id`,
          [pid, run.runName, run.status, run.totalTests, passed, failed, run.duration, startedAt, completedAt]
        );
        const runId = runRow.rows[0].id;

        // Distribute tests across specs
        const allTests = [];
        for (const spec of DEMO_SPECS) {
          const tests = DEMO_TESTS_BY_SPEC[spec] || [];
          for (const testName of tests) {
            allTests.push({ spec, testName });
          }
        }

        let testIdx = 0;
        for (const { spec, testName } of allTests) {
          if (testIdx >= run.totalTests) break;
          const status = pickStatus(run.passRate, ri * 100 + testIdx);
          const dur = 1200 + ((testIdx * 1337) % 8000);
          const errMsg = status === "Failed"
            ? `AssertionError: expected element to be visible but got hidden\n  at ${spec}:${30 + testIdx}`
            : null;
          await client.query(
            `INSERT INTO report_tests
               (report_run_id, spec, name, full_title, status, duration_ms, error_message, tags, steps)
             VALUES ($1,$2,$3,$4,$5,$6,$7,'[]','[]')`,
            [runId, spec, testName, `${spec} > ${testName}`, status, dur, errMsg]
          );
          testIdx++;
        }
      }

      // Seed demo alert rules
      await client.query(
        `INSERT INTO project_alerts
           (execute_project_id, name, metric, operator, threshold, unit, channel, recipients, enabled)
         VALUES
           ($1, 'Low Pass Rate', 'pass_ratio', 'below', 70, '%', 'in_app', '[]', true),
           ($1, 'High Failure Rate', 'failure_rate', 'above', 30, '%', 'in_app', '[]', true)`,
        [pid]
      );

      // Seed a couple of alert events so the Alerts page isn't empty
      const alertRows = await client.query(
        "SELECT id FROM project_alerts WHERE execute_project_id = $1",
        [pid]
      );
      if (alertRows.rows.length > 0) {
        const alertId = alertRows.rows[0].id;
        await client.query(
          `INSERT INTO project_alert_events
             (execute_project_id, alert_id, rule_title, summary, severity, metric, observed_value, threshold, triggered_at)
           VALUES
             ($1,$2,'Low Pass Rate','Pass rate dropped to 40% on Checkout Flow run','High','pass_ratio',40,70,$3),
             ($1,$2,'Low Pass Rate','Pass rate was 79% on Nightly Regression','Medium','pass_ratio',79,70,$4)`,
          [pid, alertId, demoDate(3), demoDate(2)]
        );
      }

      return pid;
    });

    res.json({ projectId });
  } catch (err) {
    logger.error("seed-demo error:", err);
    res.status(500).json({ error: "Failed to seed demo project" });
  }
});

export default router;
