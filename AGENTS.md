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
2. **Node server** — `scripts/serve-mappings.mjs`. REST API + static serving +
   SQLite (`node:sqlite`). Zero npm dependencies. Port 4748 (`PORT` overrides).
3. **Cloudflare client** — `scripts/cloudflare.mjs`. All Cloudflare API logic:
   encrypted token storage, `plan()`, `deploy()`, and inline generation of the
   fan-out Worker (`generateWorkerSource`).

State lives in `data/` (gitignored): `mappings.db` (SQLite) and `.cf-keyfile`
(AES-256-GCM key for the encrypted token).

## Hard rules

- **No hard-coded forwarding state.** The SQLite DB is the design source of
  truth; live deployment/verification status is always read back from the
  Cloudflare API. The UI must never assume a rule exists — it asks.
- **The Node backend calls `api.cloudflare.com` directly.** There is no CORS
  proxy and no separate email-worker source file. Don't reintroduce them.
- **Keep it dependency-free and build-free.** No TypeScript, no bundler, no
  framework, no npm runtime deps. The server relies on Node 22 built-ins
  (`node:sqlite`, `node:crypto`). Don't add dependencies without a strong
  reason.
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
| Reset local state | delete `data/mappings.db` (and `data/.cf-keyfile` to drop the token) |

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
