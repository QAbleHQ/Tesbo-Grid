-- Add per-organization settings bag. First use: `maxConcurrentJobs` — the
-- maximum number of execution_jobs the org can have running across all its
-- projects at the same time. Default 5 (enforced in code, not in the column
-- default) so a single noisy customer can't monopolize the cluster and run
-- up the bill.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT '{}'::jsonb;
