# System design — Cloudflare e-mail forwarding manager

A developer-oriented overview of how the app is built. For user-facing setup
and workflow, see [`README.md`](../README.md).

## Purpose

Manage Cloudflare Email Routing forwarding rules — mapping a source address to
**one or more** verified destinations — from a small local web app, and deploy
them (including multi-destination fan-out) directly to Cloudflare.

## Components

```
┌─────────────────────────────┐        ┌──────────────────────────────┐
│  Browser UI                 │  HTTP  │  Node server                 │
│  http://localhost:4748      │ ─────► │  scripts/serve-mappings.mjs  │
│  mappings/index.html        │  REST  │   • REST API + static files  │
│  mappings/app.js            │ ◄───── │   • REST API + static files  │
│  (browser)                  │  JSON  │   • in-memory mapping store   │
└─────────────────────────────┘        │   • crypto (node:crypto)     │
                                        └───────────────┬──────────────┘
                                                        │ HTTPS, Bearer token
                                                        ▼
                                        ┌──────────────────────────────┐
                                        │  scripts/cloudflare.mjs      │
                                        │   • Cloudflare API client    │
                                        │   • plan() / deploy()        │
                                        │   • generateWorkerSource()   │
                                        └───────────────┬──────────────┘
                                                        │
                                                        ▼
                                            api.cloudflare.com/client/v4
                                            (Email Routing + Workers)
```

There is **no CORS proxy and no separate email worker source file**. The Node
backend calls `api.cloudflare.com` directly (server-to-server, so CORS does not
apply), and the fan-out Worker is generated as a string at deploy time by
`generateWorkerSource()` in `scripts/cloudflare.mjs`.

## Tech stack

- **Node.js 22+**, zero npm runtime dependencies. Uses built-in `node:http`,
  `node:crypto`, `node:fs`.
- **Frontend:** plain ES-module JavaScript, no build step, no framework.
- **Storage:** none for mappings — Cloudflare is the source of truth. Mappings
  live in an in-memory store for the session, seeded from Cloudflare. Only the
  encrypted token + selected account persist, in `data/settings.json`.

Keep it dependency-free and build-free; that is a deliberate design choice.

## File layout

| Path | Responsibility |
|---|---|
| `mappings/index.html` | UI shell: tab bar, all tab panels (Overview / Connection / Destinations / Mappings / Guide), dialogs, inline CSS. |
| `mappings/app.js` | Frontend controller: tab switching, CRUD calls, rendering live Cloudflare status, deploy & import wizards. |
| `scripts/serve-mappings.mjs` | HTTP server: REST API, in-memory mapping store, static file serving. |
| `scripts/cloudflare.mjs` | All Cloudflare logic: encrypted token storage, API client, `plan()`, `deploy()`, `reconstructMappings()`, fan-out Worker generation. |
| `data/` | Runtime state (gitignored): `settings.json` (encrypted token + account) and `.cf-keyfile`. |

## Data model (in-memory)

Mappings are not persisted locally. On first access (when a token + account are
configured) the server calls `reconstructMappings()` to rebuild the full set
from Cloudflare — single-destination forward rules directly, and
multi-destination / catch-all rules via the fan-out Worker's embedded manifest
— and holds them in a session store:

```
store.mappings: [{ id, localPart, domain, destinations[] }]   -- source = localPart@domain
settings.json: { cf_token_enc, cf_account_id, cf_worker_name }  -- the only persisted state
```

Edits mutate the store; **Deploy** pushes it to Cloudflare. A restart clears the
store (dropping any undeployed edits) and re-seeds from Cloudflare. Domains are
not stored — the mapping editor's domain picker is populated from the account's
Cloudflare zones (`listZones()`).

## REST API

All endpoints return JSON. Mapping CRUD mutates the in-memory session store;
the `/api/cloudflare/*` endpoints proxy to the Cloudflare API using the stored
token.

| Method & path | Purpose |
|---|---|
| `GET /api/state` | All staged mappings (seeds from Cloudflare on first access) |
| `POST /api/mappings` `{localPart, domain, destinations[]}` | Create a mapping (staged) |
| `PUT /api/mappings/:id` | Replace a mapping (staged) |
| `DELETE /api/mappings/:id` | Delete a mapping (staged) |
| `POST /api/import` `{csv}` | Bulk upsert mappings into the store |
| `GET /api/cloudflare/status` | Token / account connection state |
| `GET /api/cloudflare/zones` | Zones in the account (domain picker source) |
| `POST /api/cloudflare/token` `{token}` | Verify + store the token (encrypted); returns accounts |
| `DELETE /api/cloudflare/token` | Forget the stored token |
| `POST /api/cloudflare/account` `{accountId}` | Select the deploy target account |
| `GET /api/cloudflare/plan` | Preflight: per-domain status, destination status, mapping readiness, deploy state, orphans |
| `POST /api/cloudflare/import-orphans` `{sources}` | Import rules that exist on Cloudflare but not in the store |
| `GET /api/cloudflare/destinations` | List destination addresses (verified/pending) |
| `POST /api/cloudflare/destinations` `{email}` | Add + trigger verification for one address |
| `POST /api/cloudflare/destinations/add-missing` | Add + verify every missing destination |
| `DELETE /api/cloudflare/destinations/:email` | Remove a destination address |
| `POST /api/cloudflare/enable-routing` `{zoneId}` | Enable Email Routing for a zone |
| `POST /api/cloudflare/deploy` | Apply rules + fan-out Worker for *ready* mappings |

## MCP interface

The same REST API is exposed over the **Model Context Protocol** so AI agents /
MCP clients can drive the tool. Both servers are thin wrappers — every tool just
calls the existing `/api/*` routes, so there is no duplicated logic. Tools:
`get_status`, `list_zones`, `list_mappings`, `get_plan`, `create_mapping`,
`update_mapping`, `delete_mapping`, `import_mappings_csv`, `list_destinations`,
`add_destination`, `import_destinations_csv`, `deploy`.

| Server | Transport | Talks to |
|---|---|---|
| `mcp/server.mjs` | stdio (local desktop clients) | any backend over HTTP via `MCP_BASE_URL` (default the local Node server); adds `CF-Access-Client-*` headers for the hosted Worker |
| `worker/src/mcp.js` | Streamable HTTP at `/mcp` (remote) | the `SessionStore` Durable Object directly, in-process |

The hosted server uses the Agents SDK (`agents/mcp`, `createMcpHandler`), which
requires `nodejs_compat` and lazily references the `ai` peer dependency from
client-transport code the Worker never runs — aliased to `worker/src/ai-stub.js`
so it isn't bundled. The stdio server depends only on
`@modelcontextprotocol/sdk` + `zod`; the repo-root Node app stays
dependency-free.

## Forwarding model

| Mapping | What gets deployed |
|---|---|
| 1 destination | An Email Routing **rule** with a `forward` action (a plain alias — no Worker). |
| N destinations | A single generated **fan-out Worker** (`email-fanout`) embedding every multi-destination mapping, plus a rule with a `worker` action pointing at it. |
| `*@domain` | Cloudflare's per-domain **catch-all** rule — `forward` for one destination, or the fan-out Worker for several. |

`generateWorkerSource()` emits a single-module Worker whose `email()` handler
calls `message.forward()` for each destination in parallel (`Promise.allSettled`),
rejecting only if every forward fails.

## Plan & deploy

`plan()` inspects the connected account and reports, per domain:

- **ready** — zone in this account with Email Routing enabled.
- **zone-no-email** — zone exists but routing is off (offer *Enable routing*).
- **no-zone** — domain not in this account (explain how to add it).

It marks each destination **verified / pending / missing**, splits mappings into
**ready** vs **blocked** (with the exact blocker), computes a per-mapping
**deploy state** (deployed / outdated / absent / unknown), and detects
**orphans** (rules on Cloudflare with no local mapping — importable, or
undecipherable if the matcher can't be interpreted).

`deploy()` acts only on **ready** mappings (domain email-ready **and** all
destinations verified); everything else is reported as skipped with a reason.
Deploys are **idempotent** — rules for the same address are updated in place,
never duplicated.

## Token security

- The token is encrypted with **AES-256-GCM** before being written to
  `data/settings.json`.
- The 32-byte key is stored separately in `data/.cf-keyfile` (gitignored,
  `0600` where the OS allows). `settings.json` without the keyfile does not
  reveal the token.
- The token never reaches the browser; the frontend only ever sees connection
  *status*, not the secret.

## Important gotchas

- **Email Routing `verified` is a timestamp string or `null`**, not a boolean.
  Truthy = verified.
- **`workers.dev` subdomain is per-script and off by default.** Enabling a new
  Worker's subdomain requires
  `POST /accounts/{id}/workers/scripts/{name}/subdomain` with
  `{enabled:true, previews_enabled:true}`.
- **First request after a fresh Worker deploy can return error 1104.** Retry.
- **The custom-address binding is not API-managed** in all cases — pointing a
  brand-new domain at Cloudflare still needs the domain's MX records to point at
  Cloudflare, and DNS can take minutes to propagate before mail is delivered.
- **Server restart rule:** edits to `cloudflare.mjs` / `serve-mappings.mjs`
  require restarting `npm start`. Edits to `mappings/index.html` /
  `mappings/app.js` only need a browser reload.

## Hosting considerations

The local server keeps only the encrypted token on disk (`settings.json` +
keyfile) — mappings live on Cloudflare — but it runs as a long-lived Node
process, so it cannot run on Cloudflare Workers unchanged.

The [`worker/`](../worker) directory implements the hosted path: the same UI and
REST API on **Cloudflare Workers**, with the long-lived process replaced by a
**`SessionStore` Durable Object** (the in-memory staged store) and the token
persisted **encrypted in D1** instead of a local keyfile. Authentication is
delegated entirely to **Cloudflare Access** at the edge, so the Worker contains
no auth code. See [`worker/README.md`](../worker/README.md).

Either way, put **Cloudflare Access** (or an equivalent identity gate) in front:
the app both controls email forwarding and holds a Cloudflare API token, so the
front door must be authenticated.
