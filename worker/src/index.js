// Cloudflare-hosted Email Forwarding Manager — Worker entry point.
//
// Serves a small JSON API under /api/*. Everything else (the static UI in
// ../mappings) is served by the Workers Static Assets binding configured in
// wrangler.toml, which is checked before this Worker runs; the Worker is the
// fallback, so in practice it only ever sees /api/* requests.
//
// Auth is handled at the edge by Cloudflare Access (e.g. Google federation) —
// there is intentionally no auth code here.

import {
  ApiError, EMAIL_RE, DOMAIN_RE,
  getState, addDomain, deleteDomain, addMapping, updateMapping, deleteMapping, importCsv,
} from "./db.js";
import { createCloudflare } from "./cloudflare.js";

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

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;

    // Static assets are served by the platform before the Worker; anything that
    // reaches us and isn't an /api/ call has no handler.
    if (!path.startsWith("/api/")) {
      return new Response("Not found", { status: 404 });
    }

    const db = env.DB;
    const cloudflare = createCloudflare({ env, EMAIL_RE, DOMAIN_RE });

    const routes = [
      { method: "GET",    re: /^\/api\/state$/,            handler: () => getState(db) },
      {
        method: "POST",
        re: /^\/api\/import$/,
        handler: (m, body) => {
          const csv = typeof body?.csv === "string" ? body.csv : null;
          if (csv == null) throw new ApiError(400, "Expected JSON body with a 'csv' string");
          return importCsv(db, csv);
        },
      },
      { method: "POST",   re: /^\/api\/domains$/,          handler: (m, body) => addDomain(db, body?.name) },
      { method: "DELETE", re: /^\/api\/domains\/(\d+)$/,   handler: (m) => deleteDomain(db, Number(m[1])) },
      { method: "POST",   re: /^\/api\/mappings$/,         handler: (m, body) => addMapping(db, body) },
      { method: "PUT",    re: /^\/api\/mappings\/(\d+)$/,  handler: (m, body) => updateMapping(db, Number(m[1]), body) },
      { method: "DELETE", re: /^\/api\/mappings\/(\d+)$/,  handler: (m) => deleteMapping(db, Number(m[1])) },

      // ----- Cloudflare integration -----
      { method: "GET",    re: /^\/api\/cloudflare\/status$/,                    handler: () => cloudflare.status() },
      { method: "POST",   re: /^\/api\/cloudflare\/token$/,                     handler: (m, b) => cloudflare.setToken(b?.token) },
      { method: "DELETE", re: /^\/api\/cloudflare\/token$/,                     handler: () => cloudflare.clearToken() },
      { method: "POST",   re: /^\/api\/cloudflare\/account$/,                   handler: (m, b) => cloudflare.setAccount(b?.accountId) },
      { method: "GET",    re: /^\/api\/cloudflare\/plan$/,                      handler: () => cloudflare.plan() },
      { method: "POST",   re: /^\/api\/cloudflare\/import-orphans$/,            handler: (m, b) => cloudflare.importOrphans(b?.sources) },
      { method: "POST",   re: /^\/api\/cloudflare\/destinations\/add-missing$/, handler: () => cloudflare.addMissingDestinations() },
      { method: "GET",    re: /^\/api\/cloudflare\/destinations$/,              handler: () => cloudflare.listDestinations() },
      { method: "POST",   re: /^\/api\/cloudflare\/destinations$/,              handler: (m, b) => cloudflare.addDestination(b?.email) },
      { method: "DELETE", re: /^\/api\/cloudflare\/destinations\/(.+)$/,        handler: (m) => cloudflare.removeDestination(decodeURIComponent(m[1])) },
      { method: "POST",   re: /^\/api\/cloudflare\/enable-routing$/,            handler: (m, b) => cloudflare.enableRouting(b?.zoneId) },
      { method: "POST",   re: /^\/api\/cloudflare\/deploy$/,                    handler: () => cloudflare.deploy() },
    ];

    for (const route of routes) {
      if (request.method !== route.method) continue;
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
  },
};
