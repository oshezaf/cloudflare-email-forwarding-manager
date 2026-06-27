// Local mappings manager: a zero-dependency Node server that persists email
// forwarding mappings in a SQLite database and serves the static UI from
// mappings/. Source addresses are constrained to a closed list of domains.
//
// REST API (all JSON):
//   GET    /api/state           -> { domains, mappings }
//   POST   /api/domains         { name }            -> domain
//   DELETE /api/domains/:id
//   POST   /api/mappings        { localPart, domainId, destinations[] } -> mapping
//   PUT    /api/mappings/:id    { localPart, domainId, destinations[] } -> mapping
//   DELETE /api/mappings/:id
//
// Everything else is served as a static file from mappings/.

import { createServer } from "node:http";
import { readFile, stat, mkdir } from "node:fs/promises";
import { extname, join, normalize, resolve, sep, dirname } from "node:path";
import { exec } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createCloudflare } from "./cloudflare.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../mappings/");
const DATA_DIR = resolve(__dirname, "../data/");
const DB_PATH = join(DATA_DIR, "mappings.db");
const PORT = Number(process.env.PORT) || 4748;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LOCAL_RE = /^[^\s@]+$/;
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

// ---------- Database ----------

await mkdir(DATA_DIR, { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS domains (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE
  );
  CREATE TABLE IF NOT EXISTS mappings (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    local_part TEXT NOT NULL,
    domain_id  INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (local_part, domain_id)
  );
  CREATE TABLE IF NOT EXISTS destinations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    mapping_id INTEGER NOT NULL REFERENCES mappings(id) ON DELETE CASCADE,
    email      TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`);

const cloudflare = createCloudflare({ db, dataDir: DATA_DIR, EMAIL_RE, DOMAIN_RE });

function getState() {
  const domains = db
    .prepare("SELECT id, name FROM domains ORDER BY name COLLATE NOCASE")
    .all();
  const mappings = db
    .prepare(
      `SELECT m.id, m.local_part AS localPart, m.domain_id AS domainId,
              d.name AS domain, m.created_at AS createdAt
         FROM mappings m JOIN domains d ON d.id = m.domain_id
         ORDER BY d.name COLLATE NOCASE, m.local_part COLLATE NOCASE`
    )
    .all();
  const destStmt = db.prepare(
    "SELECT email FROM destinations WHERE mapping_id = ? ORDER BY email COLLATE NOCASE"
  );
  for (const m of mappings) {
    m.destinations = destStmt.all(m.id).map((r) => r.email);
    m.source = `${m.localPart}@${m.domain}`;
  }
  return { domains, mappings };
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

function requireDomain(domainId) {
  const row = db.prepare("SELECT id FROM domains WHERE id = ?").get(domainId);
  if (!row) throw new ApiError(400, "Unknown domainId");
}

function setDestinations(mappingId, destinations) {
  db.prepare("DELETE FROM destinations WHERE mapping_id = ?").run(mappingId);
  const ins = db.prepare("INSERT INTO destinations (mapping_id, email) VALUES (?, ?)");
  for (const e of destinations) ins.run(mappingId, e);
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

// Get-or-create a domain by name, returning its id. Validates format.
function ensureDomain(name, addedSet) {
  const existing = db.prepare("SELECT id FROM domains WHERE name = ? COLLATE NOCASE").get(name);
  if (existing) return existing.id;
  if (!DOMAIN_RE.test(name)) throw new ApiError(400, `Invalid domain inferred from source: ${name}`);
  const info = db.prepare("INSERT INTO domains (name) VALUES (?)").run(name);
  if (addedSet) addedSet.add(name);
  return Number(info.lastInsertRowid);
}

// Insert or replace a mapping (by source address), setting its destinations.
function upsertMapping(localPart, domainId, destinations) {
  const existing = db
    .prepare("SELECT id FROM mappings WHERE local_part = ? AND domain_id = ?")
    .get(localPart, domainId);
  if (existing) {
    setDestinations(existing.id, destinations);
    return "updated";
  }
  const info = db
    .prepare("INSERT INTO mappings (local_part, domain_id) VALUES (?, ?)")
    .run(localPart, domainId);
  setDestinations(Number(info.lastInsertRowid), destinations);
  return "created";
}

// Process parsed CSV rows: infer domains from source addresses, auto-create
// them, and upsert mappings. Runs in a single transaction — any row error
// rolls the whole import back so the DB is never left half-updated.
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
  const addedDomains = new Set();
  const run = db.prepare("BEGIN");
  try {
    run.run();
    for (const p of parsed) {
      const domainId = ensureDomain(p.domain, addedDomains);
      const result = upsertMapping(p.localPart, domainId, p.destinations);
      summary[result]++;
    }
    db.prepare("COMMIT").run();
  } catch (e) {
    try { db.prepare("ROLLBACK").run(); } catch { /* ignore */ }
    throw e;
  }
  summary.domainsAdded = addedDomains.size;
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
    re: /^\/api\/domains$/,
    handler: (m, body) => {
      const name = String(body?.name || "").trim().toLowerCase();
      if (!DOMAIN_RE.test(name)) throw new ApiError(400, "Invalid domain name");
      try {
        const info = db.prepare("INSERT INTO domains (name) VALUES (?)").run(name);
        return { id: Number(info.lastInsertRowid), name };
      } catch (e) {
        if (String(e.message).includes("UNIQUE")) throw new ApiError(409, "Domain already exists");
        throw e;
      }
    },
  },
  {
    method: "DELETE",
    re: /^\/api\/domains\/(\d+)$/,
    handler: (m) => {
      const id = Number(m[1]);
      const info = db.prepare("DELETE FROM domains WHERE id = ?").run(id);
      if (info.changes === 0) throw new ApiError(404, "Domain not found");
      return { ok: true };
    },
  },
  {
    method: "POST",
    re: /^\/api\/mappings$/,
    handler: (m, body) => {
      const localPart = String(body?.localPart || "").trim().toLowerCase();
      const domainId = Number(body?.domainId);
      if (!LOCAL_RE.test(localPart)) throw new ApiError(400, "Invalid local part");
      if (!Number.isInteger(domainId)) throw new ApiError(400, "domainId required");
      requireDomain(domainId);
      const destinations = cleanDestinations(body?.destinations);
      let mappingId;
      try {
        const info = db
          .prepare("INSERT INTO mappings (local_part, domain_id) VALUES (?, ?)")
          .run(localPart, domainId);
        mappingId = Number(info.lastInsertRowid);
      } catch (e) {
        if (String(e.message).includes("UNIQUE"))
          throw new ApiError(409, "A mapping for this address already exists");
        throw e;
      }
      setDestinations(mappingId, destinations);
      return { id: mappingId };
    },
  },
  {
    method: "PUT",
    re: /^\/api\/mappings\/(\d+)$/,
    handler: (m, body) => {
      const id = Number(m[1]);
      const exists = db.prepare("SELECT id FROM mappings WHERE id = ?").get(id);
      if (!exists) throw new ApiError(404, "Mapping not found");
      const localPart = String(body?.localPart || "").trim().toLowerCase();
      const domainId = Number(body?.domainId);
      if (!LOCAL_RE.test(localPart)) throw new ApiError(400, "Invalid local part");
      if (!Number.isInteger(domainId)) throw new ApiError(400, "domainId required");
      requireDomain(domainId);
      const destinations = cleanDestinations(body?.destinations);
      try {
        db.prepare("UPDATE mappings SET local_part = ?, domain_id = ? WHERE id = ?").run(
          localPart,
          domainId,
          id
        );
      } catch (e) {
        if (String(e.message).includes("UNIQUE"))
          throw new ApiError(409, "A mapping for this address already exists");
        throw e;
      }
      setDestinations(id, destinations);
      return { id };
    },
  },
  {
    method: "DELETE",
    re: /^\/api\/mappings\/(\d+)$/,
    handler: (m) => {
      const id = Number(m[1]);
      const info = db.prepare("DELETE FROM mappings WHERE id = ?").run(id);
      if (info.changes === 0) throw new ApiError(404, "Mapping not found");
      return { ok: true };
    },
  },

  // ----- Cloudflare integration -----
  { method: "GET",    re: /^\/api\/cloudflare\/status$/,                 handler: () => cloudflare.status() },
  { method: "POST",   re: /^\/api\/cloudflare\/token$/,                  handler: (m, b) => cloudflare.setToken(b?.token) },
  { method: "DELETE", re: /^\/api\/cloudflare\/token$/,                  handler: () => cloudflare.clearToken() },
  { method: "POST",   re: /^\/api\/cloudflare\/account$/,                handler: (m, b) => cloudflare.setAccount(b?.accountId) },
  { method: "GET",    re: /^\/api\/cloudflare\/plan$/,                   handler: () => cloudflare.plan() },
  { method: "POST",   re: /^\/api\/cloudflare\/import-orphans$/,         handler: (m, b) => cloudflare.importOrphans(b?.sources) },
  { method: "POST",   re: /^\/api\/cloudflare\/destinations\/add-missing$/, handler: () => cloudflare.addMissingDestinations() },
  { method: "GET",    re: /^\/api\/cloudflare\/destinations$/,           handler: () => cloudflare.listDestinations() },
  { method: "POST",   re: /^\/api\/cloudflare\/destinations$/,           handler: (m, b) => cloudflare.addDestination(b?.email) },
  { method: "DELETE", re: /^\/api\/cloudflare\/destinations\/(.+)$/,      handler: (m) => cloudflare.removeDestination(m[1]) },
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
  console.log(`(database ${DB_PATH})`);
  console.log("Ctrl+C to stop.");
  if (!process.env.NO_OPEN) {
    const cmd =
      process.platform === "win32" ? `start "" "${url}"` :
      process.platform === "darwin" ? `open "${url}"` :
      `xdg-open "${url}"`;
    exec(cmd, () => {});
  }
});
