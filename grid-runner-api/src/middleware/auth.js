import { query } from "../db/database.js";
import { config } from "../config.js";
import {
  hashApiKey,
  lookupApiKeyRow,
  TESBO_KEY_SCOPES,
  createTesboKeyResolver,
} from "@tesbox/playwright-runner/apiKeyAuth";

export { hashApiKey };

// Backend's /project-by-key response carries the project's owning
// organization. We can't read execute_projects from this service's database
// (it lives in grid-backend's schema), so we stash the org keyed by access
// key as the resolver resolves it — mirroring how grid-selenium-proxy primes
// its limits cache via onResolved. Keying by accessKey keeps concurrent
// requests for different keys from clobbering each other.
const orgByAccessKey = new Map();
const resolveProjectFromTesboKey = createTesboKeyResolver({
  tesboApiUrl: config.tesboApiUrl,
  onResolved(payload, { accessKey } = {}) {
    if (accessKey && payload?.projectId) {
      orgByAccessKey.set(accessKey, payload.organizationId || null);
    }
  },
});

export function apiKeyAuth(requiredScope = null) {
  return async (req, res, next) => {
    const apiKey = req.header("x-api-key");
    const agentToken = req.header("x-agent-token");

    if (agentToken) {
      req.authType = "agent";
      req.agentToken = agentToken;
      return next();
    }

    if (!apiKey) {
      return res.status(401).json({ error: "Missing x-api-key header" });
    }

    const keyRow = await lookupApiKeyRow(query, apiKey);

    if (!keyRow && apiKey.startsWith("tesbo_")) {
      if (requiredScope && !TESBO_KEY_SCOPES.has(requiredScope)) {
        return res.status(403).json({ error: `Insufficient scope: ${requiredScope}` });
      }
      try {
        const projectId = await resolveProjectFromTesboKey(apiKey);
        if (!projectId) {
          return res.status(401).json({ error: "Invalid API key" });
        }
        req.authType = "tesbo_key";
        req.apiKeyId = null;
        req.apiKeyProjectId = projectId;
        req.apiKeyOrganizationId = orgByAccessKey.get(apiKey) || null;
        req.apiKeyMetadata = {
          tesboConfig: {
            tesboApiUrl: config.tesboApiUrl,
            tesboUiUrl: config.tesboUiUrl,
            tesboAccessKey: apiKey,
          },
        };
        return next();
      } catch (err) {
        if (err.upstreamStatus >= 500) {
          return res.status(503).json({ error: "Auth service temporarily unavailable, please retry" });
        }
        return res.status(401).json({ error: "Invalid API key" });
      }
    }

    if (!keyRow) {
      return res.status(401).json({ error: "Invalid API key" });
    }

    if (requiredScope && !keyRow.scopes.includes(requiredScope)) {
      return res.status(403).json({ error: `Insufficient scope: ${requiredScope}` });
    }

    await query("UPDATE api_keys SET last_used_at = now() WHERE id = $1", [keyRow.id]);

    req.authType = "api_key";
    req.apiKeyId = keyRow.id;
    req.apiKeyProjectId = keyRow.project_id;
    // txe_ keys are resolved in-database here; this service's DB has no
    // execute_projects to read the org from, so it stays null and the
    // dispatcher falls back to per-project / global limits.
    req.apiKeyOrganizationId = keyRow.metadata_json?.organizationId || null;
    req.apiKeyMetadata = keyRow.metadata_json || {};
    next();
  };
}

export function internalAuth(sharedToken = "") {
  return (req, res, next) => {
    if (!sharedToken) return next();
    const token = req.header("x-agent-token") || req.header("x-automation-token");
    if (token !== sharedToken) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    next();
  };
}
