-- Schema for the Cloudflare-hosted Email Forwarding Manager (D1).
-- Mirrors the local app's SQLite schema. Apply with:
--   wrangler d1 execute email-forwarding-manager --remote --file schema.sql

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS domains (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE
);

CREATE TABLE IF NOT EXISTS mappings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  local_part TEXT NOT NULL,
  domain_id  INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (local_part, domain_id)
);

CREATE TABLE IF NOT EXISTS destinations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  mapping_id INTEGER NOT NULL REFERENCES mappings(id) ON DELETE CASCADE,
  email      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
