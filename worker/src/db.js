// D1 data layer for the Cloudflare-hosted Email Forwarding Manager.
//
// This is the async D1 port of the local app's node:sqlite logic. Every helper
// takes the D1 binding (`db`, i.e. env.DB) as its first argument. D1 has no
// interactive transactions (no BEGIN/COMMIT), so multi-statement atomic work
// uses db.batch([...]); validation always runs fully before any writes.

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const LOCAL_RE = /^[^\s@]+$/;
export const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------- shared helpers ----------

export function cleanDestinations(input) {
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

async function requireDomain(db, domainId) {
  const row = await db.prepare("SELECT id FROM domains WHERE id = ?").bind(domainId).first();
  if (!row) throw new ApiError(400, "Unknown domainId");
}

// Replace a mapping's destination list atomically.
async function setDestinations(db, mappingId, destinations) {
  const stmts = [db.prepare("DELETE FROM destinations WHERE mapping_id = ?").bind(mappingId)];
  const ins = db.prepare("INSERT INTO destinations (mapping_id, email) VALUES (?, ?)");
  for (const e of destinations) stmts.push(ins.bind(mappingId, e));
  await db.batch(stmts);
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

// ---------- state ----------

export async function getState(db) {
  const domains = (await db
    .prepare("SELECT id, name FROM domains ORDER BY name COLLATE NOCASE")
    .all()).results;
  const mappings = (await db
    .prepare(
      `SELECT m.id, m.local_part AS localPart, m.domain_id AS domainId,
              d.name AS domain, m.created_at AS createdAt
         FROM mappings m JOIN domains d ON d.id = m.domain_id
         ORDER BY d.name COLLATE NOCASE, m.local_part COLLATE NOCASE`
    )
    .all()).results;
  // Fetch all destinations in one query and group, to avoid per-row round-trips.
  const destRows = (await db
    .prepare("SELECT mapping_id AS mappingId, email FROM destinations ORDER BY email COLLATE NOCASE")
    .all()).results;
  const byMapping = new Map();
  for (const r of destRows) {
    if (!byMapping.has(r.mappingId)) byMapping.set(r.mappingId, []);
    byMapping.get(r.mappingId).push(r.email);
  }
  for (const m of mappings) {
    m.destinations = byMapping.get(m.id) || [];
    m.source = `${m.localPart}@${m.domain}`;
  }
  return { domains, mappings };
}

// ---------- domains ----------

export async function addDomain(db, rawName) {
  const name = String(rawName || "").trim().toLowerCase();
  if (!DOMAIN_RE.test(name)) throw new ApiError(400, "Invalid domain name");
  try {
    const info = await db.prepare("INSERT INTO domains (name) VALUES (?)").bind(name).run();
    return { id: Number(info.meta.last_row_id), name };
  } catch (e) {
    if (/UNIQUE/i.test(String(e.message))) throw new ApiError(409, "Domain already exists");
    throw e;
  }
}

export async function deleteDomain(db, id) {
  // Explicit cascade — D1 does not reliably honour ON DELETE CASCADE, so delete
  // children first, then the parent, atomically.
  const res = await db.batch([
    db.prepare(
      "DELETE FROM destinations WHERE mapping_id IN (SELECT id FROM mappings WHERE domain_id = ?)"
    ).bind(id),
    db.prepare("DELETE FROM mappings WHERE domain_id = ?").bind(id),
    db.prepare("DELETE FROM domains WHERE id = ?").bind(id),
  ]);
  if (res[res.length - 1].meta.changes === 0) throw new ApiError(404, "Domain not found");
  return { ok: true };
}

// ---------- mappings ----------

export async function addMapping(db, body) {
  const localPart = String(body?.localPart || "").trim().toLowerCase();
  const domainId = Number(body?.domainId);
  if (!LOCAL_RE.test(localPart)) throw new ApiError(400, "Invalid local part");
  if (!Number.isInteger(domainId)) throw new ApiError(400, "domainId required");
  await requireDomain(db, domainId);
  const destinations = cleanDestinations(body?.destinations);
  let mappingId;
  try {
    const info = await db
      .prepare("INSERT INTO mappings (local_part, domain_id) VALUES (?, ?)")
      .bind(localPart, domainId).run();
    mappingId = Number(info.meta.last_row_id);
  } catch (e) {
    if (/UNIQUE/i.test(String(e.message)))
      throw new ApiError(409, "A mapping for this address already exists");
    throw e;
  }
  await setDestinations(db, mappingId, destinations);
  return { id: mappingId };
}

export async function updateMapping(db, id, body) {
  const exists = await db.prepare("SELECT id FROM mappings WHERE id = ?").bind(id).first();
  if (!exists) throw new ApiError(404, "Mapping not found");
  const localPart = String(body?.localPart || "").trim().toLowerCase();
  const domainId = Number(body?.domainId);
  if (!LOCAL_RE.test(localPart)) throw new ApiError(400, "Invalid local part");
  if (!Number.isInteger(domainId)) throw new ApiError(400, "domainId required");
  await requireDomain(db, domainId);
  const destinations = cleanDestinations(body?.destinations);
  try {
    await db.prepare("UPDATE mappings SET local_part = ?, domain_id = ? WHERE id = ?")
      .bind(localPart, domainId, id).run();
  } catch (e) {
    if (/UNIQUE/i.test(String(e.message)))
      throw new ApiError(409, "A mapping for this address already exists");
    throw e;
  }
  await setDestinations(db, id, destinations);
  return { id };
}

export async function deleteMapping(db, id) {
  const res = await db.batch([
    db.prepare("DELETE FROM destinations WHERE mapping_id = ?").bind(id),
    db.prepare("DELETE FROM mappings WHERE id = ?").bind(id),
  ]);
  if (res[1].meta.changes === 0) throw new ApiError(404, "Mapping not found");
  return { ok: true };
}

// ---------- CSV import ----------

// Infer domains from source addresses, auto-create them, and upsert mappings.
// Validation runs fully before any write. Because D1 lacks interactive
// transactions, the write is split into ordered phases, each atomic on its own:
// (A) insert new domains, (B) read domain ids, (C) insert mappings,
// (D) read mapping ids, (E) replace destinations.
export async function importCsv(db, csvText) {
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

  // Pre-read existing domains + mapping sources to compute accurate counts.
  const existingDomains = (await db.prepare("SELECT id, name FROM domains").all()).results;
  const domainIdByName = new Map(existingDomains.map((d) => [d.name.toLowerCase(), d.id]));
  const existingMaps = (await db.prepare(
    "SELECT m.local_part AS lp, d.name AS dom FROM mappings m JOIN domains d ON d.id = m.domain_id"
  ).all()).results;
  const preexistingKeys = new Set(
    existingMaps.map((r) => `${r.lp.toLowerCase()}|${r.dom.toLowerCase()}`));

  const neededDomains = [...new Set(parsed.map((p) => p.domain))];
  const newDomains = neededDomains.filter((n) => !domainIdByName.has(n));
  for (const n of newDomains) {
    if (!DOMAIN_RE.test(n)) throw new ApiError(400, `Invalid domain inferred from source: ${n}`);
  }

  // created vs updated, mirroring sequential upsert (a repeated source within the
  // same import counts as created once, then updated).
  let created = 0;
  let updated = 0;
  const seenKeys = new Set(preexistingKeys);
  for (const p of parsed) {
    const key = `${p.localPart}|${p.domain}`;
    if (seenKeys.has(key)) updated++;
    else { created++; seenKeys.add(key); }
  }

  // Phase A: insert new domains.
  if (newDomains.length) {
    await db.batch(newDomains.map((n) =>
      db.prepare("INSERT OR IGNORE INTO domains (name) VALUES (?)").bind(n)));
  }
  // Phase B: refresh domain id map.
  const allDomains = (await db.prepare("SELECT id, name FROM domains").all()).results;
  const domByName = new Map(allDomains.map((d) => [d.name.toLowerCase(), d.id]));

  // Phase C: insert mappings (idempotent).
  await db.batch(parsed.map((p) =>
    db.prepare("INSERT OR IGNORE INTO mappings (local_part, domain_id) VALUES (?, ?)")
      .bind(p.localPart, domByName.get(p.domain))));
  // Phase D: mapping id map.
  const allMaps = (await db.prepare("SELECT id, local_part AS lp, domain_id AS did FROM mappings").all()).results;
  const mapId = new Map(allMaps.map((r) => [`${r.lp.toLowerCase()}|${r.did}`, r.id]));

  // Phase E: replace destinations per row.
  const stmts = [];
  for (const p of parsed) {
    const did = domByName.get(p.domain);
    const id = mapId.get(`${p.localPart}|${did}`);
    stmts.push(db.prepare("DELETE FROM destinations WHERE mapping_id = ?").bind(id));
    for (const e of p.destinations) {
      stmts.push(db.prepare("INSERT INTO destinations (mapping_id, email) VALUES (?, ?)").bind(id, e));
    }
  }
  if (stmts.length) await db.batch(stmts);

  return { domainsAdded: newDomains.length, created, updated, rows: parsed.length };
}
