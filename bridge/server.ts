import { WebSocketServer, WebSocket } from "ws";
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { execFile, spawnSync } from "child_process";
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
 *  A browser has no API that returns a file path, so the bridge shows the platform's
 *  native file chooser itself (`pickFile` → zenity/kdialog/osascript/PowerShell) and
 *  returns the picked absolute path to the runtime, which reads/writes the file.
 *  If no chooser is available (headless), it advertises `serverFileBrowse` and the
 *  webview falls back to an `fsList`-backed dialog. Relative paths resolve against
 *  `--dir` (default: the bridge's cwd).
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

/** Native file chooser. A browser can't show an OS dialog for paths, but the bridge
 *  is a local process: it spawns the platform chooser (zenity/kdialog/osascript/
 *  PowerShell) and returns the picked path. Falls back to `serverFileBrowse` when
 *  no chooser exists (e.g. headless host). */
type PickerMode = "open" | "save";
interface NativePicker { cmd: string; args: (mode: PickerMode, start: string, title: string) => string[] }

const PICKERS: Record<string, NativePicker> = {
  zenity: {
    cmd: "zenity",
    args: (mode, start, title) => [
      "--file-selection", `--title=${title}`, `--filename=${start}`,
      "--file-filter=Workspace files (*.json) | *.json",
      ...(mode === "save" ? ["--save", "--confirm-overwrite"] : []),
    ],
  },
  kdialog: {
    cmd: "kdialog",
    args: (mode, start, title) => [
      mode === "save" ? "--getsavefilename" : "--getopenfilename", start, "Workspace files (*.json)",
      "--title", title,
    ],
  },
  osascript: {
    cmd: "osascript",
    args: (mode, start, title) => [
      "-e", mode === "save"
        ? `POSIX path of (choose file name with prompt "${title}" default location POSIX file "${start}")`
        : `POSIX path of (choose file with prompt "${title}" default location POSIX file "${start}")`,
    ],
  },
  powershell: {
    cmd: "powershell",
    args: (mode, start, title) => [
      "-NoProfile", "-Command",
      `Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.${mode === "save" ? "Save" : "Open"}FileDialog; ` +
      `$d.Title = '${title}'; $d.Filter = 'Workspace files (*.json)|*.json'; $d.InitialDirectory = '${path.dirname(start)}'; ` +
      (mode === "save" ? `$d.FileName = '${path.basename(start)}'; ` : "") +
      `if ($d.ShowDialog() -eq 'OK') { $d.FileName }`,
    ],
  },
};

function detectPicker(): NativePicker | null {
  if (process.platform === "darwin") return PICKERS.osascript;
  if (process.platform === "win32") return PICKERS.powershell;
  for (const name of ["zenity", "kdialog"]) {
    if (spawnSync(name, ["--version"], { stdio: "ignore" }).status === 0) return PICKERS[name];
  }
  return null;
}

const picker = detectPicker();

function runPicker(mode: PickerMode, start: string, title: string): Promise<string | null> {
  return new Promise((resolve) => {
    if (!picker) { resolve(null); return; }
    execFile(picker.cmd, picker.args(mode, start, title), { timeout: 120000 }, (err, stdout) => {
      resolve(err ? null : stdout.trim() || null);
    });
  });
}

const config = () => ({ showSystemElements: false, endpoint: endpointToString(endpoint), nativeFileDialogs: !!picker, serverFileBrowse: !picker, defaultDir });
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
    case "pickFile": {
      if (!picker) return { ok: false, error: "no native file dialog available" };
      const mode: PickerMode = p.mode === "save" ? "save" : "open";
      const start = typeof p.current === "string" && p.current
        ? p.current
        : path.join(defaultDir, mode === "save" && typeof p.defaultName === "string" ? p.defaultName : "");
      const title = mode === "save" ? "Save Workspace" : "Open Workspace";
      return { ok: true, data: { path: await runPicker(mode, start, title) } };
    }
    case "fsList": {
      const dir = typeof p.dir === "string" && p.dir ? path.resolve(p.dir) : defaultDir;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const names = (e: fs.Dirent) => !e.name.startsWith(".");
      const dirs = entries.filter((e) => e.isDirectory() && names(e)).map((e) => e.name).sort();
      const files = entries.filter((e) => e.isFile() && names(e)).map((e) => e.name).sort();
      const parent = path.dirname(dir);
      return { ok: true, data: { dir, parent: parent === dir ? null : parent, dirs, files } };
    }
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
