// Stub for the optional `ai` (Vercel AI SDK) peer dependency of the Agents SDK.
//
// This Worker only uses `agents/mcp` (createMcpHandler) with MCP tools whose
// input schemas are defined with zod — which the MCP SDK converts itself. The
// Agents SDK's lazy `import("ai")` lives in its client-transport code, which
// this Worker never runs. The import is only reachable through the module graph
// that esbuild resolves statically, so this stub exists purely to satisfy the
// bundler without pulling in the full AI SDK. If a code path ever actually calls
// into it, that is a signal the AI SDK is genuinely needed and should be added
// as a real dependency.
export function jsonSchema(schema) {
  return schema;
}
