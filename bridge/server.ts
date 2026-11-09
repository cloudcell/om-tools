import { WebSocketServer, WebSocket } from "ws";
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { EngineClient, TransportEndpoint, parseEndpoint, endpointToString } from "../src/engineClient";

/** Bridge server — the future browser deployment piece.
 *
 *  Serves the webview bundle over HTTP and bridges a WebSocket to the om-core
 *  runtime socket. Each WS client gets its own EngineClient (session). The
 *  WS message protocol is identical to the extension host <-> webview protocol
 *  (see shared/messages.ts), so the webview's WebSocketTransport works unchanged.
 *
 *  Run: node dist/bridge.js [--endpoint tcp://127.0.0.1:17391] [--port 17392] [--dir <folder>]
 *
 *  A browser has no API that returns a file path, so the webview asks for workspace paths in a text
 *  field (`nativeFileDialogs: false`). The runtime resolves relative paths against its own cwd (the
 *  om-core clone), so the bridge makes them absolute against `--dir` (default: the bridge's cwd).
 */

interface HostRequest { type: "request"; id: string; method: string; params?: Record<string, any> }

function defaultEndpoint(): TransportEndpoint {
  const arg = process.argv.includes("--endpoint") ? process.argv[process.argv.indexOf("--endpoint") + 1] : "";
  if (arg) { const r = parseEndpoint(arg); if (r.ok) return r.endpoint; }
  return { kind: "tcp", host: "127.0.0.1", port: 17391 };
}

const port = process.argv.includes("--port") ? parseInt(process.argv[process.argv.indexOf("--port") + 1], 10) : 17392;
const endpoint = defaultEndpoint();
const distDir = __dirname; // dist/ contains webview.js, webview.css, index.html
const defaultDir = path.resolve(process.argv.includes("--dir") ? process.argv[process.argv.indexOf("--dir") + 1] : process.cwd());
const config = () => ({ showSystemElements: false, endpoint: endpointToString(endpoint), nativeFileDialogs: false, defaultDir });
const FILE_COMMANDS = new Set(["save_workspace", "load_workspace"]);

/** Relative `path` of save_workspace / load_workspace → absolute against defaultDir. */
function resolveFileParams(commandId: string, params: Record<string, any>): Record<string, any> {
  if (!FILE_COMMANDS.has(commandId) || typeof params.path !== "string" || !params.path || path.isAbsolute(params.path)) return params;
  return { ...params, path: path.resolve(defaultDir, params.path) };
}

async function handle(req: HostRequest, client: EngineClient, sessionId: () => string | null, setSession: (s: string) => void, send: (msg: any) => void): Promise<any> {
  const p = req.params || {};
  switch (req.method) {
    case "ping": return { ok: await client.ping(), data: { pong: true } };
    case "openSession": { const sid = await client.openSession(p.client_type || "repl"); setSession(sid); return { ok: true, data: { session_id: sid } }; }
    case "command": { const r = await client.send(p.command_id, resolveFileParams(p.command_id, p.params || {})); return { ok: r.ok, data: r.data, error: r.error }; }
    case "query": { const data = await client.query(p.query_id, p.params || {}); return { ok: true, data }; }
    case "subscribe": { client.subscribe(p.topic, (env) => send({ type: "event", envelope: env })); return { ok: true, data: { topic: p.topic } }; }
    case "unsubscribe": { client.unsubscribe(p.topic); return { ok: true }; }
    case "getConfig": return { ok: true, data: config() };
    case "reconnect": return { ok: true, data: { session_id: sessionId() } };
    case "startRuntime": return { ok: true, data: { endpoint: endpointToString(endpoint) } };
    case "stopRuntime": return { ok: true };
    case "setTitle": return { ok: true }; // the browser tab already shows document.title
    default: return { ok: false, error: `unknown method: ${req.method}` };
  }
}

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";
  const file = path.join(distDir, urlPath);
  if (!file.startsWith(distDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end("not found"); return;
  }
  const exts: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
  res.writeHead(200, { "content-type": exts[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});

const wss = new WebSocketServer({ server });
wss.on("connection", (ws: WebSocket) => {
  const client = new EngineClient(endpoint);
  let sessionId: string | null = null;
  const send = (msg: any) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));
  // The webview sends getConfig and its subscriptions as soon as the socket opens. The message handler is
  // registered right away and each request waits for the runtime connection; registering it after the
  // awaits below dropped those first requests (getConfig never answered → no defaultDir).
  const ready = (async () => {
    try {
      await client.connect();
      sessionId = await client.openSession("repl");
      send({ type: "status", status: "connected", message: `Connected · session ${sessionId.slice(0, 8)}` });
      send({ type: "config", config: config() });
    } catch (e: any) {
      send({ type: "status", status: "error", message: `Connection failed: ${e?.message || e}` });
    }
  })();
  client.on("disconnect", () => send({ type: "status", status: "disconnected", message: "runtime connection lost" }));
  ws.on("message", async (data: any) => {
    let req: HostRequest;
    try { req = JSON.parse(data.toString()); } catch { return; }
    if (req.type !== "request") return;
    await ready;
    try {
      const r = await handle(req, client, () => sessionId, (s) => { sessionId = s; }, send);
      send({ type: "response", id: req.id, ok: r.ok, data: r.data, error: r.error });
    } catch (e: any) {
      send({ type: "response", id: req.id, ok: false, error: String(e?.message || e) });
    }
  });
  ws.on("close", () => { try { client.close(); } catch {} });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`OM Core bridge: http://127.0.0.1:${port}  (webview)  ->  ${endpointToString(endpoint)}  (om-core runtime)`);
});
