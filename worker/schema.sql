-- Schema for the Cloudflare-hosted Email Forwarding Manager (D1).
-- Only the encrypted Cloudflare API token + selected account are stored here;
-- mappings live in the SessionStore Durable Object (seeded from Cloudflare).
-- Apply with:
--   wrangler d1 execute email-forwarding-manager --remote --file schema.sql

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
