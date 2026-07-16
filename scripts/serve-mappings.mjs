// Local mappings manager: a zero-dependency Node server that serves the static
// UI from mappings/ and edits Cloudflare Email Routing. Mappings are NOT stored
// locally — Cloudflare is the source of truth. They are held in memory for the
// session (seeded from Cloudflare) and staged there until the user runs Deploy.
// Only the encrypted token + selected account persist, in data/settings.json.
//
// REST API (all JSON):
//   GET    /api/state           -> { mappings }
//   POST   /api/mappings        { localPart, domain, destinations[] } -> { id }
//   PUT    /api/mappings/:id     { localPart, domain, destinations[] } -> { id }
//   DELETE /api/mappings/:id
//   POST   /api/import          { csv }
//   /api/cloudflare/*           connection, zones, destinations, plan, deploy
//
// Everything else is served as a static file from mappings/.

import { createServer } from "node:http";
import { readFile, stat, mkdir } from "node:fs/promises";
import { extname, join, normalize, resolve, sep, dirname } from "node:path";
import { exec } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createCloudflare } from "./cloudflare.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../mappings/");
const DATA_DIR = resolve(__dirname, "../data/");
const PORT = Number(process.env.PORT) || 4748;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LOCAL_RE = /^[^\s@]+$/;
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

await mkdir(DATA_DIR, { recursive: true });

// ---------- In-memory mapping store ----------
// Mappings are not persisted locally. They live only for the lifetime of the
// server process and are seeded from Cloudflare (the source of truth) on first
// access. Edits stage here until the user runs Deploy, which pushes them to
// Cloudflare. On restart the store is empty and re-seeded from Cloudflare.

const store = { seeded: false, mappings: [], nextId: 1 };

function publicMapping(m) {
  return {
    id: m.id,
    localPart: m.localPart,
    domain: m.domain,
    source: `${m.localPart}@${m.domain}`,
    destinations: [...m.destinations],
  };
}

// Mappings in the normalized shape cloudflare.mjs expects.
function loadMappings() {
  return store.mappings.map((m) => ({
    id: m.id,
    domain: m.domain.toLowerCase(),
    source: `${m.localPart}@${m.domain}`.toLowerCase(),
    destinations: m.destinations.map((e) => e.toLowerCase()),
  }));
}

// Insert or replace a mapping by (localPart, domain). Returns { mapping, created }.
function upsertMapping(localPart, domain, destinations) {
  localPart = String(localPart).trim().toLowerCase();
  domain = String(domain).trim().toLowerCase();
  const existing = store.mappings.find(
    (m) => m.localPart === localPart && m.domain === domain);
  if (existing) {
    existing.destinations = destinations;
    return { mapping: existing, created: false };
  }
  const mapping = { id: store.nextId++, localPart, domain, destinations };
  store.mappings.push(mapping);
  return { mapping, created: true };
}

// Upsert by full source address (localPart@domain); used by importOrphans.
function upsertBySource(source, destinations) {
  const at = String(source).lastIndexOf("@");
  upsertMapping(source.slice(0, at), source.slice(at + 1), destinations);
}

// Remove an email from every staged mapping's destinations. Mappings left with
// no destinations are dropped from the session. Returns { updated, removed }
// source-address lists so the caller can report what changed.
function stripDestinationFromMappings(email) {
  email = String(email || "").trim().toLowerCase();
  const updated = [];
  const removed = [];
  for (let i = store.mappings.length - 1; i >= 0; i--) {
    const m = store.mappings[i];
    const kept = m.destinations.filter((e) => e.toLowerCase() !== email);
    if (kept.length === m.destinations.length) continue;
    if (kept.length === 0) {
      removed.push(`${m.localPart}@${m.domain}`);
      store.mappings.splice(i, 1);
    } else {
      m.destinations = kept;
      updated.push(`${m.localPart}@${m.domain}`);
    }
  }
  return { updated, removed };
}

function resetStore() {
  store.seeded = false;
  store.mappings = [];
  store.nextId = 1;
}

const cloudflare = createCloudflare({
  dataDir: DATA_DIR,
  loadMappings,
  upsertMapping: upsertBySource,
  EMAIL_RE,
  DOMAIN_RE,
});

// Seed the store from Cloudflare the first time it's needed (once per session,
// when credentials are present). Errors leave it unseeded so it retries later.
async function maybeSeed() {
  if (store.seeded || !cloudflare.hasCredentials()) return;
  try {
    const live = await cloudflare.reconstructMappings();
    store.mappings = [];
    store.nextId = 1;
    for (const m of live) upsertMapping(m.localPart, m.domain, m.destinations);
    store.seeded = true;
  } catch { /* not connected / transient — retry on next access */ }
}

async function getState() {
  await maybeSeed();
  return { mappings: store.mappings.map(publicMapping) };
}

// ---------- API handlers ----------

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
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
  let started = false; // any char seen on the current logical row
  const s = String(text).replace(/^\uFEFF/, ""); // strip BOM
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

// Process parsed CSV rows: infer domains from source addresses and upsert
// mappings into the in-memory store. Any row error aborts the whole import
// (validation happens before any mutation), so the store is never half-updated.
function importCsv(csvText) {
  const rows = parseCsv(csvText);
  if (rows.length === 0) throw new ApiError(400, "CSV is empty");

  // Skip a header row if the first cell looks like a header.
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
    if (!source && destCell.trim() === "") continue; // blank line
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
    const { created } = upsertMapping(p.localPart, p.domain, p.destinations);
    if (created) summary.created++; else summary.updated++;
  }
  return summary;
}

const routes = [
  {
    method: "GET",
    re: /^\/api\/state$/,
    handler: () => getState(),
  },
  {
    method: "POST",
    re: /^\/api\/import$/,
    handler: (m, body) => {
      const csv = typeof body?.csv === "string" ? body.csv : null;
      if (csv == null) throw new ApiError(400, "Expected JSON body with a 'csv' string");
      return importCsv(csv);
    },
  },
  {
    method: "POST",
    re: /^\/api\/mappings$/,
    handler: async (m, body) => {
      await maybeSeed();
      const localPart = String(body?.localPart || "").trim().toLowerCase();
      const domain = String(body?.domain || "").trim().toLowerCase();
      if (!LOCAL_RE.test(localPart)) throw new ApiError(400, "Invalid local part");
      if (!DOMAIN_RE.test(domain)) throw new ApiError(400, "Invalid domain");
      const destinations = cleanDestinations(body?.destinations);
      const dup = store.mappings.find((x) => x.localPart === localPart && x.domain === domain);
      if (dup) throw new ApiError(409, "A mapping for this address already exists");
      const { mapping } = upsertMapping(localPart, domain, destinations);
      return { id: mapping.id };
    },
  },
  {
    method: "PUT",
    re: /^\/api\/mappings\/(\d+)$/,
    handler: async (m, body) => {
      await maybeSeed();
      const id = Number(m[1]);
      const target = store.mappings.find((x) => x.id === id);
      if (!target) throw new ApiError(404, "Mapping not found");
      const localPart = String(body?.localPart || "").trim().toLowerCase();
      const domain = String(body?.domain || "").trim().toLowerCase();
      if (!LOCAL_RE.test(localPart)) throw new ApiError(400, "Invalid local part");
      if (!DOMAIN_RE.test(domain)) throw new ApiError(400, "Invalid domain");
      const destinations = cleanDestinations(body?.destinations);
      const dup = store.mappings.find(
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
      const i = store.mappings.findIndex((x) => x.id === id);
      if (i < 0) throw new ApiError(404, "Mapping not found");
      store.mappings.splice(i, 1);
      return { ok: true };
    },
  },

  // ----- Cloudflare integration -----
  { method: "GET",    re: /^\/api\/cloudflare\/status$/,                 handler: () => cloudflare.status() },
  { method: "GET",    re: /^\/api\/cloudflare\/zones$/,                  handler: () => cloudflare.listZones() },
  { method: "POST",   re: /^\/api\/cloudflare\/token$/,                  handler: async (m, b) => { const r = await cloudflare.setToken(b?.token); resetStore(); return r; } },
  { method: "DELETE", re: /^\/api\/cloudflare\/token$/,                  handler: () => { const r = cloudflare.clearToken(); resetStore(); return r; } },
  { method: "POST",   re: /^\/api\/cloudflare\/account$/,                handler: async (m, b) => { const r = await cloudflare.setAccount(b?.accountId); resetStore(); return r; } },
  { method: "GET",    re: /^\/api\/cloudflare\/plan$/,                   handler: () => cloudflare.plan() },
  { method: "POST",   re: /^\/api\/cloudflare\/import-orphans$/,         handler: (m, b) => cloudflare.importOrphans(b?.sources) },
  { method: "POST",   re: /^\/api\/cloudflare\/destinations\/add-missing$/, handler: () => cloudflare.addMissingDestinations() },
  { method: "POST",   re: /^\/api\/cloudflare\/destinations\/import$/,      handler: (m, b) => cloudflare.addDestinations(b?.csv ?? b?.emails) },
  { method: "GET",    re: /^\/api\/cloudflare\/destinations$/,           handler: () => cloudflare.listDestinations() },
  { method: "POST",   re: /^\/api\/cloudflare\/destinations$/,           handler: (m, b) => cloudflare.addDestination(b?.email) },
  { method: "DELETE", re: /^\/api\/cloudflare\/destinations\/(.+)$/,      handler: async (m) => {
      await maybeSeed();
      const email = m[1];
      const r = await cloudflare.removeDestination(email);
      const s = stripDestinationFromMappings(email);
      const extra = [];
      if (s.updated.length) extra.push(`removed from ${s.updated.length} mapping(s)`);
      if (s.removed.length) extra.push(`deleted ${s.removed.length} now-empty mapping(s)`);
      const note = extra.length ? `${r.note} Also ${extra.join(" and ")}.` : r.note;
      return { ...r, mappingsUpdated: s.updated, mappingsRemoved: s.removed, note };
    } },
  { method: "POST",   re: /^\/api\/cloudflare\/enable-routing$/,         handler: (m, b) => cloudflare.enableRouting(b?.zoneId) },
  { method: "POST",   re: /^\/api\/cloudflare\/deploy$/,                 handler: () => cloudflare.deploy() },
];

async function readJsonBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError(400, "Invalid JSON body");
  }
}

async function handleApi(req, res, urlPath) {
  for (const route of routes) {
    if (req.method !== route.method) continue;
    const m = route.re.exec(urlPath);
    if (!m) continue;
    try {
      const body =
        req.method === "POST" || req.method === "PUT" ? await readJsonBody(req) : null;
      const result = await route.handler(m, body);
      sendJson(res, 200, result);
    } catch (e) {
      const status = Number.isInteger(e?.status) ? e.status : 500;
      sendJson(res, status, { error: e.message });
    }
    return true;
  }
  sendJson(res, 404, { error: "No such API endpoint" });
  return true;
}

function sendJson(res, status, obj) {
  const data = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(data);
}

// ---------- Static serving ----------

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

async function handleStatic(req, res, urlPath) {
  let rel = normalize(urlPath).replace(/^[\\/]+/, "");
  if (rel === "" || rel.endsWith(sep) || rel === ".") rel = "index.html";
  const filePath = join(ROOT, rel);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  try {
    const s = await stat(filePath);
    const finalPath = s.isDirectory() ? join(filePath, "index.html") : filePath;
    const data = await readFile(finalPath);
    const ct = MIME[extname(finalPath).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": ct, "Cache-Control": "no-store" });
    res.end(data);
  } catch (err) {
    if (err.code === "ENOENT") {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found: " + req.url);
    } else {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("error: " + err.message);
    }
  }
}

// ---------- Server ----------

const server = createServer(async (req, res) => {
  const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  if (urlPath.startsWith("/api/")) {
    await handleApi(req, res, urlPath);
  } else {
    await handleStatic(req, res, urlPath);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  const url = `http://localhost:${PORT}/`;
  console.log(`mappings UI:  ${url}`);
  console.log("(mappings live on Cloudflare; only the token persists in data/settings.json)");
  console.log("Ctrl+C to stop.");
  if (!process.env.NO_OPEN) {
    const cmd =
      process.platform === "win32" ? `start "" "${url}"` :
      process.platform === "darwin" ? `open "${url}"` :
      `xdg-open "${url}"`;
    exec(cmd, () => {});
  }
});
