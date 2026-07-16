# Cloudflare-hosted Email Forwarding Manager

This directory deploys the Email Forwarding Manager **as a Cloudflare Worker**,
so you can run it without keeping a machine on. It is functionally identical to
the local Node app in the repo root — same UI, same API, same Cloudflare
Email Routing deploy logic — but:

| | Local app (repo root) | Hosted Worker (this dir) |
|---|---|---|
| Runtime | Node 22 (`node:http`, `node:crypto`) | Cloudflare Workers |
| Storage | none for mappings (live from Cloudflare); token in `data/settings.json` | none for mappings (staged in a Durable Object); token in D1 |
| UI | served by the Node server | Workers Static Assets (`../mappings`) |
| Auth | none (localhost only) | **Cloudflare Access** at the edge |
| API token | encrypted with a local keyfile | encrypted in D1 with a Worker secret |

The frontend in [`../mappings`](../mappings) is reused **verbatim** — it only
ever talks to relative `/api/*` routes, which this Worker serves.

> **Two different Workers.** This Worker (`email-forwarding-manager`) is the
> *management app*. It is separate from the *fan-out* Worker
> (`email-fanout`) that the app generates and deploys to actually forward your
> mail. Deploying this one does not forward any email by itself.

---

## Architecture

```
Browser ──► Cloudflare Access (Google login)
              │  (only authorised users get through)
              ▼
        Worker: email-forwarding-manager
         ├─ static UI              ← Workers Static Assets (../mappings)
         ├─ /api/* JSON API        ← src/index.js (thin proxy)
         ├─ /mcp remote MCP        ← src/mcp.js (Streamable HTTP via agents/mcp)
         ├─ SessionStore (DO)      ← in-memory staged mappings, seeded from Cloudflare
         ├─ D1 (binding DB)        ← encrypted token + selected account only
         └─ Cloudflare API         ← reads live state; deploys rules + the email-fanout worker
```

- `src/index.js` — thin fetch handler that forwards every `/api/*` request to a
  single `SessionStore` Durable Object, and serves the remote MCP endpoint at
  `/mcp`.
- `src/mcp.js` — remote MCP server (Streamable HTTP via `agents/mcp`) exposing
  the REST API as MCP tools. Stateless: a fresh server per request; all state
  lives in the `SessionStore` DO, which every tool calls through the same
  `/api/*` interface, so there is no duplicated logic.
- `src/ai-stub.js` — tiny stub aliased (in `wrangler.toml`) for the Agents SDK's
  optional `ai` peer dependency, which its client-transport code lazily imports
  but this Worker never runs. Keeps the bundle from pulling in the full AI SDK.
- `src/session.js` — the `SessionStore` Durable Object: the in-memory staged
  mapping store + all API routing (the hosted equivalent of the local app's
  long-lived `scripts/serve-mappings.mjs` process). Mappings are reconstructed
  from Cloudflare and staged in the DO's memory until **Deploy**; they are
  **not** stored in a database. Domains come from the account's zones.
- `src/cloudflare.js` — async port of the Cloudflare client; encrypts the stored
  API token with WebCrypto AES-GCM using the `ENC_KEY` secret.
- `schema.sql` — D1 schema (just the `settings` table for the token).
- `wrangler.toml` — Worker + assets + D1 + Durable Object config.

There is **no auth code** in the Worker on purpose. Access control is delegated
entirely to Cloudflare Access so that only people you authorise can reach the
app and the stored token.

---

## Prerequisites

- A Cloudflare account with Workers, D1, Durable Objects and (for auth) Access available.
- [Node.js](https://nodejs.org/) 18+ and npm.
- Wrangler is installed locally as a dev dependency (`npm install` below).
- A Cloudflare API token for the app to use at runtime — same token the local
  app uses. You paste it into the UI after deploying; it is **not** a Wrangler
  credential and is not stored in `wrangler.toml`. See the root
  [`README.md`](../README.md) for the exact token permissions.

---

## First deploy

Run everything from this `worker/` directory.

### 1. Install tooling

```sh
npm install
```

### 2. Create the D1 database

```sh
npx wrangler d1 create email-forwarding-manager
```

Copy the `database_id` it prints into `wrangler.toml`, replacing the placeholder
`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`.

### 3. Create the schema

```sh
npm run db:init
```

(`db:init` runs the schema against the **remote** D1; `db:init:local` targets the
local dev database used by `wrangler dev`.)

### 4. Set the encryption key

The app stores your Cloudflare API token encrypted in D1. The encryption key is
a Worker secret named `ENC_KEY` — base64 of 32 random bytes:

```sh
# generate a key
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

# paste it when prompted
npx wrangler secret put ENC_KEY
```

Keep this value safe. If you lose or rotate it, the stored token can no longer
be decrypted — just paste the token into the UI again to re-store it.

### 5. Set the custom domain

Point the app at a hostname on a zone you already have in Cloudflare. Edit the
`[[routes]]` block in `wrangler.toml`:

```toml
[[routes]]
pattern = "mail-admin.example.com"   # change to your own subdomain
custom_domain = true
```

`custom_domain = true` tells Cloudflare this whole hostname *is* this Worker;
on deploy, wrangler provisions the DNS record and the TLS certificate for you —
no manual DNS entry needed.

> **This does not affect your mail.** A Worker custom domain is an **HTTPS**
> binding on that subdomain only. It does not touch the **MX** records or Email
> Routing configuration of the parent domain, so hosting the manager at
> `mail-admin.example.com` is independent of mail delivery to `@example.com`. Use
> a dedicated subdomain that isn't already in use, and avoid pointing it at a
> bare root domain you also use for email.

### 6. Deploy

```sh
npm run deploy
```

Wrangler uploads the Worker, the static UI from `../mappings`, and binds your
custom domain. The very first request after the domain is provisioned can
briefly return Cloudflare error 1104 — just retry.

### 7. Protect it with Cloudflare Access (do this before using it)

The app holds a Cloudflare API token, so it must not be publicly reachable.

1. Zero Trust dashboard → **Access → Applications → Add an application →
   Self-hosted**.
2. Set the application domain to your custom hostname (e.g.
   `mail-admin.example.com`).
3. Add an identity provider (e.g. **Google**) and a policy that allows only
   your own email address(es).
4. Save. Now every visit is gated by Google login at the edge.

### 8. Configure the app

Open the app URL, sign in through Access, then in the UI:

1. **Connection** tab → paste your Cloudflare API token. It is verified and
   stored encrypted in D1.
2. Pick your account if prompted.
3. Use **Destinations / Mappings** and the **Deploy** wizard exactly as in the
   local app.

> **Manual step (unchanged from local):** the Email Routing rule that points
> your source address at the generated `email-fanout` worker, and enabling Email
> Routing on the zone, are partly dashboard steps — the deploy wizard tells you
> what is needed. The route binding from your custom address to the fan-out
> worker is not fully API-managed.

### 9. (Optional) Use the remote MCP endpoint

Once deployed, the Worker also serves a remote **Streamable HTTP** MCP endpoint
at `/mcp`, behind the same Cloudflare Access. Point a remote-capable MCP client
at `https://<your-host>/mcp` and send an Access **service token** (the
`CF-Access-Client-Id` / `CF-Access-Client-Secret` headers). See the
[MCP server](../README.md#mcp-server) section of the root README.

---

## Day-to-day

```sh
npm run dev      # local dev server against a local D1 (wrangler dev)
npm run deploy   # push changes live
```

When you change `schema.sql`, re-run `npm run db:init` (remote) and/or
`npm run db:init:local`.

Because the UI is the shared `../mappings` directory, editing the frontend and
re-running `npm run deploy` here ships the same UI the local app uses.

---

## Notes & gotchas

- **D1 is separate storage.** The hosted app does not share data with the local
  app; the stored API token can't be migrated between them (different
  encryption layout).
- **Token permissions** are identical to the local app — see the root README.
- **Custom domain vs. mail.** The app's custom domain is HTTPS-only and does
  not affect the parent zone's MX / Email Routing — see step 5.
- **`nodejs_compat` is required.** The remote `/mcp` endpoint uses the Agents
  SDK (`agents/mcp`), which relies on `node:async_hooks`, so
  `compatibility_flags = ["nodejs_compat"]` is set in `wrangler.toml`. The app's
  own API code still uses only WebCrypto, Fetch and D1.
- **The `ai` alias.** The Agents SDK lazily imports the Vercel AI SDK (`ai`, a
  peer dependency) from client-transport code this Worker never runs.
  `wrangler.toml` aliases `ai` to `src/ai-stub.js` so the bundler resolves it
  without pulling in the full SDK.
- **Keep the root app zero-dependency.** All Wrangler tooling lives here in
  `worker/`; nothing in this directory should leak into the repo-root
  `package.json`.
