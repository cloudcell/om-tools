import * as vscode from "vscode";
import { EngineClient, TransportEndpoint, parseEndpoint, endpointToString, topicMatches } from "./engineClient";
import { EngineProcess } from "./engineProcess";
import { HostRequest, HostToWebview, AppConfig, PickFileParams, UiState, UI_STATE_META, FEEDBACK_URL, LINK_URLS } from "../shared/messages";
import { autoStartBlockedReason, isRemoteEndpoint } from "./runtimePolicy";
import { sanitizeUiState } from "./uiState";
import { GUI_BUTTON_KEY, RUNTIME_BUTTON_KEY, StatusSnapshot, UV_INSTALL_URL, buttonStates, describeOmCorePath, findUv, hasVenv, looksLikeOmCore, missingOmCoreParts, readGitCommit } from "./engineStatus";
import { StatusPanel } from "./statusPanel";
import { OmMcpServer, startOmMcpServer } from "./mcpServer";
import { EmbeddedBackend, resolveTsRuntime } from "./backend";
import { EXAMPLE_SCHEME, resolveExampleRef, type ExampleCatalog } from "./fileParams";
import catalogData from "../shared/catalog.json";
import { isZip, readBundle } from "../shared/omz";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

let panel: vscode.WebviewPanel | null = null;
let client: EngineClient | null = null;
/** Embedded engine backend (wasm worker) — mutually exclusive with `client`. */
let embedded: EmbeddedBackend | null = null;
let runtime: EngineProcess | null = null;
let currentSessionId: string | null = null;
let statusEmitter: ((s: { status: string; message?: string }) => void) | null = null;
let statusBar: vscode.StatusBarItem | null = null;
/** Side panel with the engine state (T-062), and the last status reported to it. */
let statusPanel: StatusPanel | null = null;
let lastStatus: { status: string; message?: string } | null = null;
/** For globalState (saved panel sizes, T-045). Set in activate(). */
let extContext: vscode.ExtensionContext | null = null;
/** When the extension activated — the webview startup race guard below needs it. */
let activatedAt = 0;
/** VS Code cannot register a webview's service worker while the workbench is
 *  still starting — the panel dies with "Failed to register a ServiceWorker:
 *  The document is in an invalid state" (upstream microsoft/vscode#125993).
 *  Open GUI invoked right after activation waits out this settle window. */
const WEBVIEW_STARTUP_SETTLE_MS = 2000;
const UI_STATE_KEY = "omCore.uiState";

/** "<version>+<git describe>" stamped by scripts/build.mjs; "dev" for watch builds. */
declare const OM_TOOLS_BUILD: string | undefined;
const BUILD_INFO: string = typeof OM_TOOLS_BUILD === "undefined" ? "dev" : OM_TOOLS_BUILD;

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

// ── engine mode: socket runtime vs embedded wasm ──────────────────────────
// omCore.engineMode: "auto" (default) | "embedded" | "socket".
//   auto: explicit runtimeEndpoint or OPENM_TRANSPORT_* → socket; otherwise
//         embedded. No /tmp/openm-*.sock probing in auto — silently
//         connecting to someone else's runtime is the DEV-10 failure.
type EngineMode = "auto" | "embedded" | "socket";
function engineMode(): EngineMode {
  const m = vscode.workspace.getConfiguration("omCore").get<string>("engineMode", "auto");
  return m === "embedded" || m === "socket" ? m : "auto";
}
function useEmbedded(): boolean {
  const m = engineMode();
  if (m === "embedded") return true;
  if (m === "socket") return false;
  return !configuredEndpoint();
}
/** The live connection, whichever backend owns it. handleRequest works on
 *  this union: EngineClient (socket) and EmbeddedBackend share the same
 *  send/query/subscribe/openSession/ping/close surface. */
function activeConn(): EngineClient | EmbeddedBackend | null {
  return embedded ?? client;
}

/** Where auto-detect looks for a live runtime, in order. */
function autoDetectCandidates(): TransportEndpoint[] {
  const candidates: TransportEndpoint[] = [];
  if (os.platform() !== "win32") candidates.push({ kind: "unix", path: defaultUnixSocketPath() });
  candidates.push(DEFAULT_TCP);
  return candidates;
}

/** Where the runtime is and whether it answers there (each endpoint probed once). Explicit config/env first (an invalid
 *  one throws: silently using another runtime would connect to something the user did not ask for); otherwise the default
 *  unix socket and TCP port, whichever answers; if neither is live, the platform default, where Start Runtime binds. */
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
    endpoint: useEmbedded() ? "wasm://embedded" : endpointToString(defaultEndpoint()),
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
  const filters = { "OpenM JSON": ["json"], "OM Bundle": ["omz"], "All Files": ["*"] };
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

/** Folder dialog for the om-core checkout: the chosen folder, null when cancelled; throws when it is not om-core. */
async function pickOmCoreFolder(): Promise<string | null> {
  const current = vscode.workspace.getConfiguration("omCore").get<string>("omCorePath", "").trim();
  const pick = await vscode.window.showOpenDialog({
    title: "Select the om-core project folder (the checkout containing main.py)",
    openLabel: "Use as om-core path",
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    defaultUri: current && fs.existsSync(current) ? vscode.Uri.file(current) : undefined,
  });
  const dir = pick?.[0]?.fsPath;
  if (!dir) return null;
  const missing = missingOmCoreParts(dir);
  if (missing.length) {
    throw new Error(`${dir} does not look like an om-core checkout (missing ${missing.join(", ")}). Choose the folder that contains main.py.`);
  }
  return dir;
}

/** Start Runtime reached the end of the resolution chain: explain, then ask for a folder. */
async function pickAndPersistOmCorePath(): Promise<string> {
  try {
    const choose = "Choose om-core folder…";
    const pick = await vscode.window.showWarningMessage(
      "No om-core engine found. Starting the Python runtime needs an om-core checkout — choose its folder, or switch to the bundled engine (omCore.engineMode: embedded).",
      { modal: true }, choose);
    if (pick !== choose) throw new Error("om-core path is not set. Set 'omCore.omCorePath' or OM_CORE_PATH.");
    const dir = await pickOmCoreFolder();
    if (dir) {
      await vscode.workspace.getConfiguration("omCore").update("omCorePath", dir, vscode.ConfigurationTarget.Global);
      return dir;
    }
    throw new Error("om-core path is not set. Set 'omCore.omCorePath' or OM_CORE_PATH.");
  } finally {
    omCorePathPrompt = null;
  }
}

/** The extension's output channel (engine/MCP logs). */
let engineOutput: vscode.OutputChannel | null = null;
function outputChannel(): vscode.OutputChannel {
  if (!engineOutput) engineOutput = vscode.window.createOutputChannel("OM Core");
  return engineOutput;
}

/** Side panel button "Choose om-core Folder…": saves to User settings and says when that does not take effect. */
async function chooseOmCorePath(): Promise<void> {
  let dir: string | null;
  try { dir = await pickOmCoreFolder(); } catch (e: any) { vscode.window.showErrorMessage(String(e?.message || e)); return; }
  if (!dir) return;
  await vscode.workspace.getConfiguration("omCore").update("omCorePath", dir, vscode.ConfigurationTarget.Global);
  // Workspace settings win over User settings: then the new value is saved but not used here.
  const effective = vscode.workspace.getConfiguration("omCore").get<string>("omCorePath", "").trim();
  if (effective !== dir) {
    const open = "Open Workspace Settings";
    const pick = await vscode.window.showWarningMessage(
      `Saved to User settings, but this workspace sets omCore.omCorePath to ${effective || "an empty value"}, which takes precedence here.`, open);
    if (pick === open) await vscode.commands.executeCommand("workbench.action.openWorkspaceSettings", "omCore.omCorePath");
  } else if (runtime?.isRunning && path.resolve(runtime.omCorePath) !== path.resolve(dir)) {
    vscode.window.showInformationMessage(`The running runtime still uses ${runtime.omCorePath}. Stop it and start it again to use the new folder.`);
  }
  void statusPanel?.refresh();
}

/** The om-core folder the runtime would start from, as the side panel shows it. */
function currentCorePath(): ReturnType<typeof describeOmCorePath> {
  const cfg = vscode.workspace.getConfiguration("omCore");
  const setting = cfg.get<string>("omCorePath", "") || "";
  return describeOmCorePath({
    setting,
    settingScope: omCorePathScope(cfg, setting.trim()),
    env: process.env.OM_CORE_PATH || process.env.OPENM_CORE_PATH || "",

    workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
    approvedFolders: extContext?.globalState.get<string[]>(APPROVED_CORE_KEY, []) ?? [],
  });
}

/** Which setting a panel row's gear opens. */
function settingForRow(row: unknown): string {
  const id = (row as { id?: unknown } | undefined)?.id;
  return id === "path" ? "omCore.omCorePath" : id === "runtime" ? "omCore.runtimeEndpoint" : "omCore";
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

/** Where the runtime lives, for auto-start: omCore.omCorePath > OM_CORE_PATH env > a workspace folder that is an
 *  om-core checkout (after the user approves it) > a folder-pick prompt (pick persisted to global settings).
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

/** Runs in flight. Two clicks (Start Runtime twice) used to launch two `uv run` processes: the second could not take
 *  the port, replaced `runtime`, and the first was lost without a way to stop it. A second caller now waits for the
 *  first and gets its result. Same for connecting. */
let startingRuntime: Promise<TransportEndpoint> | null = null;
let connecting: Promise<void> | null = null;
/** A runtime process is being launched right now (for the "Starting…" state). */
let launching = false;
/** The next connect() reaches a runtime that is not the one the GUI page was showing: this extension launched a new
 *  one, or stopped the old one. The page then drops what it shows (tabs, file name, "unsaved") like after File → New.
 *  A runtime restarted by somebody else is not noticed (the extension cannot tell it from the old one). */
let runtimeReplaced = false;

// ── MCP server (Streamable HTTP at 127.0.0.1:<port>/mcp) ──────────────────
// Independent of the runtime connection: the listener lifecycle follows
// omCore.mcp.enabled / mcp.port so the URL is stable across runtime restarts;
// tools report "not connected" while client is null. Registered with VS Code's
// lm API when present (≥ ~1.102); otherwise the URL is used manually.
let mcpServer: OmMcpServer | null = null;
const mcpDefChange = new vscode.EventEmitter<void>();

async function restartMcpServer(): Promise<void> {
  if (mcpServer) { try { mcpServer.close(); } catch {} mcpServer = null; }
  const cfg = vscode.workspace.getConfiguration("omCore");
  if (cfg.get<boolean>("mcp.enabled", true)) {
    try {
      mcpServer = await startOmMcpServer({
        // Embedded mode can spawn the engine on first use — there is no
        // external runtime to wait for. Socket mode stays explicit: we
        // never auto-start a user's runtime from an agent call.
        getConn: async () => {
          if (useEmbedded() && !activeConn()?.isConnected) {
            try { await connect(); } catch { /* report via null below */ }
          }
          return activeConn();
        },
        resolveFileDir: () => defaultDirUri().fsPath,
        port: cfg.get<number>("mcp.port", 0),
        log: (m) => outputChannel().appendLine(`[mcp] ${m}`),
      });
    } catch (e: any) {
      outputChannel().appendLine(`[mcp] server failed to start: ${e?.message || e}`);
    }
  }
  mcpDefChange.fire();
}

/** Register the MCP server definition provider when the host has the lm API. */
function registerMcpProvider(context: vscode.ExtensionContext): void {
  const lm: any = (vscode as any).lm;
  const Def: any = (vscode as any).McpHttpServerDefinition;
  if (typeof lm?.registerMcpServerDefinitionProvider !== "function" || typeof Def !== "function") return;
  context.subscriptions.push(lm.registerMcpServerDefinitionProvider("omCore", {
    onDidChangeMcpServerDefinitions: mcpDefChange.event,
    provideMcpServerDefinitions: () =>
      mcpServer ? [new Def("OM Core", vscode.Uri.parse(mcpServer.url))] : [],
  }));
}

/** Nothing answers where the GUI would connect. Not a failure: the way out is the Start Runtime button. */
class RuntimeNotRunningError extends Error {}

/** What the GUI page shows under its menu bar while it is not connected (the page cannot know it is inside VS Code). */
const DISCONNECTED_HINT = "In the OM Core side panel: press Start Runtime (this tab connects by itself), or Reconnect if the runtime is already running.";

function warnIfRemote(ep: TransportEndpoint): void {
  if (!isRemoteEndpoint(ep) || warnedRemote.has(endpointToString(ep))) return;
  warnedRemote.add(endpointToString(ep));
  vscode.window.showWarningMessage(`OM Tools talks to the runtime at ${endpointToString(ep)} without encryption or authentication. Use this only on a network you trust, or through an SSH tunnel.`);
}

/** Where the GUI connects: a runtime that answers. Never starts anything: Open GUI and Reconnect only connect,
 *  starting the engine is the Start Runtime button's job (the two buttons are independent). */
async function findRuntimeEndpoint(): Promise<TransportEndpoint> {
  const r = await findRuntime();
  resolvedEndpoint = r.endpoint;
  warnIfRemote(r.endpoint);
  if (!r.running) throw new RuntimeNotRunningError(`No om-core runtime is running at ${endpointToString(r.endpoint)}. Press Start Runtime in the OM Core side panel.`);
  return r.endpoint;
}

/** Start Runtime: launches the runtime process unless one already answers. One launch at a time. */
function startRuntimeProcess(): Promise<TransportEndpoint> {
  if (!startingRuntime) startingRuntime = launchRuntime().finally(() => { startingRuntime = null; void statusPanel?.refresh(); });
  return startingRuntime;
}

async function launchRuntime(): Promise<TransportEndpoint> {
  const r = await findRuntime();
  const ep = r.endpoint;
  resolvedEndpoint = ep;
  warnIfRemote(ep);
  if (r.running) return ep;       // already answering (somebody else's, or ours from earlier): nothing to start
  if (isRemoteEndpoint(ep)) {
    throw new Error(`${endpointToString(ep)} is on another computer, and OM Tools can only start a runtime on this one. Start it there, or clear omCore.runtimeEndpoint.`);
  }
  // Starting the runtime executes code (uv run python main.py): not in Restricted Mode (Workspace Trust).
  const blocked = autoStartBlockedReason(vscode.workspace.isTrusted);
  if (blocked) throw new Error(blocked);
  const omCorePath = await resolveOmCorePath();
  launching = true;
  sendStatus("starting", `Launching om-core runtime at ${endpointToString(ep)}…`);
  runtime = new EngineProcess({ omCorePath, endpoint: ep });
  try {
    await runtime.start();
    runtimeReplaced = true;
  } catch (e: any) {
    // Otherwise the last status stays "starting" and the side panel keeps showing "Starting…".
    launching = false;
    sendStatus("error", `Failed to start runtime: ${e?.message || e}`);
    throw e;
  }
  launching = false;
  sendStatus("ready", `Runtime ready at ${endpointToString(ep)}`);
  return ep;
}

function connect(): Promise<void> {
  if (!connecting) {
    connecting = openConnection()
      .catch((e: any) => {
        // Otherwise the last status stays "connecting": a failure before the connection is made never reports one.
        if (lastStatus?.status === "connecting") {
          // A failure that came before the old connection was touched leaves that connection working: say so.
          if (activeConn()?.isConnected && currentSessionId) sendStatus("connected", `Connected · session ${currentSessionId.slice(0, 8)}`);
          else if (e instanceof RuntimeNotRunningError) sendStatus("disconnected", "Runtime is not running", { hint: DISCONNECTED_HINT });
          else sendStatus("error", `Connection failed: ${e?.message || e}`);
        }
        throw e;
      })
      .finally(() => { connecting = null; void statusPanel?.refresh(); });
  }
  return connecting;
}

async function openConnection(): Promise<void> {
  sendStatus("connecting", "Connecting to om-core runtime…");
  if (useEmbedded()) {
    // Embedded wasm engine in a worker thread. A respawn loses the
    // in-memory workspace — signal freshRuntime so the webview reloads.
    const isRespawn = !!embedded;
    if (embedded) { try { await embedded.dispose(); } catch {} embedded = null; }
    const cfg = vscode.workspace.getConfiguration("omCore");
    // Restricted Mode: an external ts_runtime path is arbitrary Node code —
    // ignore it when untrusted and fall back to the bundled dist/ copy.
    const runtimeDir = vscode.workspace.isTrusted
      ? (cfg.get<string>("tsRuntimePath") || process.env.OM_TS_RUNTIME_DIR || null)
      : null;
    const tsPaths = resolveTsRuntime(extContext!.extensionPath, runtimeDir);
    const eb = new EmbeddedBackend({
      ...tsPaths,
      stateBytes: cfg.get<number>("engineStateBytes") || undefined,
      scratchBytes: cfg.get<number>("engineScratchBytes") || undefined,
    });
    eb.onWorkerExit = (code) => {
      // Keep `embedded`: the backend respawns on next request (freshRuntime
      // surfaces to the webview). Nulling it would strand the GUI with a
      // dead conn and no recovery path.
      if (embedded === eb) currentSessionId = null;
      sendStatus("error", `Embedded engine stopped (code ${code}) — unsaved workspace was lost. It respawns on next action or Start Runtime.`);
    };
    eb.onRespawn = () => {
      currentSessionId = eb.session;
      runtimeReplaced = false;
      sendStatus("connected", "Embedded engine restarted — workspace is fresh", { freshRuntime: true });
    };
    eb.onAnyEvent = (env) => postToWebview({ type: "event", envelope: env });
    await eb.connect();
    embedded = eb;
    currentSessionId = await eb.openSession("repl");
    const freshRuntime = runtimeReplaced || isRespawn;
    runtimeReplaced = false;
    sendStatus("connected", `Connected · embedded engine (session ${currentSessionId.slice(0, 13)})`, { freshRuntime });
    return;
  }
  const ep = await findRuntimeEndpoint();
  if (client) { try { client.close(); } catch {} }
  if (embedded) { try { await embedded.dispose(); } catch {} embedded = null; }
  client = new EngineClient(ep);
  const thisClient = client;
  client.on("disconnect", () => {
    sendStatus("disconnected", thisClient.lastError ? `Runtime connection closed: ${thisClient.lastError}` : "Runtime connection lost", { hint: DISCONNECTED_HINT });
    currentSessionId = null;
  });
  client.on("event", (env) => {
    postToWebview({ type: "event", envelope: env });
  });
  await client.connect();
  const pong = await client.ping();
  if (!pong) throw new Error("runtime did not respond to ping");
  currentSessionId = await client.openSession("repl");
  const freshRuntime = runtimeReplaced;
  runtimeReplaced = false;
  sendStatus("connected", `Connected · session ${currentSessionId?.slice(0, 8)}`, { freshRuntime });
}

function sendStatus(status: string, message?: string, extra: { freshRuntime?: boolean; hint?: string } = {}) {
  if (statusEmitter) statusEmitter({ status, message });
  postToWebview({ type: "status", status: status as any, message, ...(extra.freshRuntime ? { freshRuntime: true } : {}), ...(extra.hint ? { hint: extra.hint } : {}) });
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
  const gui = { open: !!panel, connected: !!activeConn()?.isConnected, connecting: connecting !== null, session: currentSessionId };
  if (useEmbedded()) {
    // Embedded mode has no external runtime to probe — the worker IS the
    // runtime, and it is always ours. Skip every socket/fs probe: there is
    // no om-core checkout, no venv, no uv to validate.
    return {
      trusted: vscode.workspace.isTrusted,
      mode: "embedded",
      runtime: { endpoint: "wasm://embedded", endpointError: null, running: !!embedded, startedByUs: !!embedded, starting: connecting !== null },
      gui, lastStatus,
      corePath: { source: "none", path: null, settingScope: null, missingParts: [], needsApproval: false, ignored: [] },
      venv: null, commit: null, uv: { onPath: null, elsewhere: null },
    };
  }
  const corePath = currentCorePath();
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
    mode: "socket",
    runtime: { endpoint, endpointError, running, startedByUs, starting: launching },
    gui, lastStatus,
    corePath,
    venv: usable ? hasVenv(usable) : null,
    commit: usable ? readGitCommit(usable) : null,
    uv: findUv(),
  };
}

/** Tells the Actions section which buttons to show (`when` clauses of its viewsWelcome entries in package.json). */
function applyButtonContext(s: StatusSnapshot): void {
  const b = buttonStates(s);
  void vscode.commands.executeCommand("setContext", RUNTIME_BUTTON_KEY, b.runtime);
  void vscode.commands.executeCommand("setContext", GUI_BUTTON_KEY, b.gui);
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
  statusBar.tooltip = `OM Core ${BUILD_INFO} — ${status}${message ? ": " + message : ""}`;
}

function postToWebview(msg: HostToWebview) {
  if (panel) panel.webview.postMessage(msg);
}

async function handleRequest(req: HostRequest): Promise<HostToWebview> {
  try {
    const conn = activeConn();
    if (!conn && !["getConfig", "startRuntime", "reconnect", "setTitle", "saveUiState", "openFeedback", "openExternal", "readTextFile", "saveTextFile"].includes(req.method)) {
      return { type: "response", id: req.id, ok: false, error: "not connected" };
    }
    switch (req.method) {
      case "ping": {
        const ok = await conn!.ping();
        return { type: "response", id: req.id, ok, data: { pong: ok } };
      }
      case "openSession": {
        const sid = await conn!.openSession(req.params?.client_type || "repl");
        currentSessionId = sid;
        return { type: "response", id: req.id, ok: true, data: { session_id: sid } };
      }
      case "command": {
        let params = req.params!.params || {};
        // `om-example:<id>` → absolute path into dist/examples/, resolved here so the command
        // rides the normal load path for every backend (embedded reads it via the worker
        // hook; the socket-mode Python engine reads the same absolute path).
        if (req.params!.command_id === "load_workspace" && typeof params.path === "string" && params.path.startsWith(EXAMPLE_SCHEME)) {
          try {
            params = { ...params, path: resolveExampleRef(params.path, catalogData as ExampleCatalog, path.join(extContext?.extensionPath ?? "", "dist", "examples")) };
          } catch (e: any) {
            return { type: "response", id: req.id, ok: false, error: e?.message || String(e) };
          }
        }
        // `.omz` bundle → the model member is extracted to a temp file so every engine
        // (socket or embedded) rides the plain load path. The session member stays
        // inside the file — engines ignore it the way a link would be. A non-zip file
        // merely named .omz falls through to the plain path (same tolerance as web).
        if (req.params!.command_id === "load_workspace" && typeof params.path === "string" && /\.omz$/i.test(params.path)) {
          try {
            const raw = await fs.promises.readFile(params.path);
            if (isZip(raw)) {
              const b = await readBundle(raw);
              if (!b.modelBytes) throw new Error("bundle has no model member");
              const tmp = path.join(os.tmpdir(), `omz-${crypto.createHash("sha1").update(params.path).digest("hex").slice(0, 12)}.json`);
              await fs.promises.writeFile(tmp, b.modelBytes);
              params = { ...params, path: tmp };
            }
          } catch (e: any) {
            return { type: "response", id: req.id, ok: false, error: `load_workspace: ${e?.message || e}` };
          }
        }
        const r = await conn!.send(req.params!.command_id, params);
        return { type: "response", id: req.id, ok: r.ok, data: r.data, error: r.error };
      }
      case "query": {
        const data = await conn!.query(req.params!.query_id, req.params!.params || {});
        return { type: "response", id: req.id, ok: true, data };
      }
      case "subscribe": {
        const topic = req.params!.topic;
        const cb = (env: any) => postToWebview({ type: "event", envelope: env });
        // One host-side callback per topic: the webview re-subscribes on every (re)load
        // ("Developer: Reload Webviews"); appending would deliver each event N times.
        conn!.unsubscribe(topic);
        conn!.subscribe(topic, cb);
        return { type: "response", id: req.id, ok: true, data: { topic } };
      }
      case "unsubscribe": {
        conn!.unsubscribe(req.params!.topic);
        return { type: "response", id: req.id, ok: true };
      }
      case "getConfig": {
        // The webview asks for config on every (re)load. Status is otherwise pushed only when the host connects or
        // loses the connection, and what was sent before the page had loaded is gone: a reloaded or just opened page
        // would stay "disconnected" with a live connection, or show no hint when there is no runtime.
        if (conn && currentSessionId) sendStatus("connected", `Connected · session ${currentSessionId.slice(0, 8)}`);
        else if (lastStatus?.status === "disconnected") sendStatus("disconnected", lastStatus.message, { hint: DISCONNECTED_HINT });
        else if (lastStatus?.status === "error") sendStatus("error", lastStatus.message);
        const data = getConfig();
        // Engine build string for the status-bar version chip. Embedded: the
        // `engine_version` session query (zig `version` RPC). Socket mode: the
        // Python runtime has no such query — the field is simply omitted.
        data.engine_version = await conn?.query("engine_version", {}).catch(() => undefined);
        data.ts_runtime_version = await conn?.query("runtime_version", {}).catch(() => undefined);
        data.ext_version = BUILD_INFO;
        return { type: "response", id: req.id, ok: true, data };
      }
      case "startRuntime": {
        if (useEmbedded()) {
          if (!embedded) await openConnection();
          return { type: "response", id: req.id, ok: true, data: { endpoint: "wasm://embedded" } };
        }
        const ep = await startRuntimeProcess();
        return { type: "response", id: req.id, ok: true, data: { endpoint: endpointToString(ep) } };
      }
      case "stopRuntime": {
        if (embedded) { await embedded.dispose(); embedded = null; currentSessionId = null; sendStatus("disconnected", "Embedded engine stopped", { hint: DISCONNECTED_HINT }); }
        if (runtime) { const wasRunning = runtime.isRunning; await runtime.stop(); runtime = null; if (wasRunning) runtimeReplaced = true; }
        if (client) { client.close(); client = null; currentSessionId = null; sendStatus("disconnected", "Runtime stopped", { hint: DISCONNECTED_HINT }); }
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
      case "openFeedback": {
        // Fixed trusted destination — the request carries no URL, so there is
        // no arbitrary-URL surface for a hostile webview to pivot through.
        void vscode.env.openExternal(vscode.Uri.parse(FEEDBACK_URL));
        return { type: "response", id: req.id, ok: true };
      }
      case "openExternal": {
        // Same narrow surface as openFeedback: the URL must be one of the
        // fixed LINKS destinations, anything else is rejected.
        const url = (req.params || {}).url;
        if (typeof url !== "string" || !LINK_URLS.includes(url)) {
          return { type: "response", id: req.id, ok: false, error: "openExternal: url is not an allowed destination" };
        }
        void vscode.env.openExternal(vscode.Uri.parse(url));
        return { type: "response", id: req.id, ok: true };
      }
      case "readTextFile": {
        // Scoped read for session descriptors — the webview cannot touch the
        // filesystem, and we do not offer a general file-read surface.
        let p = req.params?.path;
        // `om-example:<id>` resolves to the bundled asset so a catalog .omz can
        // serve its session member exactly like a picked bundle does.
        if (typeof p === "string" && p.startsWith(EXAMPLE_SCHEME)) {
          try {
            p = resolveExampleRef(p, catalogData as ExampleCatalog, path.join(extContext?.extensionPath ?? "", "dist", "examples"));
          } catch (e: any) {
            return { type: "response", id: req.id, ok: false, error: `readTextFile: ${e?.message || e}` };
          }
        }
        if (typeof p !== "string" || !/\.(omsession\.json|omz)$/i.test(p)) {
          return { type: "response", id: req.id, ok: false, error: "readTextFile: only *.omsession.json and *.omz paths are served" };
        }
        try {
          const bytes = await fs.promises.readFile(p);
          // An .omz serves its session member — the GUI's session flow is unchanged.
          if (isZip(bytes)) {
            const b = await readBundle(bytes);
            if (!b.sessionText) return { type: "response", id: req.id, ok: false, error: "readTextFile: bundle has no session member" };
            return { type: "response", id: req.id, ok: true, data: { text: b.sessionText } };
          }
          return { type: "response", id: req.id, ok: true, data: { text: bytes.toString("utf8") } };
        } catch (e: any) {
          return { type: "response", id: req.id, ok: false, error: `readTextFile: ${e?.message || e}` };
        }
      }
      case "saveTextFile": {
        const p = req.params;
        const isBin = typeof p?.bytesB64 === "string";
        if (!isBin && typeof p?.text !== "string") {
          return { type: "response", id: req.id, ok: false, error: "saveTextFile: missing text" };
        }
        // Reject only path-unsafe characters (separators, Windows-illegal
        // chars, control bytes) — spaces and unicode are legal in filenames.
        // The fallback must match the payload's real format: a bundle must
        // never default to a *.json name.
        const d = new Date();
        const ts = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}_${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}${String(d.getSeconds()).padStart(2, "0")}`;
        const suggested = typeof p.suggestedName === "string" && p.suggestedName.trim().length > 0
          && !/[\\/:*?"<>|\x00-\x1f]/.test(p.suggestedName)
          ? p.suggestedName : (isBin ? `OM_Workspace_${ts}.omz` : "session.omsession.json");
        const uri = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.joinPath(defaultDirUri(), suggested),
          filters: isBin ? { "OM Bundle": ["omz"] } : { "OM Session": ["omsession.json", "json"] },
        });
        if (!uri) return { type: "response", id: req.id, ok: true, data: { path: null } };
        await fs.promises.writeFile(uri.fsPath, isBin ? Buffer.from(p.bytesB64, "base64") : p.text, isBin ? undefined : "utf8");
        return { type: "response", id: req.id, ok: true, data: { path: uri.fsPath } };
      }
      case "pickFile": {
        const p = await pickFile((req.params || {}) as PickFileParams);
        return { type: "response", id: req.id, ok: true, data: { path: p } };
      }
      case "fsList": {
        // Server-side file browser for hosts where native pickFile can't run
        // (remote/SSH UI). Same shape as bridge/server.ts's handler.
        const dir = typeof req.params?.dir === "string" && req.params.dir
          ? path.resolve(req.params.dir)
          : defaultDirUri().fsPath;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        const visible = (e: fs.Dirent) => !e.name.startsWith(".");
        const dirs = entries.filter((e) => e.isDirectory() && visible(e)).map((e) => e.name).sort();
        const files = entries.filter((e) => e.isFile() && visible(e)).map((e) => e.name).sort();
        const parent = path.dirname(dir);
        return { type: "response", id: req.id, ok: true, data: { dir, parent: parent === dir ? null : parent, dirs, files } };
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
  activatedAt = Date.now();
  // Status bar button — always visible, click to open GUI
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = "omCore.openGui";
  statusBar.text = "$(circle-outline) OM Core";
  statusBar.tooltip = "OM Core — click to open GUI";
  statusBar.show();
  context.subscriptions.push(statusBar);

  statusPanel = new StatusPanel("omCore.launchPad", statusSnapshot, applyButtonContext);
  const refreshPanel = () => { void statusPanel?.refresh(); };

  context.subscriptions.push(
    statusPanel,
    // The Actions section below the rows is only buttons (viewsWelcome): its tree is empty.
    vscode.window.registerTreeDataProvider("omCore.actions", { getTreeItem: (i: vscode.TreeItem) => i, getChildren: () => [] as vscode.TreeItem[] }),
    vscode.commands.registerCommand("omCore.openGui", () => openGui(context)),
    vscode.commands.registerCommand("omCore.closeGui", () => { panel?.dispose(); }),
    vscode.commands.registerCommand("omCore.startRuntime", async () => {
      try {
        if (useEmbedded()) {
          // There is nothing to launch: "starting" the embedded engine IS
          // opening the connection — it spawns the wasm worker on demand.
          await openConnection();
          vscode.window.showInformationMessage("OM Core embedded engine started.");
        } else {
          await startRuntimeProcess();
          // A GUI tab that is open but not connected (the runtime was stopped or died) comes back to life,
          // instead of showing "disconnected" next to a runtime that is running.
          if (panel && !activeConn()?.isConnected) await connect();
          vscode.window.showInformationMessage("OM Core runtime started.");
        }
      } catch (e: any) { vscode.window.showErrorMessage(`Failed to start runtime: ${e?.message || e}`); }
      refreshPanel();
    }),
    vscode.commands.registerCommand("omCore.stopRuntime", async () => {
      // Only a runtime this extension started can be stopped; another one (Qt GUI, a terminal) is only disconnected from.
      // `runtime` stays set after a failed start (to stop a process that did not get ready in time), so ask whether it runs.
      const hadEmbedded = !!embedded;
      const ours = !!runtime?.isRunning || hadEmbedded;
      if (ours) {
        // One click on the side panel would otherwise drop the model: the runtime holds it, the GUI does not.
        const stop = "Stop Runtime";
        const pick = await vscode.window.showWarningMessage("Stop the om-core runtime?",
          { modal: true, detail: "The model lives in the runtime: changes that are not saved with File → Save are lost." }, stop);
        if (pick !== stop) return;
      }
      if (embedded) { await embedded.dispose(); embedded = null; currentSessionId = null; }
      if (runtime) { await runtime.stop(); runtime = null; }
      if (client) { client.close(); client = null; currentSessionId = null; }
      if (ours) runtimeReplaced = true;   // whatever runs next is not the runtime the open GUI page was showing
      sendStatus("disconnected", hadEmbedded ? "Embedded engine stopped" : "Runtime stopped", { hint: DISCONNECTED_HINT });
      vscode.window.showInformationMessage(hadEmbedded
        ? "OM Core embedded engine stopped."
        : (ours
          ? "OM Core runtime stopped."
          : "OM Tools did not start the running om-core runtime, so it was not stopped; the GUI is disconnected from it."));
    }),
    vscode.commands.registerCommand("omCore.reconnect", async () => {
      try { await connect(); vscode.window.showInformationMessage("OM Core reconnected."); } catch (e: any) { vscode.window.showErrorMessage(`Reconnect failed: ${e?.message || e}`); }
      refreshPanel();
    }),
    vscode.commands.registerCommand("omCore.refreshStatus", () => statusPanel?.refresh()),
    // Side panel row actions (T-062, step 2). Inline buttons pass the row as the argument.
    vscode.commands.registerCommand("omCore.choosePath", () => chooseOmCorePath()),
    vscode.commands.registerCommand("omCore.openSettings", (row?: unknown) => vscode.commands.executeCommand("workbench.action.openSettings", settingForRow(row))),
    vscode.commands.registerCommand("omCore.revealPath", async () => {
      const dir = currentCorePath().path;
      if (!dir || !fs.existsSync(dir)) { vscode.window.showErrorMessage("No om-core folder to show: set omCore.omCorePath first."); return; }
      await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(dir));
    }),
    vscode.commands.registerCommand("omCore.manageTrust", () => vscode.commands.executeCommand("workbench.trust.manage")),
    vscode.commands.registerCommand("omCore.uvInstallHelp", () => vscode.env.openExternal(vscode.Uri.parse(UV_INSTALL_URL))),
    vscode.commands.registerCommand("omCore.showMcpServerInfo", async () => {
      if (!mcpServer) {
        vscode.window.showWarningMessage("The OM Core MCP server is not running. Enable it with the 'omCore.mcp.enabled' setting.");
        return;
      }
      const snippet = JSON.stringify({ servers: { "om-core": { type: "http", url: mcpServer.url } } }, null, 2);
      const pick = await vscode.window.showInformationMessage(
        `OM Core MCP server: ${mcpServer.url}`,
        { modal: false, detail: "Register this URL in your MCP client — e.g. .vscode/mcp.json, or: claude mcp add --transport http om-core " + mcpServer.url },
        "Copy URL", "Copy mcp.json snippet");
      if (pick === "Copy URL") await vscode.env.clipboard.writeText(mcpServer.url);
      else if (pick === "Copy mcp.json snippet") await vscode.env.clipboard.writeText(snippet);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("omCore")) refreshPanel();
      if (e.affectsConfiguration("omCore.mcp")) void restartMcpServer();
      // Mode flip: a live conn belongs to the old mode — drop it and
      // reconnect under the new one (same semantics as Reconnect).
      if (e.affectsConfiguration("omCore.engineMode") || e.affectsConfiguration("omCore.runtimeEndpoint")) {
        if (activeConn()) {
          if (embedded) { void embedded.dispose(); embedded = null; }
          if (client) { client.close(); client = null; }
          currentSessionId = null;
          void connect().catch(() => {});
        }
      }
      // Arena sizes / worker path are fixed at spawn — a live embedded
      // engine can't pick them up. Warn once; they apply on next Start.
      if (embedded && (e.affectsConfiguration("omCore.engineStateBytes") || e.affectsConfiguration("omCore.engineScratchBytes") || e.affectsConfiguration("omCore.tsRuntimePath"))) {
        vscode.window.showWarningMessage("Engine memory/path settings apply on next Start Runtime — the running embedded engine keeps its current values.");
      }
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(refreshPanel),
    vscode.workspace.onDidChangeWorkspaceFolders(refreshPanel),
    { dispose: () => { engineOutput?.dispose(); engineOutput = null; } },
  );

  registerMcpProvider(context);
  context.subscriptions.push(mcpDefChange);
  void restartMcpServer();

  // Optional warm start: engine spawns on first need by default (every
  // editor window activates this extension — don't tax ones that never
  // open OM Core). enginePreload opts into spawn-on-activate.
  if (useEmbedded() && vscode.workspace.getConfiguration("omCore").get<boolean>("enginePreload", false)) {
    void connect().catch(() => {});
  }
}

/** Defer webview creation until the workbench has settled — creating a panel
 *  while VS Code is still starting makes service-worker registration fail and
 *  leaves a dead blank panel. Waits for window focus, then the settle window. */
async function waitForWebviewHost(): Promise<void> {
  if (Date.now() - activatedAt >= WEBVIEW_STARTUP_SETTLE_MS) return;
  if (!vscode.window.state.focused) {
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, WEBVIEW_STARTUP_SETTLE_MS);
      const sub = vscode.window.onDidChangeWindowState((s) => {
        if (s.focused) { clearTimeout(t); sub.dispose(); resolve(); }
      });
    });
  }
  const remaining = WEBVIEW_STARTUP_SETTLE_MS - (Date.now() - activatedAt);
  if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
}

async function openGui(context: vscode.ExtensionContext) {
  if (panel) { panel.reveal(vscode.ViewColumn.One); return; }
  await waitForWebviewHost();
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

  // Connect to the runtime if one is running; Open GUI never starts one (Start Runtime does).
  try {
    await connect();
    // The tab may have been closed while connecting.
    panel?.webview.postMessage({ type: "config", config: getConfig() } as HostToWebview);
  } catch (e: any) {
    // Nothing running is a state, not an error: connect() has already told the page and the side panel.
    if (!(e instanceof RuntimeNotRunningError)) sendStatus("error", `Connection failed: ${e?.message || e}`);
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
  if (mcpServer) { try { mcpServer.close(); } catch {} mcpServer = null; }
  if (client) { client.close(); client = null; }
  if (embedded) { void embedded.dispose(); embedded = null; }
  if (runtime) { runtime.stop(); runtime = null; }
  panel = null;
}
