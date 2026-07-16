// Durable Object session store for the Cloudflare-hosted Email Forwarding
// Manager. This is the Worker equivalent of the local server's long-lived
// process + in-memory store: a single addressable instance whose memory
// survives across requests, is seeded from Cloudflare on first access, and is
// re-seeded when the instance is evicted. Mappings are NOT persisted here —
// Cloudflare is the source of truth. Only the encrypted token persists, in D1.
//
// The Worker (src/index.js) forwards every /api/* request to one singleton
// instance of this class, which owns the routing, the store, and the Cloudflare
// client — exactly mirroring scripts/serve-mappings.mjs in the local app.

import { createCloudflare } from "./cloudflare.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LOCAL_RE = /^[^\s@]+$/;
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

async function readJson(request) {
  if (request.method !== "POST" && request.method !== "PUT") return null;
  const text = await request.text();
  if (!text) return {};
  try { return JSON.parse(text); }
  catch { throw new ApiError(400, "Invalid JSON body"); }
}

function cleanDestinations(input) {
  if (!Array.isArray(input)) throw new ApiError(400, "destinations must be an array");
  const seen = new Set();
  const out = [];
  for (const raw of input) {
    const e = String(raw || "").trim().toLowerCase();
    if (!e) continue;
    if (!EMAIL_RE.test(e)) throw new ApiError(400, `Invalid destination email: ${raw}`);
    if (seen.has(e)) continue;
    seen.add(e);
    out.push(e);
  }
  if (out.length === 0) throw new ApiError(400, "At least one destination is required");
  return out;
}

// Parse CSV text into rows of string cells. Handles quoted fields,
// embedded commas/newlines, and "" escaping. Tolerates \r\n and \n.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let started = false;
  const s = String(text).replace(/^\uFEFF/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') { inQuotes = true; started = true; continue; }
    if (c === ",") { row.push(field); field = ""; started = true; continue; }
    if (c === "\r") continue;
    if (c === "\n") {
      row.push(field);
      if (started || row.length > 1 || row[0] !== "") rows.push(row);
      row = []; field = ""; started = false;
      continue;
    }
    field += c; started = true;
  }
  if (started || field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export class SessionStore {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    // Ephemeral staged mappings for the session, seeded from Cloudflare.
    this.store = { seeded: false, mappings: [], nextId: 1 };
    this.cloudflare = createCloudflare({
      env,
      loadMappings: () => this.loadMappings(),
      upsertMapping: (source, dests) => this.upsertBySource(source, dests),
      EMAIL_RE,
      DOMAIN_RE,
    });
  }

  // ---------- store helpers ----------

  publicMapping(m) {
    return {
      id: m.id,
      localPart: m.localPart,
      domain: m.domain,
      source: `${m.localPart}@${m.domain}`,
      destinations: [...m.destinations],
    };
  }

  // Mappings in the normalized shape cloudflare.js expects.
  loadMappings() {
    return this.store.mappings.map((m) => ({
      id: m.id,
      domain: m.domain.toLowerCase(),
      source: `${m.localPart}@${m.domain}`.toLowerCase(),
      destinations: m.destinations.map((e) => e.toLowerCase()),
    }));
  }

  // Insert or replace a mapping by (localPart, domain). Returns { mapping, created }.
  upsertMapping(localPart, domain, destinations) {
    localPart = String(localPart).trim().toLowerCase();
    domain = String(domain).trim().toLowerCase();
    const existing = this.store.mappings.find(
      (m) => m.localPart === localPart && m.domain === domain);
    if (existing) {
      existing.destinations = destinations;
      return { mapping: existing, created: false };
    }
    const mapping = { id: this.store.nextId++, localPart, domain, destinations };
    this.store.mappings.push(mapping);
    return { mapping, created: true };
  }

  // Upsert by full source address (localPart@domain); used by importOrphans.
  upsertBySource(source, destinations) {
    const at = String(source).lastIndexOf("@");
    this.upsertMapping(source.slice(0, at), source.slice(at + 1), destinations);
  }

  // Remove an email from every staged mapping's destinations. Mappings left
  // with no destinations are dropped from the session. Returns { updated,
  // removed } source-address lists so the caller can report what changed.
  stripDestinationFromMappings(email) {
    email = String(email || "").trim().toLowerCase();
    const updated = [];
    const removed = [];
    for (let i = this.store.mappings.length - 1; i >= 0; i--) {
      const m = this.store.mappings[i];
      const kept = m.destinations.filter((e) => e.toLowerCase() !== email);
      if (kept.length === m.destinations.length) continue;
      if (kept.length === 0) {
        removed.push(`${m.localPart}@${m.domain}`);
        this.store.mappings.splice(i, 1);
      } else {
        m.destinations = kept;
        updated.push(`${m.localPart}@${m.domain}`);
      }
    }
    return { updated, removed };
  }

  resetStore() {
    this.store.seeded = false;
    this.store.mappings = [];
    this.store.nextId = 1;
  }

  // Seed the store from Cloudflare the first time it's needed (once per DO
  // lifetime, when credentials are present). Errors leave it unseeded so it
  // retries on the next access.
  async maybeSeed() {
    if (this.store.seeded || !(await this.cloudflare.hasCredentials())) return;
    try {
      const live = await this.cloudflare.reconstructMappings();
      this.store.mappings = [];
      this.store.nextId = 1;
      for (const m of live) this.upsertMapping(m.localPart, m.domain, m.destinations);
      this.store.seeded = true;
    } catch { /* not connected / transient — retry on next access */ }
  }

  async getState() {
    await this.maybeSeed();
    return { mappings: this.store.mappings.map((m) => this.publicMapping(m)) };
  }

  // Bulk upsert mappings from CSV into the store. Validation runs fully before
  // any mutation, so the store is never left half-updated.
  importCsv(csvText) {
    const rows = parseCsv(csvText);
    if (rows.length === 0) throw new ApiError(400, "CSV is empty");

    let start = 0;
    const h0 = (rows[0][0] || "").trim().toLowerCase();
    const h1 = (rows[0][1] || "").trim().toLowerCase();
    if (/^(source|from|address|email)/.test(h0) || /^(destination|dest|to|forward)/.test(h1)) {
      start = 1;
    }

    const parsed = [];
    const errors = [];
    for (let i = start; i < rows.length; i++) {
      const r = rows[i];
      const lineNo = i + 1;
      const source = (r[0] || "").trim().toLowerCase();
      const destCell = r[1] || "";
      if (!source && destCell.trim() === "") continue;
      if (!EMAIL_RE.test(source)) {
        errors.push(`Line ${lineNo}: invalid source address "${r[0] ?? ""}"`);
        continue;
      }
      const at = source.lastIndexOf("@");
      const localPart = source.slice(0, at);
      const domain = source.slice(at + 1);

      const seen = new Set();
      const destinations = [];
      let bad = null;
      for (const raw of destCell.split(",")) {
        const e = raw.trim().toLowerCase();
        if (!e) continue;
        if (!EMAIL_RE.test(e)) { bad = raw.trim(); break; }
        if (seen.has(e)) continue;
        seen.add(e);
        destinations.push(e);
      }
      if (bad) { errors.push(`Line ${lineNo}: invalid destination "${bad}"`); continue; }
      if (destinations.length === 0) {
        errors.push(`Line ${lineNo}: no destinations for "${source}"`);
        continue;
      }
      parsed.push({ lineNo, localPart, domain, destinations });
    }

    if (errors.length > 0) {
      throw new ApiError(400, `Import aborted — ${errors.length} problem(s):\n` + errors.join("\n"));
    }
    if (parsed.length === 0) throw new ApiError(400, "No valid rows found in CSV");

    const summary = { domainsAdded: 0, created: 0, updated: 0, rows: parsed.length };
    for (const p of parsed) {
      const { created } = this.upsertMapping(p.localPart, p.domain, p.destinations);
      if (created) summary.created++; else summary.updated++;
    }
    return summary;
  }

  // ---------- routing ----------

  async fetch(request) {
    const path = new URL(request.url).pathname;
    const method = request.method;
    const cf = this.cloudflare;

    const routes = [
      { method: "GET",    re: /^\/api\/state$/,           handler: () => this.getState() },
      {
        method: "POST",
        re: /^\/api\/import$/,
        handler: (m, body) => {
          const csv = typeof body?.csv === "string" ? body.csv : null;
          if (csv == null) throw new ApiError(400, "Expected JSON body with a 'csv' string");
          return this.importCsv(csv);
        },
      },
      {
        method: "POST",
        re: /^\/api\/mappings$/,
        handler: async (m, body) => {
          await this.maybeSeed();
          const localPart = String(body?.localPart || "").trim().toLowerCase();
          const domain = String(body?.domain || "").trim().toLowerCase();
          if (!LOCAL_RE.test(localPart)) throw new ApiError(400, "Invalid local part");
          if (!DOMAIN_RE.test(domain)) throw new ApiError(400, "Invalid domain");
          const destinations = cleanDestinations(body?.destinations);
          const dup = this.store.mappings.find((x) => x.localPart === localPart && x.domain === domain);
          if (dup) throw new ApiError(409, "A mapping for this address already exists");
          const { mapping } = this.upsertMapping(localPart, domain, destinations);
          return { id: mapping.id };
        },
      },
      {
        method: "PUT",
        re: /^\/api\/mappings\/(\d+)$/,
        handler: async (m, body) => {
          await this.maybeSeed();
          const id = Number(m[1]);
          const target = this.store.mappings.find((x) => x.id === id);
          if (!target) throw new ApiError(404, "Mapping not found");
          const localPart = String(body?.localPart || "").trim().toLowerCase();
          const domain = String(body?.domain || "").trim().toLowerCase();
          if (!LOCAL_RE.test(localPart)) throw new ApiError(400, "Invalid local part");
          if (!DOMAIN_RE.test(domain)) throw new ApiError(400, "Invalid domain");
          const destinations = cleanDestinations(body?.destinations);
          const dup = this.store.mappings.find(
            (x) => x.id !== id && x.localPart === localPart && x.domain === domain);
          if (dup) throw new ApiError(409, "A mapping for this address already exists");
          target.localPart = localPart;
          target.domain = domain;
          target.destinations = destinations;
          return { id };
        },
      },
      {
        method: "DELETE",
        re: /^\/api\/mappings\/(\d+)$/,
        handler: (m) => {
          const id = Number(m[1]);
          const i = this.store.mappings.findIndex((x) => x.id === id);
          if (i < 0) throw new ApiError(404, "Mapping not found");
          this.store.mappings.splice(i, 1);
          return { ok: true };
        },
      },

      // ----- Cloudflare integration -----
      { method: "GET",    re: /^\/api\/cloudflare\/status$/,                    handler: () => cf.status() },
      { method: "GET",    re: /^\/api\/cloudflare\/zones$/,                     handler: () => cf.listZones() },
      { method: "POST",   re: /^\/api\/cloudflare\/token$/,                     handler: async (m, b) => { const r = await cf.setToken(b?.token); this.resetStore(); return r; } },
      { method: "DELETE", re: /^\/api\/cloudflare\/token$/,                     handler: async () => { const r = await cf.clearToken(); this.resetStore(); return r; } },
      { method: "POST",   re: /^\/api\/cloudflare\/account$/,                   handler: async (m, b) => { const r = await cf.setAccount(b?.accountId); this.resetStore(); return r; } },
      { method: "GET",    re: /^\/api\/cloudflare\/plan$/,                      handler: () => cf.plan() },
      { method: "POST",   re: /^\/api\/cloudflare\/import-orphans$/,            handler: (m, b) => cf.importOrphans(b?.sources) },
      { method: "POST",   re: /^\/api\/cloudflare\/destinations\/add-missing$/, handler: () => cf.addMissingDestinations() },
      { method: "POST",   re: /^\/api\/cloudflare\/destinations\/import$/,      handler: (m, b) => cf.addDestinations(b?.csv ?? b?.emails) },
      { method: "GET",    re: /^\/api\/cloudflare\/destinations$/,              handler: () => cf.listDestinations() },
      { method: "POST",   re: /^\/api\/cloudflare\/destinations$/,              handler: (m, b) => cf.addDestination(b?.email) },
      { method: "DELETE", re: /^\/api\/cloudflare\/destinations\/(.+)$/,        handler: async (m) => {
          await this.maybeSeed();
          const email = decodeURIComponent(m[1]);
          const r = await cf.removeDestination(email);
          const s = this.stripDestinationFromMappings(email);
          const extra = [];
          if (s.updated.length) extra.push(`removed from ${s.updated.length} mapping(s)`);
          if (s.removed.length) extra.push(`deleted ${s.removed.length} now-empty mapping(s)`);
          const note = extra.length ? `${r.note} Also ${extra.join(" and ")}.` : r.note;
          return { ...r, mappingsUpdated: s.updated, mappingsRemoved: s.removed, note };
        } },
      { method: "POST",   re: /^\/api\/cloudflare\/enable-routing$/,            handler: (m, b) => cf.enableRouting(b?.zoneId) },
      { method: "POST",   re: /^\/api\/cloudflare\/deploy$/,                    handler: () => cf.deploy() },
    ];

    for (const route of routes) {
      if (method !== route.method) continue;
      const m = route.re.exec(path);
      if (!m) continue;
      try {
        const body = await readJson(request);
        const result = await route.handler(m, body);
        return json(200, result);
      } catch (e) {
        const status = Number.isInteger(e?.status) ? e.status : 500;
        return json(status, { error: e.message });
      }
    }

    return json(404, { error: "No such API endpoint" });
  }
}
