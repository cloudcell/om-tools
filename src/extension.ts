import * as vscode from "vscode";
import { EngineClient, TransportEndpoint, parseEndpoint, endpointToString, topicMatches } from "./engineClient";
import { EngineProcess } from "./engineProcess";
import { HostRequest, HostToWebview, AppConfig, PickFileParams, UiState, UI_STATE_META } from "../shared/messages";
import { autoStartBlockedReason, isRemoteEndpoint } from "./runtimePolicy";
import { sanitizeUiState } from "./uiState";
import { StatusSnapshot, describeOmCorePath, findUv, hasVenv, looksLikeOmCore, readGitCommit } from "./engineStatus";
import { StatusPanel } from "./statusPanel";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

let panel: vscode.WebviewPanel | null = null;
let client: EngineClient | null = null;
let runtime: EngineProcess | null = null;
let currentSessionId: string | null = null;
let statusEmitter: ((s: { status: string; message?: string }) => void) | null = null;
let statusBar: vscode.StatusBarItem | null = null;
/** Side panel with the engine state (T-062), and the last status reported to it. */
let statusPanel: StatusPanel | null = null;
let lastStatus: { status: string; message?: string } | null = null;
/** For globalState (saved panel sizes, T-045). Set in activate(). */
let extContext: vscode.ExtensionContext | null = null;
const UI_STATE_KEY = "omCore.uiState";

const DEFAULT_TCP: TransportEndpoint = { kind: "tcp", host: "127.0.0.1", port: 17391 };
let resolvedEndpoint: TransportEndpoint | null = null;

function currentUsername(): string {
  try { return os.userInfo().username; } catch { return process.env.USER || process.env.USERNAME || "user"; }
}

function defaultUnixSocketPath(): string {
  return path.join(os.tmpdir(), `openm-${currentUsername()}.sock`);
}

/** om-core's own default when no endpoint is configured: unix socket on POSIX, TCP on Windows. */
function platformDefaultEndpoint(): TransportEndpoint {
  return os.platform() === "win32" ? DEFAULT_TCP : { kind: "unix", path: defaultUnixSocketPath() };
}

/** Endpoint pinned by explicit configuration only: omCore.runtimeEndpoint, then OPENM_TRANSPORT_* env.
 *  A value that is set but invalid is an error: silently falling back to another runtime (the default port, or a
 *  socket some other program owns) would connect to something the user did not ask for (T-049, DEV-10). */
function configuredEndpointStrict(): TransportEndpoint | null {
  const ep = vscode.workspace.getConfiguration("omCore").get<string>("runtimeEndpoint", "").trim();
  if (ep) {
    const r = parseEndpoint(ep);
    if (!r.ok) throw new Error(`Setting omCore.runtimeEndpoint is not valid (${r.error}): "${ep}". Use unix:///path/to.sock or tcp://host:port, or clear it.`);
    return r.endpoint;
  }
  const sock = process.env.OPENM_TRANSPORT_SOCKET;
  if (sock) return { kind: "unix", path: sock };
  if (process.env.OPENM_TRANSPORT_HOST || process.env.OPENM_TRANSPORT_PORT) {
    const portText = process.env.OPENM_TRANSPORT_PORT;
    const port = portText ? Number(portText) : 17391;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`OPENM_TRANSPORT_PORT is not a valid port: "${portText}".`);
    return { kind: "tcp", host: process.env.OPENM_TRANSPORT_HOST || "127.0.0.1", port };
  }
  return null;
}

/** Same, for display only (status and config pushes): never throws. */
function configuredEndpoint(): TransportEndpoint | null {
  try { return configuredEndpointStrict(); } catch { return null; }
}

/** Where to connect: explicit config/env first; otherwise probe the default unix socket and TCP
 *  port and use whichever answers; if neither is live, the platform default (which auto-start
 *  then binds). */
async function resolveEndpoint(): Promise<TransportEndpoint> {
  const configured = configuredEndpointStrict();
  if (configured) return configured;
  for (const c of autoDetectCandidates()) {
    if (await EngineProcess.probe(c)) return c;
  }
  return platformDefaultEndpoint();
}

/** Where auto-detect looks for a live runtime, in order. */
function autoDetectCandidates(): TransportEndpoint[] {
  const candidates: TransportEndpoint[] = [];
  if (os.platform() !== "win32") candidates.push({ kind: "unix", path: defaultUnixSocketPath() });
  candidates.push(DEFAULT_TCP);
  return candidates;
}

/** Same choice as resolveEndpoint, plus whether a runtime answers there (each endpoint probed once). For the side panel. */
async function findRuntime(): Promise<{ endpoint: TransportEndpoint; running: boolean }> {
  const configured = configuredEndpointStrict();
  if (configured) return { endpoint: configured, running: await EngineProcess.probe(configured) };
  for (const c of autoDetectCandidates()) {
    if (await EngineProcess.probe(c)) return { endpoint: c, running: true };
  }
  return { endpoint: platformDefaultEndpoint(), running: false };
}

/** Sync view of the endpoint for display only (status/config pushes); no probing. */
function defaultEndpoint(): TransportEndpoint {
  return resolvedEndpoint ?? configuredEndpoint() ?? platformDefaultEndpoint();
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

/** Dedupes concurrent first-run prompts (auto-connect + command can both trigger one). */
let omCorePathPrompt: Promise<string> | null = null;

async function pickAndPersistOmCorePath(): Promise<string> {
  try {
    const pick = await vscode.window.showOpenDialog({
      title: "Select the om-core project folder (the checkout containing main.py)",
      openLabel: "Use as om-core path",
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
    });
    const dir = pick?.[0]?.fsPath;
    if (!dir) throw new Error("om-core path is not set. Configure 'omCore.omCorePath' or set OM_CORE_PATH.");
    if (!looksLikeOmCore(dir)) {
      throw new Error(`${dir} does not look like an om-core checkout (expected main.py, lib_runtime/, lib_openm/).`);
    }
    await vscode.workspace.getConfiguration("omCore").update("omCorePath", dir, vscode.ConfigurationTarget.Global);
    return dir;
  } finally {
    omCorePathPrompt = null;
  }
}

const APPROVED_CORE_KEY = "omCore.approvedCorePaths";

/** A workspace folder that merely looks like om-core is not a place the user chose to run code from: ask once per
 *  folder (modal), remember the answer in globalState (T-049, DEV-10). Settings and OM_CORE_PATH are the user's own choice. */
async function approveWorkspaceCore(dir: string): Promise<boolean> {
  const approved = extContext?.globalState.get<string[]>(APPROVED_CORE_KEY, []) ?? [];
  if (approved.includes(dir)) return true;
  const run = "Run om-core from this folder";
  const pick = await vscode.window.showWarningMessage(
    `OM Tools found an om-core checkout in this workspace:\n${dir}\n\nStarting the runtime runs main.py from it on your computer. Continue only if you trust this folder.`,
    { modal: true }, run);
  if (pick !== run) return false;
  await extContext?.globalState.update(APPROVED_CORE_KEY, [...approved, dir]);
  return true;
}

/** Where the runtime lives, for auto-start: omCore.omCorePath > OM_CORE_PATH env > a workspace
 *  folder that is an om-core checkout (after the user approves it) > one-time folder picker (persisted to global settings).
 *  The side panel shows the same choice without asking anything: describeOmCorePath in engineStatus.ts. Keep the two in step. */
async function resolveOmCorePath(): Promise<string> {
  const cfg = vscode.workspace.getConfiguration("omCore");
  const fromSetting = cfg.get<string>("omCorePath", "").trim();
  if (fromSetting && fs.existsSync(fromSetting)) return fromSetting;
  if (fromSetting) vscode.window.showWarningMessage(`omCore.omCorePath does not exist: ${fromSetting} — trying auto-detect.`);

  const fromEnv = (process.env.OM_CORE_PATH || process.env.OPENM_CORE_PATH || "").trim();
  if (fromEnv && looksLikeOmCore(fromEnv)) return fromEnv;

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const dir = folder.uri.fsPath;
    if (!looksLikeOmCore(dir)) continue;
    if (await approveWorkspaceCore(dir)) return dir;
    throw new Error(`Not starting the runtime from ${dir}. To use another om-core, set 'omCore.omCorePath' or start the runtime yourself.`);
  }

  if (!omCorePathPrompt) omCorePathPrompt = pickAndPersistOmCorePath();
  return omCorePathPrompt;
}

/** Remote endpoints already warned about in this session. */
const warnedRemote = new Set<string>();

async function ensureRuntime(): Promise<TransportEndpoint> {
  const ep = await resolveEndpoint();
  resolvedEndpoint = ep;
  if (isRemoteEndpoint(ep) && !warnedRemote.has(endpointToString(ep))) {
    warnedRemote.add(endpointToString(ep));
    vscode.window.showWarningMessage(`OM Tools talks to the runtime at ${endpointToString(ep)} without encryption or authentication. Use this only on a network you trust, or through an SSH tunnel.`);
  }
  const running = await EngineProcess.probe(ep);
  if (!running) {
    const cfg = vscode.workspace.getConfiguration("omCore");
    if (cfg.get<boolean>("autoStartRuntime", true)) {
      // Starting the runtime executes code (uv run python main.py): not in Restricted Mode (Workspace Trust).
      const blocked = autoStartBlockedReason(vscode.workspace.isTrusted);
      if (blocked) throw new Error(blocked);
      const omCorePath = await resolveOmCorePath();
      sendStatus("starting", `Launching om-core runtime at ${endpointToString(ep)}…`);
      runtime = new EngineProcess({ omCorePath, endpoint: ep });
      try {
        await runtime.start();
      } catch (e: any) {
        // Otherwise the last status stays "starting" and the side panel keeps showing "Starting…".
        sendStatus("error", `Failed to start runtime: ${e?.message || e}`);
        throw e;
      }
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
  const thisClient = client;
  client.on("disconnect", () => {
    sendStatus("disconnected", thisClient.lastError ? `Runtime connection closed: ${thisClient.lastError}` : "Runtime connection lost");
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
  lastStatus = { status, message };
  void statusPanel?.refresh();
}

/** Where omCore.omCorePath comes from, for display. */
function omCorePathScope(cfg: vscode.WorkspaceConfiguration, value: string): string | null {
  if (!value) return null;
  const i = typeof cfg.inspect === "function" ? cfg.inspect<string>("omCorePath") : undefined;
  if (!i) return null;
  if (value === i.workspaceFolderValue) return "Folder settings";
  if (value === i.workspaceValue) return "Workspace settings";
  if (value === i.globalValue) return "User settings";
  return null;
}

/** Everything the side panel shows. Only looks: no dialogs, no warnings, nothing started. */
async function statusSnapshot(): Promise<StatusSnapshot> {
  const cfg = vscode.workspace.getConfiguration("omCore");
  const setting = cfg.get<string>("omCorePath", "") || "";
  const corePath = describeOmCorePath({
    setting,
    settingScope: omCorePathScope(cfg, setting.trim()),
    env: process.env.OM_CORE_PATH || process.env.OPENM_CORE_PATH || "",
    workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
    approvedFolders: extContext?.globalState.get<string[]>(APPROVED_CORE_KEY, []) ?? [],
  });
  const usable = corePath.path && corePath.missingParts.length === 0 ? corePath.path : null;

  let endpoint: string | null = null, endpointError: string | null = null, running = false, startedByUs = false;
  try {
    const r = await findRuntime();
    endpoint = endpointToString(r.endpoint);
    running = r.running;
    startedByUs = running && !!runtime?.isRunning && endpointToString(runtime.endpoint) === endpoint;
  } catch (e: any) {
    endpointError = String(e?.message || e);
  }

  return {
    trusted: vscode.workspace.isTrusted,
    autoStart: cfg.get<boolean>("autoStartRuntime", true),
    runtime: { endpoint, endpointError, running, startedByUs },
    gui: { open: !!panel, connected: !!client?.isConnected, session: currentSessionId },
    lastStatus,
    corePath,
    venv: usable ? hasVenv(usable) : null,
    commit: usable ? readGitCommit(usable) : null,
    uv: findUv(),
  };
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
    if (!client && !["getConfig", "startRuntime", "reconnect", "setTitle", "saveUiState"].includes(req.method)) {
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
        const ep = await ensureRuntime();
        return { type: "response", id: req.id, ok: true, data: { endpoint: endpointToString(ep) } };
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
      case "setTitle": {
        // document.title inside a webview does not reach the editor tab
        if (panel && typeof req.params?.title === "string") panel.title = req.params.title;
        return { type: "response", id: req.id, ok: true };
      }
      case "saveUiState": {
        // Panel sizes (T-045): kept across VS Code restarts, handed to the next webview in getHtml().
        // The webview is the less trusted side: keep only known fields with sane values (T-049, DEV-16).
        const state = sanitizeUiState(req.params?.state);
        if (extContext && state) await extContext.globalState.update(UI_STATE_KEY, state);
        return { type: "response", id: req.id, ok: true };
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
  extContext = context;
  // Status bar button — always visible, click to open GUI
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = "omCore.openGui";
  statusBar.text = "$(circle-outline) OM Core";
  statusBar.tooltip = "OM Core — click to open GUI";
  statusBar.show();
  context.subscriptions.push(statusBar);

  statusPanel = new StatusPanel("omCore.launchPad", statusSnapshot);
  const refreshPanel = () => { void statusPanel?.refresh(); };

  context.subscriptions.push(
    statusPanel,
    vscode.commands.registerCommand("omCore.openGui", () => openGui(context)),
    vscode.commands.registerCommand("omCore.startRuntime", async () => {
      try { await ensureRuntime(); vscode.window.showInformationMessage("OM Core runtime started."); } catch (e: any) { vscode.window.showErrorMessage(`Failed to start runtime: ${e?.message || e}`); }
      refreshPanel();
    }),
    vscode.commands.registerCommand("omCore.stopRuntime", async () => {
      // Only a runtime this extension started can be stopped; another one (Qt GUI, a terminal) is only disconnected from.
      // `runtime` stays set after a failed start (to stop a process that did not get ready in time), so ask whether it runs.
      const ours = !!runtime?.isRunning;
      if (runtime) { await runtime.stop(); runtime = null; }
      if (client) { client.close(); client = null; currentSessionId = null; }
      sendStatus("disconnected", ours ? "Runtime stopped" : "Disconnected");
      vscode.window.showInformationMessage(ours
        ? "OM Core runtime stopped."
        : "OM Tools did not start the running om-core runtime, so it was not stopped; the GUI is disconnected from it.");
    }),
    vscode.commands.registerCommand("omCore.reconnect", async () => {
      try { await connect(); vscode.window.showInformationMessage("OM Core reconnected."); } catch (e: any) { vscode.window.showErrorMessage(`Reconnect failed: ${e?.message || e}`); }
      refreshPanel();
    }),
    vscode.commands.registerCommand("omCore.refreshStatus", () => statusPanel?.refresh()),
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration("omCore")) refreshPanel(); }),
    vscode.workspace.onDidGrantWorkspaceTrust(refreshPanel),
    vscode.workspace.onDidChangeWorkspaceFolders(refreshPanel),
  );
}

async function openGui(context: vscode.ExtensionContext) {
  if (panel) { panel.reveal(vscode.ViewColumn.One); return; }
  panel = vscode.window.createWebviewPanel("omCoreGui", "OM Core", vscode.ViewColumn.One, {
    enableScripts: true,
    // Only the bundle may be loaded from disk, not the whole extension folder or the workspace (default roots).
    localResourceRoots: [vscode.Uri.file(context.asAbsolutePath("dist")), vscode.Uri.file(context.asAbsolutePath("media"))],
    // Keep the page alive while another editor tab is in front. Without it VS Code destroys the hidden webview
    // and rebuilds it on return, which drops the open view tabs and the grid state (issue #6).
    retainContextWhenHidden: true,
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
    currentSessionId = null;
    lastStatus = null;
    void statusPanel?.refresh();
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
  // Saved panel sizes, read by the webview before its first render (VsCodeTransport.loadUiState).
  // encodeURIComponent leaves no quotes or angle brackets, so it is safe inside the attribute.
  const uiState = sanitizeUiState(context.globalState.get<UiState>(UI_STATE_KEY));
  const uiStateMeta = uiState ? `<meta name="${UI_STATE_META}" content="${encodeURIComponent(JSON.stringify(uiState))}" />\n` : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
${uiStateMeta}<title>OM Core</title>
<link rel="stylesheet" href="${webviewCss}" />
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${webviewJs}"></script>
</body>
</html>`;
}

/** CSP script nonce: 144 random bits from the OS generator (18 bytes: base64 without padding). */
function getNonce(): string {
  return crypto.randomBytes(18).toString("base64");
}

export function deactivate() {
  if (client) { client.close(); client = null; }
  if (runtime) { runtime.stop(); runtime = null; }
  panel = null;
}
