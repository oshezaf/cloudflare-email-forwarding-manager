# Agent & contributor notes — `cloudflare-email-forwarding-manager`

If you are an AI agent or a new contributor picking up this repo, read this
first. It is short by design. Full architecture is in
[`docs/DESIGN.md`](docs/DESIGN.md); user-facing setup is in
[`README.md`](README.md).

## What this repo is

A self-hosted local web app that manages **Cloudflare Email Routing**
forwarding rules — mapping a source address to one or more verified
destinations — and deploys them (including multi-destination fan-out) to
Cloudflare from the UI.

Three moving parts, all in this repo:

1. **Frontend** — `mappings/index.html` + `mappings/app.js`. Plain ES-module
   JavaScript, no build step. Tabs: Overview, Connection, Destinations,
   Mappings, Guide. Deploy and CSV import are wizard modals.
2. **Node server** — `scripts/serve-mappings.mjs`. REST API + static serving.
   Mappings are kept in an **in-memory store for the session** (seeded from
   Cloudflare); nothing is persisted locally except the encrypted token. Zero
   npm dependencies. Port 4748 (`PORT` overrides).
3. **Cloudflare client** — `scripts/cloudflare.mjs`. All Cloudflare API logic:
   encrypted token storage, `plan()`, `deploy()`, `reconstructMappings()`, and
   inline generation of the fan-out Worker (`generateWorkerSource`).

State lives in `data/` (gitignored): `settings.json` (encrypted token +
selected account) and `.cf-keyfile` (AES-256-GCM key for the token). There is
no local mappings database — Cloudflare holds the mappings.

Two more parts extend it (each with its own `package.json` / dependencies —
kept out of the root app):

4. **Hosted Worker** — [`worker/`](worker/). The same UI + REST API on
   Cloudflare Workers: `src/index.js` (proxy + `/mcp`), `src/session.js`
   (`SessionStore` Durable Object = the in-memory store + all API routing),
   `src/cloudflare.js` (async/WebCrypto port of the CF client), token in **D1**,
   auth via **Cloudflare Access**. `src/cloudflare.js` and `src/session.js` are
   ports of `scripts/cloudflare.mjs` — keep the two in sync when changing logic.
5. **MCP servers** — `mcp/server.mjs` (local **stdio** proxy over the REST API)
   and `worker/src/mcp.js` (remote **Streamable HTTP** at `/mcp` via
   `agents/mcp`). Both are thin wrappers exposing the REST API as MCP tools; no
   logic is duplicated.

## Hard rules

- **No hard-coded forwarding state. Cloudflare is the source of truth.**
  Mappings are reconstructed from live Cloudflare rules + the fan-out Worker's
  embedded manifest (`reconstructMappings`) and held in an in-memory store for
  the session. Edits stage in that store until **Deploy** pushes them; a server
  restart drops unsaved edits and re-seeds from Cloudflare. The UI must never
  assume a rule exists — it asks.
- **The Node backend calls `api.cloudflare.com` directly.** There is no CORS
  proxy and no separate email-worker source file. Don't reintroduce them.
- **Keep the root app dependency-free and build-free.** No TypeScript, no
  bundler, no framework, no npm runtime deps in the repo root. The server relies
  on Node 22 built-ins (`node:http`, `node:crypto`, `node:fs`). Don't add
  dependencies to the root app — and don't reintroduce a local database —
  without a strong reason. (`worker/` and `mcp/` have their own dependencies;
  that is fine — just don't let them leak into the root `package.json`.)
- **Never send the token to the browser.** It is stored encrypted server-side;
  the frontend only sees connection *status*.
- **Don't run the UI from `file://`.** Browsers block ES-module loading there.
  Use `npm start` (serves over `localhost`).
- **Keep `deploy()` idempotent.** Rules for the same address are updated in
  place, never duplicated; only *ready* mappings are applied.

## Common tasks

| Task | How |
|---|---|
| Run the app locally | `npm start` → http://localhost:4748 |
| Syntax-check the server | `node --check scripts/serve-mappings.mjs` |
| Syntax-check the CF client | `node --check scripts/cloudflare.mjs` |
| Build-check the hosted Worker | `cd worker && npx wrangler deploy --dry-run --outdir dist` (needs `worker/` deps installed) |
| Run the stdio MCP server | `cd mcp && npm install && node server.mjs` (set `MCP_BASE_URL`) |
| Reset local state | delete `data/settings.json` (and `data/.cf-keyfile` to drop the token). Mappings are on Cloudflare, so there is nothing else local to reset. |

**Restart rule:** editing `serve-mappings.mjs` or `cloudflare.mjs` requires
restarting `npm start`. Editing `mappings/index.html` or `mappings/app.js`
only needs a browser reload.

## Recurring gotchas

See `docs/DESIGN.md` → "Important gotchas" for the full list. High-signal ones:

- Email Routing `verified` is a timestamp string or `null`, not a boolean.
  Truthy = verified.
- A new Worker's `workers.dev` subdomain is off by default and is enabled
  per-script.
- The first request after a fresh Worker deploy can return error 1104. Retry.
- Pointing a brand-new domain at Cloudflare still needs MX records + DNS
  propagation before mail flows.

## Style

- Plain JavaScript, ES modules, 2-space indent. Match the surrounding code.
- Only comment code that genuinely needs clarification.
- Surgical changes; don't refactor unrelated code.
