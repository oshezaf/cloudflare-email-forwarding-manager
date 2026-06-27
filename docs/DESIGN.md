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
│  mappings/app.js            │ ◄───── │   • SQLite (node:sqlite)     │
└─────────────────────────────┘  JSON  │   • crypto (node:crypto)     │
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
  `node:sqlite`, `node:crypto`, `node:fs`.
- **Frontend:** plain ES-module JavaScript, no build step, no framework.
- **Storage:** a single SQLite file at `data/mappings.db`.

Keep it dependency-free and build-free; that is a deliberate design choice.

## File layout

| Path | Responsibility |
|---|---|
| `mappings/index.html` | UI shell: tab bar, all tab panels (Overview / Connection / Destinations / Mappings / Guide), dialogs, inline CSS. |
| `mappings/app.js` | Frontend controller: tab switching, CRUD calls, rendering live Cloudflare status, deploy & import wizards. |
| `scripts/serve-mappings.mjs` | HTTP server: REST API, SQLite schema + queries, static file serving. |
| `scripts/cloudflare.mjs` | All Cloudflare logic: encrypted token storage, API client, `plan()`, `deploy()`, fan-out Worker generation. |
| `data/` | Runtime state (gitignored): `mappings.db` and `.cf-keyfile`. |

## Data model (SQLite)

```
domains(id, name UNIQUE COLLATE NOCASE)
mappings(id, local_part, domain_id → domains.id, created_at)   -- source = local_part@domain
destinations(id, mapping_id → mappings.id, email)
settings(...)                                                  -- encrypted CF token, selected account
```

Deleting a domain cascades to its mappings; deleting a mapping cascades to its
destinations.

## REST API

All endpoints return JSON. Mapping/domain CRUD is purely local; the
`/api/cloudflare/*` endpoints proxy to the Cloudflare API using the stored
token.

| Method & path | Purpose |
|---|---|
| `GET /api/state` | All domains + mappings (with destinations) |
| `POST /api/domains` `{name}` | Add a domain |
| `DELETE /api/domains/:id` | Remove a domain (cascades) |
| `POST /api/mappings` `{localPart, domainId, destinations[]}` | Create a mapping |
| `PUT /api/mappings/:id` | Replace a mapping |
| `DELETE /api/mappings/:id` | Delete a mapping |
| `POST /api/import` `{csv}` | Transactional CSV import |
| `GET /api/cloudflare/status` | Token / account connection state |
| `POST /api/cloudflare/token` `{token}` | Verify + store the token (encrypted); returns accounts |
| `DELETE /api/cloudflare/token` | Forget the stored token |
| `POST /api/cloudflare/account` `{accountId}` | Select the deploy target account |
| `GET /api/cloudflare/plan` | Preflight: per-domain status, destination status, mapping readiness, deploy state, orphans |
| `POST /api/cloudflare/import-orphans` `{sources}` | Import rules that exist on Cloudflare but not locally |
| `GET /api/cloudflare/destinations` | List destination addresses (verified/pending) |
| `POST /api/cloudflare/destinations` `{email}` | Add + trigger verification for one address |
| `POST /api/cloudflare/destinations/add-missing` | Add + verify every missing destination |
| `DELETE /api/cloudflare/destinations/:email` | Remove a destination address |
| `POST /api/cloudflare/enable-routing` `{zoneId}` | Enable Email Routing for a zone |
| `POST /api/cloudflare/deploy` | Apply rules + fan-out Worker for *ready* mappings |

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
  `settings` in `data/mappings.db`.
- The 32-byte key is stored separately in `data/.cf-keyfile` (gitignored,
  `0600` where the OS allows). The database without the keyfile does not reveal
  the token.
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

The current server keeps state on local disk (SQLite + keyfile), so it cannot
run on Cloudflare Workers unchanged. Two viable paths for a hosted version:

1. **Small VM/container behind a Cloudflare Tunnel + Cloudflare Access**
   (least rewrite — run the Node server as-is, gate the front door).
2. **Port the storage layer to D1/KV** and run the API on Workers.

Either way, put **Cloudflare Access** (or an equivalent identity gate) in front:
the app both controls email forwarding and holds a Cloudflare API token, so the
front door must be authenticated.
