// Remote MCP server for the Cloudflare-hosted Email Forwarding Manager.
//
// Exposes the same operations as the REST API as MCP tools, so an AI agent or
// any MCP client can drive the tool over the network (Streamable HTTP at /mcp,
// gated by the same Cloudflare Access in front of the Worker).
//
// Stateless by design: a fresh McpServer is built per request (required by MCP
// SDK 1.26+). All state already lives in the SessionStore Durable Object, which
// owns the API logic — every tool just calls that singleton DO through the same
// /api/* interface src/index.js proxies, so there is no duplicated logic and no
// extra Durable Object.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// Call the singleton SessionStore DO exactly the way src/index.js proxies /api/*.
async function callApi(env, method, path, body) {
  const stub = env.SESSION.get(env.SESSION.idFromName("singleton"));
  const init = { method };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await stub.fetch(new Request("https://do" + path, init));
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { ok: res.ok, status: res.status, data };
}

function toResult(r) {
  const text = typeof r.data === "string" ? r.data : JSON.stringify(r.data, null, 2);
  return r.ok
    ? { content: [{ type: "text", text }] }
    : { content: [{ type: "text", text: `Error ${r.status}: ${text}` }], isError: true };
}

// Build a fresh MCP server bound to this request's env.
export function createMcpServer(env) {
  const server = new McpServer({ name: "email-forwarding-manager", version: "1.0.0" });
  const call = (method, path, body) => callApi(env, method, path, body).then(toResult);

  server.tool("get_status", "Cloudflare connection status.", {},
    () => call("GET", "/api/cloudflare/status"));

  server.tool("list_zones", "List zones (domains) in the connected Cloudflare account.", {},
    () => call("GET", "/api/cloudflare/zones"));

  server.tool("list_mappings", "List all staged forwarding mappings, domains and verified destinations.", {},
    () => call("GET", "/api/state"));

  server.tool("get_plan",
    "Live deploy plan: which mappings are deployed, need update, or are blocked, plus destination statuses.", {},
    () => call("GET", "/api/cloudflare/plan"));

  server.tool("create_mapping",
    "Create a forwarding mapping. A localPart of '*' makes a catch-all. Staged until deploy.",
    { localPart: z.string(), domain: z.string(), destinations: z.array(z.string()).min(1) },
    (a) => call("POST", "/api/mappings", a));

  server.tool("update_mapping",
    "Update an existing mapping by id.",
    { id: z.number(), localPart: z.string(), domain: z.string(), destinations: z.array(z.string()).min(1) },
    ({ id, ...rest }) => call("PUT", `/api/mappings/${id}`, rest));

  server.tool("delete_mapping", "Delete a mapping by id.",
    { id: z.number() },
    ({ id }) => call("DELETE", `/api/mappings/${id}`));

  server.tool("import_mappings_csv",
    "Bulk-import mappings from CSV (columns: source,destinations). Existing sources are overwritten. Staged until deploy.",
    { csv: z.string() },
    ({ csv }) => call("POST", "/api/import", { csv }));

  server.tool("list_destinations", "List Cloudflare destination addresses and their verification status.", {},
    () => call("GET", "/api/cloudflare/destinations"));

  server.tool("add_destination",
    "Add a destination address and send it a Cloudflare verification email.",
    { email: z.string() },
    ({ email }) => call("POST", "/api/cloudflare/destinations", { email }));

  server.tool("import_destinations_csv",
    "Bulk verify-only: add many destination addresses (paste/CSV) and send verification emails. Does not change mappings.",
    { csv: z.string() },
    ({ csv }) => call("POST", "/api/cloudflare/destinations/import", { csv }));

  server.tool("deploy", "Push all ready staged mappings to Cloudflare (idempotent).", {},
    () => call("POST", "/api/cloudflare/deploy"));

  return server;
}
