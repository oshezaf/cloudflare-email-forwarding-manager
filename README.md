# Cloudflare e-mail forwarding manager

A small, self-hosted web app for managing **Cloudflare Email Routing**
forwarding rules. Map a source address (`local-part@your-domain`) to **one or
more** verified destination mailboxes and deploy it to Cloudflare — including
true multi-destination **fan-out** — straight from the UI. Cloudflare is the
source of truth: your mappings are read live from Cloudflare, not kept in a
local database.

Cloudflare Email Routing on its own only forwards an address to a *single*
verified destination. This app removes that limit: when a mapping has several
destinations it generates and deploys a tiny **fan-out Worker** that forwards a
copy to each one, and wires the routing rule to it for you.

> Two ways to run it: this **locally deployable** Node app (below), or the
> **Cloudflare-hosted Worker** version in [`worker/`](worker/) (Workers + D1
> behind Cloudflare Access). See [Hosting it online](#hosting-it-online).

---

## Features

- **Domains from your account.** Source addresses can only use zones in your
  connected Cloudflare account, so you can't typo a rule onto the wrong domain.
- **One source → many destinations.** Simple aliases become Email Routing
  rules; multi-destination mappings become a generated fan-out Worker.
- **Catch-all support.** Use a `*` local part to forward every address on a
  domain.
- **Cloudflare is the source of truth.** Mappings are reconstructed live from
  Cloudflare (rules + the fan-out Worker's embedded manifest) and staged in
  memory for the session; edits apply when you **Deploy**. Nothing about
  forwarding is stored locally — only the encrypted API token persists.
- **Live Cloudflare status.** Once connected, every mapping shows whether it is
  deployed, needs an update, or is blocked (e.g. a destination still needs
  verification).
- **Guided deploy & import wizards.** Step-by-step deploy (check → validate
  addresses → deploy → done) and CSV import.
- **Encrypted token storage.** Your Cloudflare API token is stored encrypted
  (AES-256-GCM) on the server, never in the browser.
- **Scriptable + MCP.** A small JSON REST API backs both the local and hosted
  versions, and an [MCP server](#mcp-server) exposes the same operations as
  tools for AI agents.

---

## Requirements

- **Node.js 22 or newer.** The server uses Node's built-in `node:http` and
  `node:crypto`, so there are **no npm dependencies** to install.
- A Cloudflare account that owns the domain(s) you want to forward mail for,
  with **Email Routing** available.

Check your Node version:

```powershell
node --version   # must be v22.x or higher
```

---

## Quick start (run it locally)

```powershell
# 1. Get the code
git clone https://github.com/oshezaf/cloudflare-email-forwarding-manager.git
cd cloudflare-email-forwarding-manager

# 2. (Optional) create the lockfile — there are no runtime dependencies
npm install

# 3. Run it
npm start
```

`npm start` launches a local server on **http://localhost:4748** and opens it
in your default browser. Browsers block ES modules over `file://`, so the UI is
served over `localhost` instead. Set a different port with the `PORT`
environment variable:

```powershell
$env:PORT = 8080; npm start
```

You can design domains and mappings immediately — **no Cloudflare token is
required** until you want to deploy.

---

## Connecting to Cloudflare

To read live status and deploy, connect a Cloudflare API token in the
**Connection** tab.

### 1. Mint an API token

Cloudflare dashboard → **My Profile → API Tokens → Create Token → Create
Custom Token**. Grant:

| Scope | Permission | Used for |
|---|---|---|
| Account → **Workers Scripts** | Edit | deploying the fan-out Worker |
| Account → **Email Routing Addresses** | Edit | listing/adding/verifying destination addresses |
| Zone → **Email Routing Rules** | Edit | creating and updating forwarding rules |
| Zone → **Zone** | Read | discovering your zones and their Email Routing status |
| Account → **Account Settings** | Read *(optional)* | populating the account picker (otherwise paste the account ID) |

Restrict it to the relevant account/zones and set a sensible expiration.

### 2. Paste it into the app

Open the **Connection** tab, paste the token, and pick the account to deploy
to. The token is verified and stored **encrypted** in `data/settings.json`; the
32-byte key lives in `data/.cf-keyfile` (gitignored). Copying `settings.json`
without the keyfile does not reveal the token. Use **Forget token** to remove
it.

---

## Day-to-day workflow

1. **Connect** — on the **Connection** tab, paste your token and pick the
   account. Your existing mappings are read live from Cloudflare.
2. **Mappings** — create a mapping: a source local-part + domain (one of your
   Cloudflare zones) → one or more destination emails. Use `*` as the local
   part for a catch-all.
3. **Destinations** — Cloudflare requires every forwarding target to be a
   **verified** Destination Address. New destinations appear here; click
   **Send verification**, then click the link Cloudflare emails to that
   mailbox.
4. **Deploy** — open the deploy wizard (from Overview, Destinations or
   Mappings). It checks readiness, confirms all destinations are verified, then
   applies the rules and the fan-out Worker. Deploy is **idempotent** — existing
   rules are updated in place, never duplicated, and only *ready* mappings are
   applied.

Edits are staged in memory until you Deploy; if you restart the server before
deploying, undeployed edits are dropped and the view re-seeds from Cloudflare.
A mapping shows **Need verification** until all of its destinations are
verified; the deploy wizard will skip it (with the reason) until then.

### CSV import

The **Import** wizard accepts a two-column CSV (upload or paste):

| Column | Contents |
|---|---|
| `source` | A full source address, e.g. `info@example.org` |
| `destinations` | One or more destination emails, comma-separated (quote the cell if it contains commas) |

A header row is optional (auto-detected). The domain is inferred from each
source address. Existing source addresses are overwritten with the imported
destinations. Validation happens before anything changes — if any row is
invalid, nothing is staged and errors are reported with line numbers. Imported
mappings are staged; run **Deploy** to apply them to Cloudflare.

```csv
source,destinations
info@example.org,"alice@gmail.com, bob@outlook.com"
sales@example.org,team@gmail.com
```

---

## What runs where

The app holds **no hard-coded forwarding state**: Cloudflare is the source of
truth. Mappings are reconstructed live from Cloudflare and staged in memory for
the session; only the encrypted token persists locally.

| Data | Stored in |
|---|---|
| Domains, mappings, destinations | Cloudflare (read live; staged in memory during the session) |
| Cloudflare API token + account | encrypted in `data/settings.json` (key in `data/.cf-keyfile`) |
| Deployment / verification status | read live from the Cloudflare API on demand |

The `data/` directory is gitignored — your token and key never leave your
machine.

---

## Hosting it online

The Node app above is meant to run on your own machine. Because it controls
email forwarding **and** holds a Cloudflare API token, any networked deployment
must sit behind authentication.

For an always-on, no-machine-required option, use the **Cloudflare-hosted
Worker** version in [`worker/`](worker/). It runs the same UI and API as a
Cloudflare Worker backed by **D1**, behind
**[Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/)**
for Google/identity federation — so authentication is enforced at the edge with
no auth code in the app. Full setup is in [`worker/README.md`](worker/README.md).
See [`docs/DESIGN.md`](docs/DESIGN.md) for the architecture.

---

## API

The UI is a thin client over a small JSON REST API — the same routes back both
the local Node server and the hosted Worker. You can drive the whole tool
(import, deploy, manage destinations) from a script, a cron job, or an AI agent
without touching the browser. All request/response bodies are JSON.

| Method | Path | Body | Purpose |
|---|---|---|---|
| `GET` | `/api/state` | — | Staged mappings, domains and verified destinations |
| `POST` | `/api/import` | `{ csv }` | Bulk-import mappings from CSV (staged) |
| `POST` | `/api/mappings` | `{ localPart, domain, destinations[] }` | Create a mapping |
| `PUT` | `/api/mappings/{id}` | `{ localPart, domain, destinations[] }` | Update a mapping |
| `DELETE` | `/api/mappings/{id}` | — | Delete a mapping |
| `GET` | `/api/cloudflare/status` | — | Connection status |
| `GET` | `/api/cloudflare/zones` | — | Zones in the connected account |
| `POST` | `/api/cloudflare/token` | `{ token }` | Set the (encrypted) API token |
| `DELETE` | `/api/cloudflare/token` | — | Forget the token |
| `POST` | `/api/cloudflare/account` | `{ accountId }` | Select the account |
| `GET` | `/api/cloudflare/plan` | — | Live deploy plan + destination statuses |
| `GET` | `/api/cloudflare/destinations` | — | List destination addresses |
| `POST` | `/api/cloudflare/destinations` | `{ email }` | Add one address (sends verification) |
| `POST` | `/api/cloudflare/destinations/import` | `{ csv }` or `{ emails }` | Bulk verify-only; does **not** change mappings |
| `DELETE` | `/api/cloudflare/destinations/{email}` | — | Remove a destination |
| `POST` | `/api/cloudflare/enable-routing` | `{ zoneId }` | Enable Email Routing on a zone |
| `POST` | `/api/cloudflare/deploy` | — | Push staged mappings to Cloudflare |

Example — bulk-import mappings, then deploy, against the local server:

```powershell
$csv = Get-Content -Raw mappings.csv
Invoke-RestMethod -Method Post -Uri http://localhost:4748/api/import `
  -ContentType application/json -Body (@{ csv = $csv } | ConvertTo-Json)
Invoke-RestMethod -Method Post -Uri http://localhost:4748/api/cloudflare/deploy
```

### Calling the hosted Worker programmatically

The local server (`http://localhost:4748`) has **no authentication** — it is
meant to bind to localhost only, so any local script or agent can call it
directly. The hosted Worker sits behind **Cloudflare Access**, so a browser
login is normally required. For non-interactive access (scripts, cron, agents),
mint an Access **service token** instead of logging in:

1. Zero Trust dashboard → **Access → Service Auth → Service Tokens** →
   **Create Service Token**. Copy the Client ID and Client Secret.
2. On the Access application for `mail-admin.example.com`, add a policy with
   action **Service Auth** and an **Include → Service Token** rule selecting
   that token.
3. Send both headers on every request:

```powershell
$headers = @{
  "CF-Access-Client-Id"     = "<client-id>.access"
  "CF-Access-Client-Secret" = "<client-secret>"
}
Invoke-RestMethod -Headers $headers `
  -Uri https://mail-admin.example.com/api/state
```

Service tokens are independent of human logins and can be revoked at any time
from the same page.

---

## MCP server

Both backends can also be driven over the
**[Model Context Protocol](https://modelcontextprotocol.io/)**: the same
operations (list zones, stage mappings, import CSVs, manage destinations,
deploy) are exposed as MCP tools, so an AI agent or MCP client can operate the
tool directly. The MCP layer is a thin wrapper — all logic stays in the REST
API, so there is no duplicated behaviour.

**Tools:** `get_status`, `list_zones`, `list_mappings`, `get_plan`,
`create_mapping`, `update_mapping`, `delete_mapping`, `import_mappings_csv`,
`list_destinations`, `add_destination`, `import_destinations_csv`, `deploy`.

### Local stdio server (`mcp/`)

A stdio proxy over the REST API, for desktop MCP clients (Claude Desktop, VS
Code, …). It has two small dependencies:

```powershell
cd mcp
npm install
```

Register it with your client, pointing `MCP_BASE_URL` at a running backend:

```json
{
  "mcpServers": {
    "email-forwarding-manager": {
      "command": "node",
      "args": ["<path>/mcp/server.mjs"],
      "env": { "MCP_BASE_URL": "http://localhost:4748" }
    }
  }
}
```

- `MCP_BASE_URL` — backend base URL (default `http://localhost:4748`, the local
  server). For the hosted Worker use `https://mail-admin.example.com`.
- `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` — Access service-token
  headers, needed only when targeting the hosted Worker.

### Hosted remote endpoint (`/mcp`)

The hosted Worker also serves a remote **Streamable HTTP** MCP endpoint at
`/mcp`, behind the same Cloudflare Access. Point a remote-capable MCP client at
`https://mail-admin.example.com/mcp` and send the same service-token headers.

---

## Documentation

- **Developers / architecture:** [`docs/DESIGN.md`](docs/DESIGN.md)
- **Contributing / AI-agent notes:** [`AGENTS.md`](AGENTS.md)

---

## License

[MIT](LICENSE) © Ofer Shezaf
