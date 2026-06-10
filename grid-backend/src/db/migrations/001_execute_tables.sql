-- Standalone bootstrap tables for Tesbo-Grid grid-backend.
-- Keep every object IF NOT EXISTS so this script is safe against pre-provisioned schemas.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email      VARCHAR(320) NOT NULL UNIQUE,
    name       VARCHAR(255),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS organizations (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name       VARCHAR(255) NOT NULL,
    slug       VARCHAR(255) NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS organization_members (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role            VARCHAR(32) NOT NULL DEFAULT 'member',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(organization_id, user_id)
);

CREATE TABLE IF NOT EXISTS projects (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
    key             VARCHAR(64),
    name            VARCHAR(255) NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    user_agent TEXT,
    ip_address TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS otp_codes (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email      VARCHAR(320) NOT NULL,
    code_hash  TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at    TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS otp_rate_limit (
    email         VARCHAR(320) PRIMARY KEY,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    locked_until  TIMESTAMPTZ,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workspace_ai_keys (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL,
    provider        VARCHAR(64) NOT NULL,
    api_key         TEXT NOT NULL,
    default_model   VARCHAR(255),
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workspace_invitations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    email           VARCHAR(320) NOT NULL,
    role            VARCHAR(32) NOT NULL DEFAULT 'member',
    token           UUID NOT NULL UNIQUE,
    expires_at      TIMESTAMPTZ NOT NULL,
    accepted_at     TIMESTAMPTZ,
    created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_otp_codes_email ON otp_codes(email);
CREATE INDEX IF NOT EXISTS idx_organization_members_user ON organization_members(user_id);
CREATE INDEX IF NOT EXISTS idx_workspace_ai_keys_org ON workspace_ai_keys(organization_id);
CREATE INDEX IF NOT EXISTS idx_workspace_invitations_org ON workspace_invitations(organization_id);

-- Execute-specific tables (IF NOT EXISTS because legacy TesboX schemas may already contain them)

CREATE TABLE IF NOT EXISTS execute_projects (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    key             VARCHAR(32) NOT NULL,
    name            VARCHAR(255) NOT NULL,
    description     TEXT,
    settings        JSONB DEFAULT '{}',
    archived_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(organization_id, key)
);

CREATE TABLE IF NOT EXISTS execute_project_members (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    execute_project_id UUID NOT NULL REFERENCES execute_projects(id) ON DELETE CASCADE,
    user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role               VARCHAR(32) NOT NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(execute_project_id, user_id)
);

CREATE TABLE IF NOT EXISTS tesbox_execute_project_links (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tesbox_project_id     UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    execute_project_id    UUID NOT NULL REFERENCES execute_projects(id) ON DELETE CASCADE,
    execute_project_key   VARCHAR(64),
    execute_api_key_id    VARCHAR(255),
    execute_api_key_name  VARCHAR(255),
    execute_api_key_value TEXT,
    execute_api_key_masked VARCHAR(255),
    status                VARCHAR(32) NOT NULL DEFAULT 'linked',
    created_by            UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_by            UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(tesbox_project_id)
);

CREATE TABLE IF NOT EXISTS execute_project_ai_key_allocations (
    execute_project_id  UUID PRIMARY KEY REFERENCES execute_projects(id) ON DELETE CASCADE,
    workspace_ai_key_id UUID REFERENCES workspace_ai_keys(id) ON DELETE SET NULL,
    allocated_by        UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_execute_projects_org ON execute_projects(organization_id);
CREATE INDEX IF NOT EXISTS idx_execute_project_members_user ON execute_project_members(user_id);
CREATE INDEX IF NOT EXISTS idx_tesbox_execute_links_execute_project ON tesbox_execute_project_links(execute_project_id);
