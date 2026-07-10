# Cloudflare e-mail forwarding manager

A small, self-hosted web app for managing **Cloudflare Email Routing**
forwarding rules. Map a source address (`local-part@your-domain`) to **one or
more** verified destination mailboxes, keep everything in a local SQLite
database, and deploy it to Cloudflare — including true multi-destination
**fan-out** — straight from the UI.

Cloudflare Email Routing on its own only forwards an address to a *single*
verified destination. This app removes that limit: when a mapping has several
destinations it generates and deploys a tiny **fan-out Worker** that forwards a
copy to each one, and wires the routing rule to it for you.

> Two ways to run it: this **locally deployable** Node app (below), or the
> **Cloudflare-hosted Worker** version in [`worker/`](worker/) (Workers + D1
> behind Cloudflare Access). See [Hosting it online](#hosting-it-online).

---

## Features

- **Closed, editable domain list.** Source addresses can only use domains you
  explicitly add, so you can't typo a forwarding rule onto the wrong domain.
- **One source → many destinations.** Simple aliases become Email Routing
  rules; multi-destination mappings become a generated fan-out Worker.
- **Catch-all support.** Use a `*` local part to forward every address on a
  domain.
- **Local database.** Domains, mappings and destinations persist in
  `data/mappings.db` across sessions. No cloud account is needed to *design*
  rules — only to deploy them.
- **Live Cloudflare status.** Once connected, every mapping shows whether it is
  deployed, needs an update, or is blocked (e.g. a destination still needs
  verification). Nothing is hard-coded; status is read live from Cloudflare.
- **Guided deploy & import wizards.** Step-by-step deploy (check → validate
  addresses → deploy → done) and CSV import.
- **Encrypted token storage.** Your Cloudflare API token is stored encrypted
  (AES-256-GCM) on the server, never in the browser.

---

## Requirements

- **Node.js 22 or newer.** The server uses Node's built-in `node:sqlite` and
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
to. The token is verified and stored **encrypted** in `data/mappings.db`; the
32-byte key lives in `data/.cf-keyfile` (gitignored). Copying the database
without the keyfile does not reveal the token. Use **Forget token** to remove
it.

---

## Day-to-day workflow

1. **Domains** — add the domain(s) you forward mail for (e.g. `example.org`).
2. **Mappings** — create a mapping: a source local-part + domain → one or more
   destination emails. Use `*` as the local part for a catch-all.
3. **Destinations** — Cloudflare requires every forwarding target to be a
   **verified** Destination Address. New destinations appear here; click
   **Send verification**, then click the link Cloudflare emails to that
   mailbox.
4. **Deploy** — open the deploy wizard (from Overview or Mappings). It checks
   readiness, confirms all destinations are verified, then applies the rules
   and the fan-out Worker. Deploy is **idempotent** — existing rules are
   updated in place, never duplicated, and only *ready* mappings are applied.

A mapping shows **Need verification** until all of its destinations are
verified; the deploy wizard will skip it (with the reason) until then.

### CSV import

The **Import** wizard accepts a two-column CSV (upload or paste):

| Column | Contents |
|---|---|
| `source` | A full source address, e.g. `info@example.org` |
| `destinations` | One or more destination emails, comma-separated (quote the cell if it contains commas) |

A header row is optional (auto-detected). The domain is inferred from each
source address and created if new. Existing source addresses are overwritten
with the imported destinations. The whole import runs in one transaction — if
any row is invalid, nothing is changed and errors are reported with line
numbers.

```csv
source,destinations
info@example.org,"alice@gmail.com, bob@outlook.com"
sales@example.org,team@gmail.com
```

---

## What runs where

The app holds **no hard-coded forwarding state**: the local database is your
design source of truth, and the live deployment status is always read back from
Cloudflare.

| Data | Stored in |
|---|---|
| Domains, mappings, destinations | local SQLite (`data/mappings.db`) |
| Cloudflare API token | encrypted in `data/mappings.db` (key in `data/.cf-keyfile`) |
| Deployment / verification status | read live from the Cloudflare API on demand |

The `data/` directory is gitignored — your database and key never leave your
machine.

---

## Hosting it online

The Node app above is meant to run on your own machine. Because it controls
email forwarding **and** holds a Cloudflare API token, any networked deployment
must sit behind authentication.

For an always-on, no-machine-required option, use the **Cloudflare-hosted
Worker** version in [`worker/`](worker/). It runs the same UI and API as a
Cloudflare Worker backed by **D1** (instead of on-disk SQLite), behind
**[Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/)**
for Google/identity federation — so authentication is enforced at the edge with
no auth code in the app. Full setup is in [`worker/README.md`](worker/README.md).
See [`docs/DESIGN.md`](docs/DESIGN.md) for the architecture.

---

## Documentation

- **Developers / architecture:** [`docs/DESIGN.md`](docs/DESIGN.md)
- **Contributing / AI-agent notes:** [`AGENTS.md`](AGENTS.md)

---

## License

[MIT](LICENSE) © Ofer Shezaf
