// Cloudflare-hosted Email Forwarding Manager — Worker entry point.
//
// The static UI in ../mappings is served by the Workers Static Assets binding
// (configured in wrangler.toml), which is matched before this Worker runs. The
// Worker is the fallback, so it only ever sees /api/* requests.
//
// All API handling, the in-memory staged mapping store, and the Cloudflare
// client live in the SessionStore Durable Object — the stateful equivalent of
// the local app's long-lived process. This Worker just forwards every /api/*
// request to the one singleton instance of that DO.
//
// Auth is handled at the edge by Cloudflare Access (e.g. Google federation) —
// there is intentionally no auth code here.

import { createMcpHandler } from "agents/mcp";
import { createMcpServer } from "./mcp.js";

export { SessionStore } from "./session.js";

export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;

    // Remote MCP endpoint (Streamable HTTP), behind the same Cloudflare Access.
    // Stateless: a fresh server per request; all state lives in SessionStore.
    if (path === "/mcp") {
      return createMcpHandler(createMcpServer(env), { route: "/mcp" })(request, env, ctx);
    }

    // Static assets are served by the platform before the Worker; anything that
    // reaches us and isn't an /api/ call has no handler.
    if (!path.startsWith("/api/")) {
      return new Response("Not found", { status: 404 });
    }

    // Route to the single shared session store (the DO owns all API logic).
    const id = env.SESSION.idFromName("singleton");
    const stub = env.SESSION.get(id);
    return stub.fetch(request);
  },
};
