# Cloudflare-hosted Email Forwarding Manager

This directory deploys the Email Forwarding Manager **as a Cloudflare Worker**,
so you can run it without keeping a machine on. It is functionally identical to
the local Node app in the repo root — same UI, same API, same Cloudflare
Email Routing deploy logic — but:

| | Local app (repo root) | Hosted Worker (this dir) |
|---|---|---|
| Runtime | Node 22 (`node:sqlite`, `node:http`) | Cloudflare Workers |
| Storage | SQLite file in `data/` | Cloudflare D1 |
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
         ├─ static UI         ← Workers Static Assets (../mappings)
         ├─ /api/* JSON API   ← src/index.js
         ├─ D1 (binding DB)   ← domains / mappings / destinations / settings
         └─ Cloudflare API    ← deploys rules + the email-fanout worker
```

- `src/index.js` — fetch handler / router (the hosted equivalent of
  `scripts/serve-mappings.mjs`).
- `src/db.js` — async D1 data layer (domains, mappings, destinations, CSV import).
- `src/cloudflare.js` — async port of the Cloudflare client; encrypts the stored
  API token with WebCrypto AES-GCM using the `ENC_KEY` secret.
- `schema.sql` — D1 schema.
- `wrangler.toml` — Worker + assets + D1 config.

There is **no auth code** in the Worker on purpose. Access control is delegated
entirely to Cloudflare Access so that only people you authorise can reach the
app and the stored token.

---

## Prerequisites

- A Cloudflare account with Workers, D1 and (for auth) Access available.
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

Copy the `database_id` it prints into `wrangler.toml`, replacing
`REPLACE_WITH_DATABASE_ID`.

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
  SQLite app; mappings created in one are not visible in the other. The stored
  API token also can't be migrated between them (different encryption layout).
- **Token permissions** are identical to the local app — see the root README.
- **Custom domain vs. mail.** The app's custom domain is HTTPS-only and does
  not affect the parent zone's MX / Email Routing — see step 5.
- **Don't add `nodejs_compat`** — the Worker uses only WebCrypto, the Fetch API
  and D1; no Node built-ins.
- **Keep the root app zero-dependency.** All Wrangler tooling lives here in
  `worker/`; nothing in this directory should leak into the repo-root
  `package.json`.
