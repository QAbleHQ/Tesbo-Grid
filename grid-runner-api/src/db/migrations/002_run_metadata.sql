-- Stores caller-provided metadata (AI model config, etc.) that must be
-- forwarded to workers but doesn't belong in the core execution schema.
ALTER TABLE execution_runs
    ADD COLUMN IF NOT EXISTS metadata_json JSONB DEFAULT '{}'::jsonb;
