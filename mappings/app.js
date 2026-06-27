// Mappings manager frontend. Vanilla JS, no framework. Talks to the local
// REST API served by scripts/serve-mappings.mjs.

const $ = (id) => document.getElementById(id);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LOCAL_RE = /^[^\s@]+$/;

const state = {
  domains: [],
  mappings: [],
};

function setStatus(el, text, kind) {
  el.textContent = text || "";
  el.className = "status-area" + (kind ? " " + kind : "");
}
function setErr(el, e) { setStatus(el, e?.message || String(e), "error"); }
function setOk(el, msg) { setStatus(el, msg, "ok"); }

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ---------- API ----------

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) throw new Error(data?.error || `${method} ${path} failed (${res.status})`);
  return data;
}

async function loadState() {
  const s = await api("GET", "/api/state");
  state.domains = s.domains;
  state.mappings = s.mappings;
  renderDomains();
  renderMappings();
}

// ---------- Domains ----------

function renderDomains() {
  const box = $("domain-chips");
  box.innerHTML = "";
  if (state.domains.length === 0) {
    box.innerHTML = `<span class="muted">No domains yet — add one below.</span>`;
    return;
  }
  for (const d of state.domains) {
    const pill = document.createElement("span");
    pill.className = "pill";
    pill.innerHTML = `<span class="mono">${escapeHtml(d.name)}</span>`;
    const x = document.createElement("button");
    x.type = "button";
    x.textContent = "×";
    x.title = "Remove domain";
    x.addEventListener("click", () => onRemoveDomain(d));
    pill.appendChild(x);
    box.appendChild(pill);
  }
}

async function onAddDomain() {
  const input = $("in-domain");
  const name = input.value.trim().toLowerCase();
  if (!name) return;
  setStatus($("domain-status"), "Adding…");
  try {
    await api("POST", "/api/domains", { name });
    input.value = "";
    setOk($("domain-status"), `Added ${name}.`);
    await loadState();
    afterDataChange();
  } catch (e) {
    setErr($("domain-status"), e);
  }
}

async function onRemoveDomain(d) {
  const used = state.mappings.filter((m) => m.domainId === d.id);
  const msg = used.length
    ? `Remove domain "${d.name}"? This will also delete ${used.length} mapping(s) using it.`
    : `Remove domain "${d.name}"?`;
  if (!confirm(msg)) return;
  setStatus($("domain-status"), "Removing…");
  try {
    await api("DELETE", `/api/domains/${d.id}`);
    setOk($("domain-status"), `Removed ${d.name}.`);
    await loadState();
    afterDataChange();
  } catch (e) {
    setErr($("domain-status"), e);
  }
}

// ---------- Mappings ----------

function renderMappings() {
  const body = $("mappings-body");
  body.innerHTML = "";
  if (state.mappings.length === 0) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="4" class="muted">No mappings yet.</td>`;
    body.appendChild(tr);
    return;
  }
  const statusMap = cfStatusBySource();
  for (const m of state.mappings) {
    const tr = document.createElement("tr");

    const src = document.createElement("td");
    src.className = "src";
    src.textContent = m.source;
    tr.appendChild(src);

    const dest = document.createElement("td");
    dest.className = "dest";
    dest.innerHTML = m.destinations.map(escapeHtml).join("<br>");
    tr.appendChild(dest);

    const stat = document.createElement("td");
    stat.appendChild(renderRowStatus(m.source, statusMap));
    tr.appendChild(stat);

    const act = document.createElement("td");
    act.className = "right";
    const edit = document.createElement("button");
    edit.textContent = "Edit";
    edit.addEventListener("click", () => openDialog(m));
    const del = document.createElement("button");
    del.textContent = "Delete";
    del.className = "danger";
    del.style.marginLeft = "6px";
    del.addEventListener("click", () => onDeleteMapping(m));
    act.appendChild(edit);
    act.appendChild(del);
    tr.appendChild(act);

    body.appendChild(tr);
  }
}

// Map source address -> live Cloudflare status, derived from the current plan.
function cfStatusBySource() {
  const map = new Map();
  if (!cfPlan) return map;
  for (const e of cfPlan.ready || []) {
    map.set(e.source, { deployState: e.deployState, blocked: false });
  }
  for (const e of cfPlan.blocked || []) {
    map.set(e.source, { deployState: e.deployState, blocked: true, reasons: e.reasons });
  }
  return map;
}

// Build the per-row Cloudflare status cell content.
function renderRowStatus(source, statusMap) {
  const span = document.createElement("span");
  if (!cfConnected) {
    span.className = "muted";
    span.textContent = "—";
    return span;
  }
  if (!cfPlan) {
    span.innerHTML = cfPlanLoading
      ? `<span class="spinner"></span> <span class="muted">checking…</span>`
      : `<span class="muted">unknown</span>`;
    return span;
  }
  const info = statusMap.get(source);
  if (!info) {
    span.innerHTML = cfPlanLoading
      ? `<span class="spinner"></span> <span class="muted">checking…</span>`
      : cfDeployBadge("unknown");
    return span;
  }
  span.innerHTML = cfDeployBadge(info.deployState);
  if (info.blocked) {
    const title = (info.reasons || []).join("; ");
    const link = document.createElement("a");
    link.href = "#";
    link.className = "badge missing badge-link";
    link.textContent = "Need verification";
    link.title = `${title} — open Destinations to verify`;
    link.addEventListener("click", (e) => {
      e.preventDefault();
      switchTab("destinations");
    });
    span.appendChild(document.createTextNode(" "));
    span.appendChild(link);
  }
  return span;
}

async function onDeleteMapping(m) {
  if (!confirm(`Delete mapping for ${m.source}?`)) return;
  try {
    await api("DELETE", `/api/mappings/${m.id}`);
    setOk($("mappings-status"), `Deleted ${m.source}.`);
    await loadState();
    afterDataChange();
  } catch (e) {
    setErr($("mappings-status"), e);
  }
}

// ---------- Dialog (create / edit) ----------

let editingId = null;

function addDestRow(value = "") {
  const wrap = document.createElement("div");
  wrap.className = "dest-edit-row";
  const input = document.createElement("input");
  input.type = "email";
  input.placeholder = "user@example.com";
  input.value = value;
  const rm = document.createElement("button");
  rm.type = "button";
  rm.textContent = "−";
  rm.className = "danger";
  rm.addEventListener("click", () => {
    if ($("dlg-dests").children.length > 1) wrap.remove();
    else input.value = "";
  });
  wrap.appendChild(input);
  wrap.appendChild(rm);
  $("dlg-dests").appendChild(wrap);
}

function openDialog(mapping) {
  if (state.domains.length === 0) {
    setErr($("mappings-status"), new Error("Add at least one domain first."));
    return;
  }
  editingId = mapping ? mapping.id : null;
  $("dlg-title").textContent = mapping ? "Edit mapping" : "New mapping";
  setStatus($("dlg-status"), "");

  // Domain dropdown
  const sel = $("dlg-domain");
  sel.innerHTML = state.domains
    .map((d) => `<option value="${d.id}">@${escapeHtml(d.name)}</option>`)
    .join("");

  $("dlg-local").value = mapping ? mapping.localPart : "";
  sel.value = mapping ? mapping.domainId : state.domains[0].id;

  $("dlg-dests").innerHTML = "";
  const dests = mapping && mapping.destinations.length ? mapping.destinations : [""];
  for (const d of dests) addDestRow(d);

  $("dlg").showModal();
  $("dlg-local").focus();
}

function collectDialog() {
  const localPart = $("dlg-local").value.trim().toLowerCase();
  const domainId = Number($("dlg-domain").value);
  if (!LOCAL_RE.test(localPart)) throw new Error("Enter a valid local part (no spaces or @).");
  const inputs = [...$("dlg-dests").querySelectorAll("input")];
  const seen = new Set();
  const destinations = [];
  for (const inp of inputs) {
    const e = inp.value.trim().toLowerCase();
    if (!e) continue;
    if (!EMAIL_RE.test(e)) throw new Error(`Invalid destination email: ${inp.value}`);
    if (seen.has(e)) continue;
    seen.add(e);
    destinations.push(e);
  }
  if (destinations.length === 0) throw new Error("Add at least one destination.");
  return { localPart, domainId, destinations };
}

async function onDialogSave(ev) {
  ev.preventDefault();
  let payload;
  try {
    payload = collectDialog();
  } catch (e) {
    setErr($("dlg-status"), e);
    return;
  }
  try {
    if (editingId == null) await api("POST", "/api/mappings", payload);
    else await api("PUT", `/api/mappings/${editingId}`, payload);
    $("dlg").close();
    setOk($("mappings-status"), "Saved.");
    await loadState();
    afterDataChange();
  } catch (e) {
    setErr($("dlg-status"), e);
  }
}

// ---------- CSV import wizard ----------

const impwiz = { step: "input", result: null };

function openImportWizard() {
  impwiz.step = "input";
  impwiz.result = null;
  $("impwiz").showModal();
  impwizGo("input");
}

function impwizGo(step) {
  impwiz.step = step;
  const order = ["input", "done"];
  for (const li of $("impwiz-steps").children) {
    const s = li.dataset.step;
    li.classList.toggle("active", s === step);
    li.classList.toggle("done", order.indexOf(s) < order.indexOf(step));
  }
  if (step === "input") impwizRenderInput();
  else impwizRenderDone();
}

function impwizRenderInput() {
  const body = $("impwiz-body");
  body.innerHTML =
    `<p>Two columns: <code>source</code> and <code>destinations</code> ` +
    `(comma-separated; quote the cell if it contains commas). A header row is ` +
    `optional. Domains are inferred from each source address and added ` +
    `automatically. Existing sources are overwritten.</p>` +
    `<p class="muted mono" style="font-size:0.82rem">info@example.org,"alice@gmail.com, bob@outlook.com"</p>` +
    `<div class="row"><input id="imp-file" type="file" accept=".csv,text/csv,text/plain" />` +
    `<span class="muted">or paste below</span></div>` +
    `<textarea id="imp-text" rows="7" placeholder="source,destinations&#10;alias@example.com,&quot;a@gmail.com, b@gmail.com&quot;" ` +
    `style="width:100%; margin-top:8px; font-family: var(--mono); padding:8px; border:1px solid var(--border); border-radius:6px;"></textarea>` +
    `<div id="imp-status" class="status-area"></div>`;
  $("imp-file").addEventListener("change", (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => { $("imp-text").value = String(reader.result || ""); };
    reader.onerror = () => setErr($("imp-status"), new Error("Could not read file."));
    reader.readAsText(f);
  });
  const next = $("impwiz-next"), back = $("impwiz-back"), cancel = $("impwiz-cancel");
  back.hidden = true; back.onclick = null;
  next.hidden = false; next.textContent = "Import"; next.disabled = false; next.onclick = impwizDoImport;
  cancel.hidden = false; cancel.textContent = "Cancel"; cancel.disabled = false; cancel.onclick = () => $("impwiz").close();
}

async function impwizDoImport() {
  const csv = $("imp-text").value;
  if (!csv.trim()) { setErr($("imp-status"), new Error("Choose a file or paste CSV first.")); return; }
  $("impwiz-next").disabled = true;
  setStatus($("imp-status"), "Importing…");
  try {
    impwiz.result = await api("POST", "/api/import", { csv });
    await loadState();
    afterDataChange();
    impwizGo("done");
  } catch (e) {
    setErr($("imp-status"), e);
    $("impwiz-next").disabled = false;
  }
}

function impwizRenderDone() {
  const body = $("impwiz-body");
  const r = impwiz.result || {};
  body.innerHTML =
    `<p><strong>Import complete.</strong></p><ul class="wiz-list">` +
    `<li>${r.rows || 0} row(s) processed</li>` +
    `<li>${r.created || 0} created</li>` +
    `<li>${r.updated || 0} updated</li>` +
    `<li>${r.domainsAdded || 0} domain(s) added</li></ul>`;
  const next = $("impwiz-next"), back = $("impwiz-back"), cancel = $("impwiz-cancel");
  back.hidden = false; back.textContent = "Import more"; back.onclick = () => impwizGo("input");
  next.hidden = false; next.textContent = "Close"; next.disabled = false; next.onclick = () => $("impwiz").close();
  cancel.hidden = true;
}

// ---------- Cloudflare deploy ----------

let cfPlan = null;
let cfConnected = false;
let cfPlanLoading = false;
let cfStatusAccount = null;

// ---------- Tabs ----------

const TABS = ["overview", "connection", "destinations", "mappings", "guide"];
let activeTab = "overview";

function switchTab(name) {
  if (!TABS.includes(name)) return;
  activeTab = name;
  for (const b of $("tabs").children) {
    b.classList.toggle("active", b.dataset.tab === name);
  }
  for (const t of TABS) $("tab-" + t).hidden = t !== name;
  if (name === "overview") updateOverview();
  else if (name === "connection") cfRefreshStatus();
  else if (name === "destinations") refreshDestinationsTab();
  else if (name === "mappings") { renderMappings(); updateMappingsBanner(); }
}

// Status summary + wizard launchers shown on the Overview tab.
function updateOverview() {
  const box = $("overview-status");
  const deployBtn = $("btn-deploy-wizard");
  if (deployBtn) {
    deployBtn.disabled = !cfConnected;
    deployBtn.title = cfConnected ? "" : "Connect to Cloudflare first";
  }
  if (!box) return;
  if (!cfConnected) {
    box.className = "cf-banner warn";
    box.innerHTML =
      `<div class="row"><span>Not connected to Cloudflare. Connect to enable ` +
      `live status, destination management and deploy.</span>` +
      `<button id="ov-go-connect">Go to Connection</button></div>`;
    $("ov-go-connect").addEventListener("click", () => switchTab("connection"));
    return;
  }
  const acct = cfStatusAccount?.name || cfStatusAccount?.id || "your account";
  const lines = [`<div>Connected to <strong>${escapeHtml(acct)}</strong>.</div>`];
  if (cfPlanLoading && !cfPlan) {
    lines.push(`<div class="muted"><span class="spinner"></span> checking status…</div>`);
  } else if (cfPlan) {
    lines.push(`<div class="muted">Mappings: ${cfPlan.summary.deployed} deployed · ` +
      `${cfPlan.summary.outdated} need update · ${cfPlan.summary.absent} not deployed</div>`);
    const dests = cfPlan.destinations || [];
    const v = dests.filter((d) => d.status === "verified").length;
    const p = dests.filter((d) => d.status === "pending").length;
    const miss = dests.filter((d) => d.status === "missing").length;
    lines.push(`<div class="muted">Destinations: ${v} verified · ${p} pending` +
      (miss ? ` · ${miss} not registered` : "") + `</div>`);
  }
  box.className = "cf-banner";
  box.innerHTML =
    `<div class="row" style="justify-content:space-between; align-items:flex-start">` +
    `<div>${lines.join("")}</div>` +
    `<button id="ov-refresh">${cfPlanLoading ? "Checking…" : "Refresh status"}</button></div>`;
  const rb = $("ov-refresh");
  rb.disabled = cfPlanLoading;
  rb.addEventListener("click", () => backgroundLoadPlan(true));
}

// Show the destinations panel only when connected; otherwise a guard message.
function refreshDestinationsTab() {
  const guard = $("dests-guard");
  const area = $("cf-dests-area");
  if (!cfConnected) {
    if (guard) guard.hidden = false;
    if (area) area.hidden = true;
    return;
  }
  if (guard) guard.hidden = true;
  if (area) area.hidden = false;
  onCfDestsRefresh();
}

// Re-render every CF-status-dependent surface (no network calls).
function renderCfStatusUi() {
  updateOverview();
  updateMappingsBanner();
  renderMappings();
}

// Like renderCfStatusUi, but also refreshes the destinations tab if it's open.
function afterCfStateChange() {
  renderCfStatusUi();
  if (activeTab === "destinations") refreshDestinationsTab();
}

// Called after any DB data change (mapping or domain CRUD, CSV import) so every
// Cloudflare-derived surface re-syncs: per-row mapping status, Overview counts,
// and the Destinations list (so a newly referenced address surfaces for
// verification). When connected, force a fresh plan; the per-row status shows a
// "checking…" spinner until it arrives.
function afterDataChange() {
  if (cfConnected) backgroundLoadPlan(true);
  else renderCfStatusUi();
  if (activeTab === "destinations") refreshDestinationsTab();
}

// Lightweight connection check used on load and after any token/account change.
// Updates every surface without forcing the slow plan call; if connected, kicks
// a background plan load.
async function refreshCfConnection() {
  let s;
  try { s = await api("GET", "/api/cloudflare/status"); }
  catch { cfConnected = false; cfStatusAccount = null; afterCfStateChange(); return; }
  cfConnected = !!(s.connected && s.tokenValid && s.account);
  cfStatusAccount = s.account || null;
  if (!cfConnected) cfPlan = null;
  afterCfStateChange();
  if (cfConnected) backgroundLoadPlan(false);
}

// Fetch the (slow) plan in the background and refresh the table as statuses
// arrive. `force` re-fetches even if a plan is already cached.
async function backgroundLoadPlan(force) {
  if (!cfConnected || cfPlanLoading) return;
  if (cfPlan && !force) return;
  cfPlanLoading = true;
  renderCfStatusUi();
  try {
    const p = await api("GET", "/api/cloudflare/plan");
    cfPlan = p;
  } catch { /* keep previous plan; banner still shows connected */ }
  finally {
    cfPlanLoading = false;
    renderCfStatusUi();
  }
}

// Connection banner inside the Mappings section: hidden when connected (status
// now lives in Overview + the per-row column); a warning otherwise.
function updateMappingsBanner() {
  const el = $("mappings-cf-banner");
  if (!el) return;
  if (!cfConnected) {
    el.hidden = false;
    el.className = "cf-banner warn";
    el.innerHTML =
      `<div class="row"><span>Not connected to Cloudflare — connect to see live ` +
      `status and deploy these mappings.</span>` +
      `<button id="banner-open-cf">Go to Connection</button></div>`;
    $("banner-open-cf").addEventListener("click", () => switchTab("connection"));
    return;
  }
  el.hidden = true;
}

async function cfRefreshStatus() {
  let s;
  try { s = await api("GET", "/api/cloudflare/status"); }
  catch (e) { setErr($("cf-connect-status"), e); return; }

  if (!s.connected) {
    $("btn-cf-forget").hidden = true;
    setStatus($("cf-connect-status"), "");
    return;
  }
  $("btn-cf-forget").hidden = false;
  if (!s.tokenValid) {
    setErr($("cf-connect-status"), new Error(s.error || `Token status: ${s.tokenStatus}`));
    return;
  }
  if (s.account) {
    setOk($("cf-connect-status"),
      `Connected · account: ${s.account.name || s.account.id}`);
    $("cf-account-wrap").hidden = true;
  } else {
    setStatus($("cf-connect-status"), "Token valid — select an account.");
    $("cf-account-wrap").hidden = true;
  }
}

async function onCfSaveToken() {
  const token = $("cf-token").value.trim();
  if (!token) { setErr($("cf-connect-status"), new Error("Paste a token first.")); return; }
  setStatus($("cf-connect-status"), "Verifying token…");
  try {
    const r = await api("POST", "/api/cloudflare/token", { token });
    $("cf-token").value = "";
    const accounts = r.accounts || [];
    if (r.accountId) {
      // Backend already picked an account (it auto-selects when there's one).
      $("cf-account-wrap").hidden = true;
      await cfRefreshStatus();
    } else if (accounts.length > 1) {
      // Only ambiguous (multi-account) tokens need the picker.
      const sel = $("cf-account");
      sel.innerHTML = accounts
        .map((a) => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.name || a.id)}</option>`)
        .join("");
      $("cf-account-wrap").hidden = false;
      $("btn-cf-forget").hidden = false;
      setStatus($("cf-connect-status"), "Token valid — choose an account.");
    } else if (accounts.length === 1) {
      // Exactly one account: select it automatically, no picker.
      $("cf-account-wrap").hidden = true;
      await api("POST", "/api/cloudflare/account", { accountId: accounts[0].id });
      await cfRefreshStatus();
    } else {
      $("cf-account-wrap").hidden = true;
      setErr($("cf-connect-status"),
        new Error("This token has no accessible accounts. Check its Account Resources."));
    }
    await refreshCfConnection();
  } catch (e) {
    setErr($("cf-connect-status"), e);
  }
}

async function onCfSetAccount() {
  const accountId = $("cf-account").value;
  if (!accountId) return;
  try {
    await api("POST", "/api/cloudflare/account", { accountId });
    await cfRefreshStatus();
    await refreshCfConnection();
  } catch (e) {
    setErr($("cf-connect-status"), e);
  }
}

async function onCfForget() {
  if (!confirm("Remove the stored Cloudflare token?")) return;
  try {
    await api("DELETE", "/api/cloudflare/token");
    cfPlan = null;
    await cfRefreshStatus();
    await refreshCfConnection();
  } catch (e) {
    setErr($("cf-connect-status"), e);
  }
}

// A small badge describing how a mapping compares to what's live on Cloudflare.
function cfDeployBadge(state) {
  const label = {
    deployed: "on Cloudflare",
    outdated: "needs update",
    absent: "not deployed",
    unknown: "unknown",
  }[state] || state || "unknown";
  return `<span class="badge ${state || "unknown"}">${label}</span>`;
}

function renderCfDestinations(d) {
  const root = $("cf-dests-list");
  root.innerHTML = "";

  // Addresses referenced by mappings but not (yet) registered on Cloudflare.
  // These won't appear in the CF address list, so surface them here with a
  // one-click "Send verification" so a brand-new mapping destination is
  // immediately actionable.
  const have = new Set(d.addresses.map((a) => a.email.toLowerCase()));
  const referenced = [...new Set(
    state.mappings.flatMap((m) => m.destinations.map((e) => e.toLowerCase())))];
  const unregistered = referenced.filter((e) => !have.has(e)).sort();

  if (!d.addresses.length && !unregistered.length) {
    root.appendChild(Object.assign(document.createElement("div"),
      { className: "muted", textContent: "No destination addresses yet. Add one above." }));
    return;
  }
  const head = document.createElement("div");
  head.className = "muted";
  head.style.marginBottom = "6px";
  head.textContent = `${d.summary.verified} verified · ${d.summary.pending} pending` +
    (unregistered.length ? ` · ${unregistered.length} not registered` : "");
  root.appendChild(head);
  for (const a of d.addresses) {
    const item = document.createElement("div");
    item.className = "cf-item row";
    item.style.justifyContent = "space-between";
    const status = a.verified ? "verified" : "pending";
    const esc = escapeHtml(a.email);
    const resend = a.verified ? "" :
      `<button data-email="${esc}" class="cf-dest-resend">Resend</button>`;
    item.innerHTML = `<span class="mono">${esc}</span>` +
      `<span class="row" style="gap:8px"><span class="badge ${status}">${status}</span>${resend}` +
      `<button data-email="${esc}" data-verified="${a.verified ? "1" : "0"}" class="cf-dest-remove danger">Remove</button></span>`;
    root.appendChild(item);
  }
  for (const email of unregistered) {
    const item = document.createElement("div");
    item.className = "cf-item row";
    item.style.justifyContent = "space-between";
    const esc = escapeHtml(email);
    item.innerHTML = `<span class="mono">${esc}</span>` +
      `<span class="row" style="gap:8px"><span class="badge pending" title="Used by a mapping but not yet a Cloudflare destination">not registered</span>` +
      `<button data-email="${esc}" class="cf-dest-register">Send verification</button></span>`;
    root.appendChild(item);
  }
  root.querySelectorAll(".cf-dest-resend").forEach((btn) => {
    btn.addEventListener("click", () => onCfDestAdd(btn.dataset.email, btn));
  });
  root.querySelectorAll(".cf-dest-register").forEach((btn) => {
    btn.addEventListener("click", () => onCfDestAdd(btn.dataset.email, btn));
  });
  root.querySelectorAll(".cf-dest-remove").forEach((btn) => {
    btn.addEventListener("click", () => onCfDestRemove(btn.dataset.email, btn.dataset.verified === "1", btn));
  });
}

async function onCfDestsRefresh() {
  setStatus($("cf-dests-status"), "Loading destination addresses…");
  try {
    const d = await api("GET", "/api/cloudflare/destinations");
    renderCfDestinations(d);
    setStatus($("cf-dests-status"), "");
  } catch (e) {
    setErr($("cf-dests-status"), e);
  }
}

async function onCfDestAdd(emailArg, btn) {
  const fromField = typeof emailArg !== "string";
  const email = (fromField ? $("cf-dest-email").value : emailArg).trim().toLowerCase();
  if (!email) { setErr($("cf-dests-status"), new Error("Enter an email address first.")); return; }
  if (btn) btn.disabled = true;
  setStatus($("cf-dests-status"), `Sending verification to ${email}…`);
  try {
    const r = await api("POST", "/api/cloudflare/destinations", { email });
    if (fromField) $("cf-dest-email").value = "";
    setOk($("cf-dests-status"), r.note || "Done.");
    await onCfDestsRefresh();
    if (cfConnected) backgroundLoadPlan(true);
  } catch (e) {
    setErr($("cf-dests-status"), e);
    if (btn) btn.disabled = false;
  }
}


async function onCfDestRemove(email, verified, btn) {
  const warn = verified
    ? `Remove the VERIFIED address ${email}? Any mapping forwarding to it will stop working until it is re-added and re-verified.`
    : `Remove the pending address ${email}?`;
  if (!confirm(warn)) return;
  if (btn) btn.disabled = true;
  setStatus($("cf-dests-status"), `Removing ${email}…`);
  try {
    const r = await api("DELETE", "/api/cloudflare/destinations/" + encodeURIComponent(email));
    setOk($("cf-dests-status"), r.note || "Removed.");
    await onCfDestsRefresh();
    if (cfConnected) await backgroundLoadPlan(true);
  } catch (e) {
    setErr($("cf-dests-status"), e);
    if (btn) btn.disabled = false;
  }
}

// ---------- Deploy wizard ----------

const WIZ_STEPS = ["check", "validate", "deploy", "done"];
const wiz = { step: "check", deploy: null, busy: false };

function openWizard() {
  if (!cfConnected) { switchTab("connection"); return; }
  wiz.step = "check";
  wiz.deploy = null;
  wiz.busy = false;
  $("wiz").showModal();
  wizGo("check");
}

function wizClose() {
  if (wiz.busy) return;
  $("wiz").close();
}

function wizGo(step) {
  wiz.step = step;
  const idx = WIZ_STEPS.indexOf(step);
  for (const li of $("wiz-steps").children) {
    const s = li.dataset.step;
    const i = WIZ_STEPS.indexOf(s);
    li.classList.toggle("active", i === idx);
    li.classList.toggle("done", i < idx);
  }
  wizRender();
}

function wizFooter({ next, nextLabel = "Next", nextPrimary = true, nextDisabled = false, back = null, cancelLabel = "Cancel", cancelDisabled = false }) {
  const nextBtn = $("wiz-next");
  const backBtn = $("wiz-back");
  const cancelBtn = $("wiz-cancel");
  if (next) {
    nextBtn.hidden = false;
    nextBtn.textContent = nextLabel;
    nextBtn.className = nextPrimary ? "primary" : "";
    nextBtn.disabled = nextDisabled;
    nextBtn.onclick = next;
  } else {
    nextBtn.hidden = true;
    nextBtn.onclick = null;
  }
  if (back) {
    backBtn.hidden = false;
    backBtn.onclick = back;
  } else {
    backBtn.hidden = true;
    backBtn.onclick = null;
  }
  cancelBtn.textContent = cancelLabel;
  cancelBtn.disabled = cancelDisabled;
}

function wizRender() {
  const fn = {
    check: wizRenderCheck,
    validate: wizRenderValidate,
    deploy: wizRenderDeploy,
    done: wizRenderDone,
  }[wiz.step];
  fn();
}

async function wizRenderCheck() {
  const body = $("wiz-body");
  body.innerHTML = `<div class="row"><span class="spinner"></span> ` +
    `<span>Checking your Cloudflare account and current mappings…</span></div>`;
  wizFooter({ next: null });
  try {
    cfPlan = await api("GET", "/api/cloudflare/plan");
    renderMappings();
    updateMappingsBanner();
  } catch (e) {
    body.innerHTML = `<div class="cf-banner warn"><div class="row">` +
      `<span>Couldn't read your Cloudflare state: ${escapeHtml(e.message)}</span></div></div>`;
    wizFooter({ next: () => wizGo("check"), nextLabel: "Retry" });
    return;
  }
  const p = cfPlan;
  const parts = [];
  parts.push(`<p>Connected to <strong>${escapeHtml(cfStatusAccount?.name || cfStatusAccount?.id || "your account")}</strong>.</p>`);
  parts.push(`<ul class="wiz-list">`);
  parts.push(`<li>${p.summary.ready} mapping(s) ready to deploy</li>`);
  parts.push(`<li>${p.summary.blocked} blocked (need attention)</li>`);
  parts.push(`<li>On Cloudflare now: ${p.summary.deployed} deployed · ${p.summary.outdated} need update · ${p.summary.absent} not yet deployed</li>`);
  if (p.summary.orphans) parts.push(`<li>${p.summary.orphans} rule(s) on Cloudflare not in your list</li>`);
  parts.push(`</ul>`);
  if (p.blocked.length) {
    parts.push(`<div class="cf-banner warn"><div class="row"><span>` +
      `Some mappings are blocked. You can continue — only ready mappings will deploy.</span></div></div>`);
  }
  const importable = (p.orphans?.importable) || [];
  if (importable.length) {
    parts.push(`<div class="cf-banner" style="margin-top:8px"><div>` +
      `<div><strong>${importable.length} rule(s) exist on Cloudflare but not in your list.</strong></div>` +
      `<div class="muted" style="margin:4px 0 8px">` +
      importable.map((o) => escapeHtml(o.source)).join(", ") + `</div>` +
      `<button id="wiz-import-orphans">Import ${importable.length} into your list</button>` +
      `<div id="wiz-import-status" class="status-area" style="margin-top:6px"></div>` +
      `</div></div>`);
  }
  const undecipherable = (p.orphans?.undecipherable) || [];
  if (undecipherable.length) {
    parts.push(`<div class="cf-banner warn" style="margin-top:8px"><div>` +
      `<div><strong>${undecipherable.length} rule(s) couldn't be read automatically</strong></div>` +
      `<div class="muted" style="margin-top:4px">` +
      undecipherable.map((o) => escapeHtml(o.reason || o.source || o.domain || "unknown")).join("<br>") +
      `</div></div></div>`);
  }
  body.innerHTML = parts.join("");
  if (importable.length) {
    $("wiz-import-orphans").addEventListener("click", wizImportOrphans);
  }
  wizFooter({ next: () => wizGo("validate"), nextLabel: "Next: validate addresses" });
}

async function wizImportOrphans() {
  const btn = $("wiz-import-orphans");
  const st = $("wiz-import-status");
  if (btn) btn.disabled = true;
  setStatus(st, "Importing…");
  try {
    const r = await api("POST", "/api/cloudflare/import-orphans");
    await loadState();
    cfPlan = await api("GET", "/api/cloudflare/plan");
    renderMappings();
    updateMappingsBanner();
    wizRenderCheck();
  } catch (e) {
    setErr(st, e);
    if (btn) btn.disabled = false;
  }
}

function wizRenderValidate() {
  const body = $("wiz-body");
  const dests = (cfPlan?.destinations) || [];
  const verified = dests.filter((d) => d.status === "verified");
  const pending = dests.filter((d) => d.status === "pending");
  const missing = dests.filter((d) => d.status === "missing");

  const parts = [];
  parts.push(`<p>Destination addresses must be verified by Cloudflare before mail can be forwarded to them.</p>`);
  parts.push(`<ul class="wiz-list">`);
  parts.push(`<li><span class="badge verified">verified</span> ${verified.length}</li>`);
  parts.push(`<li><span class="badge pending">pending</span> ${pending.length} — recipient must click the verification email</li>`);
  parts.push(`<li><span class="badge missing">missing</span> ${missing.length} — not yet added to Cloudflare</li>`);
  parts.push(`</ul>`);
  if (pending.length) {
    parts.push(`<div class="muted">Pending: ${pending.map((d) => escapeHtml(d.email)).join(", ")}</div>`);
  }
  if (missing.length) {
    parts.push(`<div class="muted" style="margin-top:6px">Missing: ${missing.map((d) => escapeHtml(d.email)).join(", ")}</div>`);
  }
  parts.push(`<div id="wiz-validate-status" class="status-area" style="margin-top:8px"></div>`);
  body.innerHTML = parts.join("");

  const footer = { back: () => wizGo("check") };
  if (missing.length) {
    footer.next = wizAddMissing;
    footer.nextLabel = `Add & verify ${missing.length} missing`;
  } else {
    footer.next = () => wizGo("deploy");
    footer.nextLabel = "Next: deploy";
  }
  wizFooter(footer);
}

async function wizAddMissing() {
  const st = $("wiz-validate-status");
  $("wiz-next").disabled = true;
  setStatus(st, "Adding missing destinations…");
  try {
    const r = await api("POST", "/api/cloudflare/destinations/add-missing");
    cfPlan = await api("GET", "/api/cloudflare/plan");
    renderMappings();
    updateMappingsBanner();
    const msg = r.added?.length ? `Added ${r.added.length}. ${r.note || ""}` : (r.note || "Done.");
    setOk(st, msg + " Recipients must click the verification email before mail will flow.");
    wizRenderValidate();
    setOk($("wiz-validate-status"), msg);
  } catch (e) {
    setErr(st, e);
    $("wiz-next").disabled = false;
  }
}

function wizRenderDeploy() {
  const body = $("wiz-body");
  const p = cfPlan || { summary: {}, ready: [], blocked: [] };
  const willCreate = p.ready.filter((e) => e.deployState === "absent").length;
  const willUpdate = p.ready.filter((e) => e.deployState === "outdated").length;
  const unchanged = p.ready.filter((e) => e.deployState === "deployed").length;
  const skipped = p.blocked.length;

  const parts = [];
  parts.push(`<p>Ready to apply your mappings to Cloudflare Email Routing.</p>`);
  parts.push(`<ul class="wiz-list">`);
  parts.push(`<li><strong>${willCreate}</strong> new rule(s) will be created</li>`);
  parts.push(`<li><strong>${willUpdate}</strong> rule(s) will be updated</li>`);
  parts.push(`<li>${unchanged} already up to date (no change)</li>`);
  parts.push(`<li>${skipped} blocked mapping(s) will be skipped</li>`);
  parts.push(`</ul>`);
  const toApply = willCreate + willUpdate;
  if (toApply === 0) {
    parts.push(`<div class="muted">Nothing to apply — everything is already up to date.</div>`);
  }
  body.innerHTML = parts.join("");
  wizFooter({
    back: () => wizGo("validate"),
    next: () => wizDoDeploy(),
    nextLabel: toApply ? `Deploy ${toApply} mapping(s)` : "Deploy",
    nextDisabled: toApply === 0,
  });
}

async function wizDoDeploy() {
  const body = $("wiz-body");
  wiz.busy = true;
  wizFooter({ next: null, cancelDisabled: true });
  $("wiz-back").hidden = true;
  body.innerHTML = `<div class="row"><span class="spinner"></span> <span>Deploying to Cloudflare…</span></div>`;
  try {
    wiz.deploy = await api("POST", "/api/cloudflare/deploy");
    cfPlan = await api("GET", "/api/cloudflare/plan");
    renderCfStatusUi();
    wiz.busy = false;
    wizGo("done");
  } catch (e) {
    wiz.busy = false;
    body.innerHTML = `<div class="cf-banner warn"><div class="row">` +
      `<span>Deploy failed: ${escapeHtml(e.message)}</span></div></div>`;
    wizFooter({ back: () => wizGo("deploy"), next: () => wizDoDeploy(), nextLabel: "Retry deploy" });
  }
}

function wizRenderDone() {
  const body = $("wiz-body");
  const r = wiz.deploy || { rules: [], skipped: [] };
  const created = (r.rules || []).filter((x) => x.action === "created").length;
  const updated = (r.rules || []).filter((x) => x.action !== "created").length;

  const parts = [];
  parts.push(`<p><strong>Deploy complete.</strong></p>`);
  parts.push(`<ul class="wiz-list">`);
  parts.push(`<li>${created} rule(s) created</li>`);
  parts.push(`<li>${updated} rule(s) updated</li>`);
  if (r.worker) parts.push(`<li>Fan-out worker "${escapeHtml(r.worker.name)}" updated (${r.worker.mappings} multi-destination mapping(s))</li>`);
  parts.push(`<li>${(r.skipped || []).length} mapping(s) skipped</li>`);
  parts.push(`</ul>`);
  if (r.rules && r.rules.length) {
    parts.push(`<div style="margin-top:6px"><strong>Rules applied</strong></div>`);
    for (const rule of r.rules) {
      parts.push(`<div class="cf-item"><span class="mono">${escapeHtml(rule.source)}</span> ` +
        `<span class="muted">${escapeHtml(rule.action)} (${escapeHtml(rule.kind)})</span></div>`);
    }
  }
  if (r.skipped && r.skipped.length) {
    parts.push(`<div style="margin-top:6px"><strong>Skipped</strong></div>`);
    for (const s of r.skipped) {
      parts.push(`<div class="cf-item"><span class="mono">${escapeHtml(s.source)}</span>` +
        `<div class="reasons">${(s.reasons || []).map(escapeHtml).join("; ")}</div></div>`);
    }
  }
  body.innerHTML = parts.join("");
  wizFooter({ next: () => wizClose(), nextLabel: "Close", cancelLabel: "Close" });
}

// ---------- Wire up ----------

document.addEventListener("DOMContentLoaded", () => {
  $("btn-add-domain").addEventListener("click", onAddDomain);
  $("in-domain").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); onAddDomain(); }
  });
  $("btn-new-mapping").addEventListener("click", () => openDialog(null));
  $("dlg-add-dest").addEventListener("click", () => addDestRow());
  // Submitting the form (Enter in any field, or clicking Save) saves.
  // Escape natively fires the dialog's cancel event, closing it.
  $("dlg-form").addEventListener("submit", onDialogSave);
  $("dlg-cancel").addEventListener("click", () => $("dlg").close());

  // Tabs
  for (const b of $("tabs").children) {
    b.addEventListener("click", () => switchTab(b.dataset.tab));
  }

  // CSV import wizard
  $("btn-import-wizard").addEventListener("click", openImportWizard);
  $("impwiz-cancel").addEventListener("click", () => $("impwiz").close());

  // Cloudflare connection
  $("btn-cf-save-token").addEventListener("click", onCfSaveToken);
  $("cf-token").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); onCfSaveToken(); }
  });
  $("btn-cf-forget").addEventListener("click", onCfForget);
  $("btn-cf-set-account").addEventListener("click", onCfSetAccount);
  $("cf-account").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); onCfSetAccount(); }
  });

  // Destinations
  $("dests-go-connect").addEventListener("click", () => switchTab("connection"));
  $("btn-cf-dests-refresh").addEventListener("click", onCfDestsRefresh);
  $("btn-cf-dest-add").addEventListener("click", () => onCfDestAdd());
  $("cf-dest-email").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); onCfDestAdd(); }
  });

  // Deploy wizard
  $("btn-deploy-wizard").addEventListener("click", openWizard);
  $("wiz-cancel").addEventListener("click", wizClose);
  $("wiz").addEventListener("cancel", (e) => { if (wiz.busy) e.preventDefault(); });

  switchTab("overview");
  loadState()
    .then(() => refreshCfConnection())
    .catch((e) => setErr($("mappings-status"), e));
});
