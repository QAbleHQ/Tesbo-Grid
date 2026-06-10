CREATE TABLE IF NOT EXISTS execute_project_invitations (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id    UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    execute_project_id UUID NOT NULL REFERENCES execute_projects(id) ON DELETE CASCADE,
    email              VARCHAR(320) NOT NULL,
    role               VARCHAR(32) NOT NULL DEFAULT 'member',
    token              UUID NOT NULL UNIQUE,
    expires_at         TIMESTAMPTZ NOT NULL,
    accepted_at        TIMESTAMPTZ,
    created_by         UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_execute_project_invitations_project
    ON execute_project_invitations(execute_project_id);

CREATE INDEX IF NOT EXISTS idx_execute_project_invitations_email
    ON execute_project_invitations(email);
