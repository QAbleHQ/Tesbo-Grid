-- Denormalize organization_id onto execution_runs so the dispatcher can
-- enforce a per-organization concurrency cap without joining across the
-- grid-backend schema on every poll.
--
-- The dispatcher resolves an organization's "in-flight test cases" by
-- summing across all runs owned by that org. Doing this through
-- execute_projects.organization_id at dispatch time means a cross-table
-- join on the hot path and a cache miss on every poll (5s interval).
-- Stamping organization_id at run-create keeps the per-poll query on a
-- single indexed column.

ALTER TABLE execution_runs
  ADD COLUMN IF NOT EXISTS organization_id UUID;

-- Per-org dispatch queries filter by (organization_id, status) and read
-- `started_at`. Composite index keeps the planner on an index scan even
-- when one tenant has many historical runs.
CREATE INDEX IF NOT EXISTS idx_execution_runs_org_status
  ON execution_runs(organization_id, status)
  WHERE organization_id IS NOT NULL;
