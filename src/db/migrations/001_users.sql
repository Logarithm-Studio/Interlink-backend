-- 001_users.sql
-- Create users table (core identity, synced from Supabase Auth)

CREATE TABLE IF NOT EXISTS users (
  id          UUID PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,
  timezone    TEXT DEFAULT 'UTC',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);
