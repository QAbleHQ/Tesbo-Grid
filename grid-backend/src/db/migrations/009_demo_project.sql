-- Migration 009: Add is_demo flag to execute_projects

ALTER TABLE execute_projects
  ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_execute_projects_is_demo
  ON execute_projects(organization_id, is_demo);
