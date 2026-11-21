// MCP server (Streamable HTTP) — exposes the connected om-core runtime to MCP-HTTP
// clients (VS Code agent mode, `claude mcp add --transport http`, etc.) as two generic
// tools, om_query / om_command, forwarded verbatim through the extension's EngineClient.
//
// Design notes (docs/ue-plans/plan-20261121-2314--mcp-server.md):
//  - Stateless: a fresh McpServer + transport per request — an McpServer instance can
//    only be connected to one transport at a time.
//  - Loopback only, no auth: same exposure class as the bridge ws server and the
//    runtime's own socket. Content-Type: application/json is required by the protocol,
//    which blocks browser simple-request CSRF.
//  - No FIFO: each tool call is a single envelope; EngineClient multiplexes by
//    correlation_id and the runtime serializes internally.
//  - No `vscode` import: testable in plain Node (same convention as runtimePolicy.ts),
//    and mountable by bridge/server.ts later.
//
// Mutations through these tools publish real event.* topics on the runtime's message
// bus; the webview's poll_events subscription picks them up and refreshes open views.

import * as http from "http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { resolveFileParams } from "./fileParams";

/** Minimal connection surface the tools use — EngineClient (socket) and
 *  EmbeddedBackend (wasm worker) both satisfy it. */
export interface EngineClientLike {
  readonly isConnected: boolean;
  query(queryId: string, params: Record<string, any>): Promise<any>;
  send(commandId: string, params: Record<string, any>): Promise<{ ok: boolean; data?: any; error?: string }>;
}

export interface OmMcpServerOptions {
  /** The extension's live engine connection; null while the runtime is disconnected. */
  getClient: () => EngineClientLike | null;
  /** Base dir for relative save_workspace / load_workspace paths (workspace folder). */
  resolveFileDir: () => string;
  /** TCP port; 0 = ephemeral (default). */
  port?: number;
  log?: (msg: string) => void;
}

export interface OmMcpServer {
  port: number;
  url: string;
  close: () => void;
}

const QUERY_TOOL_DESC =
  "Run an om-core query against the connected runtime. " +
  "query_id is an om-core query name (e.g. workspace_summary, dimension_list, cube_list, view_list, " +
  "dimension_detail, cube_detail, view_detail, view_row_keys, view_col_keys, view_row_header, " +
  "view_col_header, cell_range, selection_stats, workspace_rules, rule_target_resolve); " +
  "params is the query's parameter object (see om-core lib_command/commands/query.py). " +
  "Returns the query's data payload as JSON text.";

const COMMAND_TOOL_DESC =
  "Run an om-core command against the connected runtime (mutates the live workspace — " +
  "open GUI views refresh automatically). command_id is an om-core command name " +
  "(e.g. create_dimension, create_dimension_item, create_cube, create_view, " +
  "set_cell_hardvalue_by_addr, clear_cell_hardvalue, set_rule, set_rule_anchored, " +
  "delete_rule, run_recalculation, undo, redo); params is the command's parameter object " +
  "(see om-core lib_command). Required-param gotchas: create_dimension needs dim_type " +
  "(\"set\"|\"seq\"); set_rule needs is_anchored (bool) and targets as [[dim_name, item_name]]; " +
  "set_cell_hardvalue_by_addr addr is item ids in dimension order including the '@' channel " +
  "first (e.g. [\"at_value\", month_id, metric_id]); delete_rule uses rule_id only. " +
  "Returns the command's data payload as JSON text.";

function toolError(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true as const };
}
function toolOk(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data ?? null) }] };
}

/** One McpServer per request (stateless transport). Handlers close over getClient/dir. */
function buildMcpServer(opts: OmMcpServerOptions): McpServer {
  const mcp = new McpServer({ name: "om-tools", version: "0.1.0" });

  mcp.tool("om_query", QUERY_TOOL_DESC,
    { query_id: z.string(), params: z.record(z.string(), z.any()).optional() },
    async ({ query_id, params }) => {
      const client = opts.getClient();
      if (!client?.isConnected) return toolError("om-core runtime not connected — run 'OM Core: Start Runtime' or 'OM Core: Reconnect', then retry.");
      try {
        return toolOk(await client.query(query_id, params ?? {}));
      } catch (e: any) {
        return toolError(String(e?.message || e));
      }
    });

  mcp.tool("om_command", COMMAND_TOOL_DESC,
    { command_id: z.string(), params: z.record(z.string(), z.any()).optional() },
    async ({ command_id, params }) => {
      const client = opts.getClient();
      if (!client?.isConnected) return toolError("om-core runtime not connected — run 'OM Core: Start Runtime' or 'OM Core: Reconnect', then retry.");
      try {
        const p = resolveFileParams(command_id, params ?? {}, opts.resolveFileDir());
        const r = await client.send(command_id, p);
        if (!r.ok) return toolError(r.error || `command ${command_id} failed`);
        return toolOk(r.data);
      } catch (e: any) {
        return toolError(String(e?.message || e));
      }
    });

  return mcp;
}

export function startOmMcpServer(opts: OmMcpServerOptions): Promise<OmMcpServer> {
  const log = opts.log ?? (() => {});
  const httpServer = http.createServer((req, res) => {
    if (req.url?.split("?")[0] !== "/mcp" || req.method !== "POST") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    // Fresh server + transport pair per request: an McpServer can only be
    // connected to one transport at a time (upstream lesson, kept verbatim).
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { transport.close().catch(() => {}); });
    buildMcpServer(opts)
      .connect(transport)
      .then(() => transport.handleRequest(req, res))
      .catch((e) => {
        log(`mcp request error: ${e?.message || e}`);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
  });

  const requestedPort = opts.port ?? 0;
  return new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(requestedPort, "127.0.0.1", () => {
      const addr = httpServer.address();
      const port = typeof addr === "object" && addr ? addr.port : requestedPort;
      const url = `http://127.0.0.1:${port}/mcp`;
      log(`MCP server listening on ${url}`);
      resolve({ port, url, close: () => httpServer.close() });
    });
  });
}
