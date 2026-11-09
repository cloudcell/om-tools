import * as vscode from "vscode";
import { EngineClient, TransportEndpoint, parseEndpoint, endpointToString, topicMatches } from "./engineClient";
import { EngineProcess } from "./engineProcess";
import { HostRequest, HostToWebview, AppConfig, PickFileParams } from "../shared/messages";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";

let panel: vscode.WebviewPanel | null = null;
let client: EngineClient | null = null;
let runtime: EngineProcess | null = null;
let currentSessionId: string | null = null;
let statusEmitter: ((s: { status: string; message?: string }) => void) | null = null;
let statusBar: vscode.StatusBarItem | null = null;

function defaultEndpoint(): TransportEndpoint {
  const cfg = vscode.workspace.getConfiguration("omCore");
  const ep = cfg.get<string>("runtimeEndpoint", "");
  if (ep) {
    const r = parseEndpoint(ep);
    if (r.ok) return r.endpoint;
  }
  if (os.platform() === "win32") {
    return { kind: "tcp", host: "127.0.0.1", port: 17391 };
  }
  return { kind: "tcp", host: "127.0.0.1", port: 17391 };
}

function getConfig(): AppConfig {
  const cfg = vscode.workspace.getConfiguration("omCore");
  return {
    showSystemElements: cfg.get<boolean>("showSystemElements", false),
    endpoint: endpointToString(defaultEndpoint()),
    nativeFileDialogs: true,
    defaultDir: defaultDirUri().fsPath,
  };
}

/** Where file dialogs start without a current file: the first workspace folder, else the home folder. */
function defaultDirUri(): vscode.Uri {
  return vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(os.homedir());
}

/** Native Open/Save dialog for a workspace file. The runtime reads and writes the file itself, so the
 *  webview only needs the absolute path (`fsPath`); null when the user cancels. */
async function pickFile(p: PickFileParams): Promise<string | null> {
  const filters = { "OpenM JSON": ["json"], "All Files": ["*"] };
  const current = p.current && path.isAbsolute(p.current) ? p.current : null;
  if (p.mode === "save") {
    const defaultUri = current
      ? vscode.Uri.file(current)
      : vscode.Uri.joinPath(defaultDirUri(), p.defaultName || "New_Model.json");
    const uri = await vscode.window.showSaveDialog({ title: "Save Workspace", saveLabel: "Save", defaultUri, filters });
    return uri ? uri.fsPath : null;
  }
  const uris = await vscode.window.showOpenDialog({
    title: "Open Workspace", openLabel: "Open", canSelectMany: false, canSelectFiles: true, canSelectFolders: false,
    defaultUri: current ? vscode.Uri.file(path.dirname(current)) : defaultDirUri(), filters,
  });
  return uris && uris.length ? uris[0].fsPath : null;
}

async function ensureRuntime(): Promise<TransportEndpoint> {
  const ep = defaultEndpoint();
  const running = await EngineProcess.probe(ep);
  if (!running) {
    const cfg = vscode.workspace.getConfiguration("omCore");
    if (cfg.get<boolean>("autoStartRuntime", true)) {
      sendStatus("starting", `Launching om-core runtime at ${endpointToString(ep)}…`);
      runtime = new EngineProcess({ omCorePath: cfg.get<string>("omCorePath", ""), endpoint: ep });
      await runtime.start();
      sendStatus("ready", `Runtime ready at ${endpointToString(ep)}`);
    } else {
      throw new Error(`No runtime detected at ${endpointToString(ep)} and auto-start is disabled.`);
    }
  }
  return ep;
}

async function connect(): Promise<void> {
  sendStatus("connecting", "Connecting to om-core runtime…");
  const ep = await ensureRuntime();
  if (client) { try { client.close(); } catch {} }
  client = new EngineClient(ep);
  client.on("disconnect", () => {
    sendStatus("disconnected", "Runtime connection lost");
    currentSessionId = null;
  });
  client.on("event", (env) => {
    postToWebview({ type: "event", envelope: env });
  });
  await client.connect();
  const pong = await client.ping();
  if (!pong) throw new Error("runtime did not respond to ping");
  currentSessionId = await client.openSession("repl");
  sendStatus("connected", `Connected · session ${currentSessionId?.slice(0, 8)}`);
}

function sendStatus(status: string, message?: string) {
  if (statusEmitter) statusEmitter({ status, message });
  postToWebview({ type: "status", status: status as any, message });
  updateStatusBar(status, message);
}

function updateStatusBar(status: string, message?: string) {
  if (!statusBar) return;
  const icons: Record<string, string> = {
    connected: "$(circle-filled)",
    connecting: "$(loading~spin)",
    starting: "$(loading~spin)",
    disconnected: "$(circle-outline)",
    error: "$(error)",
    ready: "$(circle-filled)",
  };
  const icon = icons[status] || "$(circle-outline)";
  const text = message ? `${icon} OM Core: ${message}` : `${icon} OM Core`;
  statusBar.text = text;
  statusBar.backgroundColor = status === "error"
    ? new vscode.ThemeColor("statusBarItem.errorBackground")
    : status === "connecting" || status === "starting"
    ? new vscode.ThemeColor("statusBarItem.warningBackground")
    : undefined;
  statusBar.tooltip = `OM Core — ${status}${message ? ": " + message : ""}`;
}

function postToWebview(msg: HostToWebview) {
  if (panel) panel.webview.postMessage(msg);
}

async function handleRequest(req: HostRequest): Promise<HostToWebview> {
  try {
    if (!client && req.method !== "getConfig" && req.method !== "startRuntime" && req.method !== "reconnect") {
      return { type: "response", id: req.id, ok: false, error: "not connected" };
    }
    switch (req.method) {
      case "ping": {
        const ok = await client!.ping();
        return { type: "response", id: req.id, ok, data: { pong: ok } };
      }
      case "openSession": {
        const sid = await client!.openSession(req.params?.client_type || "repl");
        currentSessionId = sid;
        return { type: "response", id: req.id, ok: true, data: { session_id: sid } };
      }
      case "command": {
        const r = await client!.send(req.params!.command_id, req.params!.params || {});
        return { type: "response", id: req.id, ok: r.ok, data: r.data, error: r.error };
      }
      case "query": {
        const data = await client!.query(req.params!.query_id, req.params!.params || {});
        return { type: "response", id: req.id, ok: true, data };
      }
      case "subscribe": {
        const topic = req.params!.topic;
        const cb = (env: any) => postToWebview({ type: "event", envelope: env });
        // One host-side callback per topic: the webview re-subscribes on every (re)load
        // ("Developer: Reload Webviews"); appending would deliver each event N times.
        client!.unsubscribe(topic);
        client!.subscribe(topic, cb);
        return { type: "response", id: req.id, ok: true, data: { topic } };
      }
      case "unsubscribe": {
        client!.unsubscribe(req.params!.topic);
        return { type: "response", id: req.id, ok: true };
      }
      case "getConfig": {
        // The webview asks for config on every (re)load. Status is otherwise pushed only when the
        // host connects, so a reloaded webview would stay "disconnected" with a live connection.
        if (client && currentSessionId) sendStatus("connected", `Connected · session ${currentSessionId.slice(0, 8)}`);
        return { type: "response", id: req.id, ok: true, data: getConfig() };
      }
      case "startRuntime": {
        await ensureRuntime();
        return { type: "response", id: req.id, ok: true, data: { endpoint: endpointToString(defaultEndpoint()) } };
      }
      case "stopRuntime": {
        if (runtime) { await runtime.stop(); runtime = null; }
        if (client) { client.close(); client = null; currentSessionId = null; sendStatus("disconnected", "Runtime stopped"); }
        return { type: "response", id: req.id, ok: true };
      }
      case "reconnect": {
        await connect();
        return { type: "response", id: req.id, ok: true, data: { session_id: currentSessionId } };
      }
      case "pickFile": {
        const p = await pickFile((req.params || {}) as PickFileParams);
        return { type: "response", id: req.id, ok: true, data: { path: p } };
      }
      default:
        return { type: "response", id: req.id, ok: false, error: `unknown method: ${req.method}` };
    }
  } catch (e: any) {
    return { type: "response", id: req.id, ok: false, error: String(e?.message || e) };
  }
}

export function activate(context: vscode.ExtensionContext) {
  // Status bar button — always visible, click to open GUI
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = "omCore.openGui";
  statusBar.text = "$(circle-outline) OM Core";
  statusBar.tooltip = "OM Core — click to open GUI";
  statusBar.show();
  context.subscriptions.push(statusBar);

  context.subscriptions.push(
    vscode.commands.registerCommand("omCore.openGui", () => openGui(context)),
    vscode.commands.registerCommand("omCore.startRuntime", async () => {
      try { await ensureRuntime(); vscode.window.showInformationMessage("OM Core runtime started."); } catch (e: any) { vscode.window.showErrorMessage(`Failed to start runtime: ${e?.message || e}`); }
    }),
    vscode.commands.registerCommand("omCore.stopRuntime", async () => {
      if (runtime) { await runtime.stop(); runtime = null; }
      if (client) { client.close(); client = null; }
      vscode.window.showInformationMessage("OM Core runtime stopped.");
    }),
    vscode.commands.registerCommand("omCore.reconnect", async () => {
      try { await connect(); vscode.window.showInformationMessage("OM Core reconnected."); } catch (e: any) { vscode.window.showErrorMessage(`Reconnect failed: ${e?.message || e}`); }
    }),
  );
}

async function openGui(context: vscode.ExtensionContext) {
  if (panel) { panel.reveal(vscode.ViewColumn.One); return; }
  panel = vscode.window.createWebviewPanel("omCoreGui", "OM Core", vscode.ViewColumn.One, {
    enableScripts: true,
  });
  panel.iconPath = { light: vscode.Uri.file(context.asAbsolutePath("media/icon.svg")), dark: vscode.Uri.file(context.asAbsolutePath("media/icon.svg")) };
  panel.webview.html = getHtml(context, panel.webview);

  panel.webview.onDidReceiveMessage(async (msg: HostRequest) => {
    if (msg.type !== "request") return;
    const res = await handleRequest(msg);
    panel!.webview.postMessage(res);
  });

  panel.onDidDispose(() => {
    panel = null;
    statusEmitter = null;
    if (client) { try { client.close(); } catch {} client = null; }
    // leave runtime running so other clients (TUI) can still use it
  });

  // auto-connect on open
  try {
    await connect();
    panel.webview.postMessage({ type: "config", config: getConfig() } as HostToWebview);
  } catch (e: any) {
    sendStatus("error", `Connection failed: ${e?.message || e}`);
  }
}

function getHtml(context: vscode.ExtensionContext, webview: vscode.Webview): string {
  const webviewJs = webview.asWebviewUri(vscode.Uri.file(context.asAbsolutePath("dist/webview.js")));
  const webviewCss = webview.asWebviewUri(vscode.Uri.file(context.asAbsolutePath("dist/webview.css")));
  const nonce = getNonce();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>OM Core</title>
<link rel="stylesheet" href="${webviewCss}" />
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${webviewJs}"></script>
</body>
</html>`;
}

function getNonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) text += possible.charAt(Math.floor(Math.random() * possible.length));
  return text;
}

export function deactivate() {
  if (client) { client.close(); client = null; }
  if (runtime) { runtime.stop(); runtime = null; }
  panel = null;
}
