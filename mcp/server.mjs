#!/usr/bin/env node
// Local stdio MCP server for the Email Forwarding Manager.
//
// Wraps the app's REST API as MCP tools so a desktop MCP client (Claude
// Desktop, VS Code, Clawpilot, ...) can drive the tool. It is a thin proxy —
// all logic stays in the app — so the core Node server stays dependency-free.
//
// Point it at either backend via env vars:
//   MCP_BASE_URL             base URL (default http://localhost:4748, the local server)
//   CF_ACCESS_CLIENT_ID      Cloudflare Access service-token client id  (hosted only)
//   CF_ACCESS_CLIENT_SECRET  Cloudflare Access service-token secret     (hosted only)
//
// For the hosted Worker set e.g.
//   MCP_BASE_URL=https://mail-admin.example.com
// plus the two CF_ACCESS_* values (see the API section of the README).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE = (process.env.MCP_BASE_URL || "http://localhost:4748").replace(/\/+$/, "");

function authHeaders() {
  const h = {};
  const id = process.env.CF_ACCESS_CLIENT_ID;
  const secret = process.env.CF_ACCESS_CLIENT_SECRET;
  if (id && secret) {
    h["CF-Access-Client-Id"] = id;
    h["CF-Access-Client-Secret"] = secret;
  }
  return h;
}

async function api(method, path, body) {
  const init = { method, headers: { ...authHeaders() } };
  if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(BASE + path, init);
  } catch (e) {
    return { ok: false, status: 0, data: `Cannot reach ${BASE}: ${e.message}` };
  }
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

const call = (method, path, body) => api(method, path, body).then(toResult);

const server = new McpServer({ name: "email-forwarding-manager", version: "1.0.0" });

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

const transport = new StdioServerTransport();
await server.connect(transport);
