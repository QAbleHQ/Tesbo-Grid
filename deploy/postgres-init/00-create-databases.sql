-- Runs once on first Postgres start (docker-entrypoint-initdb.d).
-- POSTGRES_DB creates the backend database (tesbo_grid); this adds the
-- separate execution database used by grid-runner-api + grid-selenium-proxy.
SELECT 'CREATE DATABASE tesbo_execution'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'tesbo_execution')\gexec
