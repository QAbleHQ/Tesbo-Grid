-- Add public sharing functionality to report runs
-- This allows users to generate public URLs for sharing test run results

ALTER TABLE report_runs ADD COLUMN public_share_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE report_runs ADD COLUMN public_share_token VARCHAR(64) UNIQUE;

-- Create index on public_share_token for faster lookups
CREATE INDEX IF NOT EXISTS idx_report_runs_public_share_token 
ON report_runs (public_share_token) 
WHERE public_share_token IS NOT NULL;

-- Add comment explaining the new fields
COMMENT ON COLUMN report_runs.public_share_enabled IS 'Whether this run can be viewed via public URL without authentication';
COMMENT ON COLUMN report_runs.public_share_token IS 'Unique token for public access to this run. Generated when public sharing is enabled';