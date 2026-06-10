ALTER TABLE execution_jobs
    ADD COLUMN IF NOT EXISTS language TEXT NOT NULL DEFAULT 'javascript',
    ADD COLUMN IF NOT EXISTS runtime_mode TEXT NOT NULL DEFAULT 'script',
    ADD COLUMN IF NOT EXISTS runtime_entrypoint TEXT,
    ADD COLUMN IF NOT EXISTS runtime_config_json JSONB NOT NULL DEFAULT '{}'::jsonb;

UPDATE execution_jobs
SET language = COALESCE(NULLIF(language, ''), 'javascript'),
    runtime_mode = COALESCE(NULLIF(runtime_mode, ''), 'script')
WHERE language IS NULL
   OR language = ''
   OR runtime_mode IS NULL
   OR runtime_mode = '';
