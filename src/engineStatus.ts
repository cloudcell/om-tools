// What the OM Core side panel shows about the engine (T-062): runtime, GUI connection, om-core folder, its dependencies, uv.
// Pure functions without the `vscode` module, so they can be tested in plain Node.

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

function isFile(p: string): boolean { try { return fs.statSync(p).isFile(); } catch { return false; } }
function isDir(p: string): boolean { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

/** Parts of an om-core checkout missing from `dir`: empty when it looks like om-core (runtime entry point and libs). */
export function missingOmCoreParts(dir: string): string[] {
  const missing: string[] = [];
  if (!isFile(path.join(dir, "main.py"))) missing.push("main.py");
  if (!isDir(path.join(dir, "lib_runtime"))) missing.push("lib_runtime/");
  if (!isDir(path.join(dir, "lib_openm"))) missing.push("lib_openm/");
  return missing;
}

export function looksLikeOmCore(dir: string): boolean {
  return missingOmCoreParts(dir).length === 0;
}

// ---------- om-core folder ----------

export interface CorePathInput {
  /** omCore.omCorePath as VS Code returns it (Restricted Mode already drops workspace values). */
  setting: string;
  /** Where the setting comes from, for display: "User settings", "Workspace settings", … */
  settingScope: string | null;
  /** OM_CORE_PATH, else OPENM_CORE_PATH. */
  env: string;
  workspaceFolders: string[];
  /** Workspace folders the user already allowed to run om-core from (globalState). */
  approvedFolders: string[];
}

export type CorePathSource = "setting" | "env" | "workspace" | "none";

export interface CorePathInfo {
  source: CorePathSource;
  /** The folder the runtime would be started from; null when Start Runtime would ask for one. */
  path: string | null;
  settingScope: string | null;
  /** Parts of om-core missing from `path` (only a folder from the setting can have them: the others must look like om-core). */
  missingParts: string[];
  /** A workspace folder that OM Tools will ask about before running it the first time. */
  needsApproval: boolean;
  /** Values that are set but not used, and why. */
  ignored: { what: string; value: string; reason: string }[];
}

/** Which om-core folder starting the runtime would use. Same order as resolveOmCorePath in extension.ts (setting > env >
 *  workspace folder > folder picker), but it only looks: no questions, no warnings. Keep the two in step. */
export function describeOmCorePath(input: CorePathInput): CorePathInfo {
  const ignored: CorePathInfo["ignored"] = [];
  const base = { settingScope: input.settingScope, missingParts: [] as string[], needsApproval: false, ignored };

  const setting = input.setting.trim();
  if (setting && fs.existsSync(setting)) {
    return { ...base, source: "setting", path: setting, missingParts: missingOmCoreParts(setting) };
  }
  if (setting) ignored.push({ what: "omCore.omCorePath", value: setting, reason: "folder not found" });

  const env = input.env.trim();
  if (env && looksLikeOmCore(env)) return { ...base, source: "env", path: env };
  if (env) {
    const reason = fs.existsSync(env) ? `not an om-core folder (missing ${missingOmCoreParts(env).join(", ")})` : "folder not found";
    ignored.push({ what: "OM_CORE_PATH", value: env, reason });
  }

  for (const dir of input.workspaceFolders) {
    if (looksLikeOmCore(dir)) {
      return { ...base, source: "workspace", path: dir, needsApproval: !input.approvedFolders.includes(dir) };
    }
  }
  return { ...base, source: "none", path: null };
}

// ---------- dependencies and version ----------

/** `uv sync` creates `.venv` in the om-core folder; without it the first start downloads everything and times out. */
export function hasVenv(dir: string): boolean {
  return isFile(path.join(dir, ".venv", "pyvenv.cfg"));
}

/** Short commit of a git checkout (`.git` folder), or null: not a git checkout, a worktree, or unreadable. */
export function readGitCommit(dir: string): string | null {
  try {
    const gitDir = path.join(dir, ".git");
    if (!isDir(gitDir)) return null;
    const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
    let hash: string | null = null;
    const ref = /^ref:\s*(.+)$/.exec(head)?.[1];
    if (!ref) hash = head;
    else if (isFile(path.join(gitDir, ref))) hash = fs.readFileSync(path.join(gitDir, ref), "utf8").trim();
    else if (isFile(path.join(gitDir, "packed-refs"))) {
      const line = fs.readFileSync(path.join(gitDir, "packed-refs"), "utf8").split(/\r?\n/).find((l) => l.endsWith(" " + ref));
      hash = line ? line.split(" ")[0] : null;
    }
    return hash && /^[0-9a-f]{40,64}$/.test(hash) ? hash.slice(0, 7) : null;
  } catch { return null; }
}

// ---------- uv ----------

export interface UvInfo {
  /** uv as the runtime start finds it (spawn("uv") searches PATH of the VS Code process). */
  onPath: string | null;
  /** uv installed where its installer puts it, but not on this PATH: VS Code was started before the install. */
  elsewhere: string | null;
}

export function findUv(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform, home: string = os.homedir()): UvInfo {
  const exe = platform === "win32" ? "uv.exe" : "uv";
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const sep = platform === "win32" ? ";" : ":";
  for (const d of (env[pathKey] ?? "").split(sep)) {
    const dir = d.trim().replace(/^"(.*)"$/, "$1");
    if (dir && isFile(path.join(dir, exe))) return { onPath: path.join(dir, exe), elsewhere: null };
  }
  // The standalone installer uses ~/.local/bin (older versions ~/.cargo/bin).
  for (const dir of [path.join(home, ".local", "bin"), path.join(home, ".cargo", "bin")]) {
    if (isFile(path.join(dir, exe))) return { onPath: null, elsewhere: path.join(dir, exe) };
  }
  return { onPath: null, elsewhere: null };
}

// ---------- the panel rows ----------

export interface StatusSnapshot {
  trusted: boolean;
  runtime: {
    /** Where a runtime was found or would be started. */
    endpoint: string | null;
    /** Invalid omCore.runtimeEndpoint or OPENM_TRANSPORT_* (then nothing is probed). */
    endpointError: string | null;
    running: boolean;
    startedByUs: boolean;
    /** A runtime process is being launched right now (not just probed): up to 20 s the first time. */
    starting: boolean;
  };
  gui: {
    open: boolean;
    connected: boolean;
    /** The GUI tab is being connected right now (including the runtime start it waits for). */
    connecting: boolean;
    session: string | null;
  };
  /** Last status the extension reported (sendStatus): "starting", "connecting", "error", … */
  lastStatus: { status: string; message?: string } | null;
  corePath: CorePathInfo;
  /** null when there is no usable om-core folder to look into. */
  venv: boolean | null;
  commit: string | null;
  uv: UvInfo;
}

export interface StatusRow {
  id: "runtime" | "gui" | "path" | "deps" | "uv";
  label: string;
  description: string;
  tooltip: string;
  /** Codicon id. */
  icon: string;
  /** Theme color id for the icon. */
  color?: string;
  /** TreeItem.contextValue: which buttons the row shows (view/item/context in package.json). */
  contextValue: string;
  /** Command run when the row is clicked; it gets the row as its argument. */
  command?: string;
}

/** The URL behind the uv row's "How to install" button. */
export const UV_INSTALL_URL = "https://docs.astral.sh/uv/getting-started/installation/";

const OK = "testing.iconPassed";
const WARN = "list.warningForeground";
const ERR = "list.errorForeground";

function oneLine(s: string, max = 60): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

function runtimeRow(s: StatusSnapshot): StatusRow {
  const r = s.runtime;
  const row = { id: "runtime" as const, label: "Runtime" };
  if (r.endpointError) {
    return { ...row, contextValue: "runtime-endpoint-error", command: "omCore.openSettings", icon: "error", color: ERR, description: "Invalid endpoint", tooltip: r.endpointError + "\n\nClick to open the setting." };
  }
  const where = r.endpoint ?? "";
  if (r.starting && !r.running) {
    return { ...row, contextValue: "runtime-starting", icon: "loading~spin", description: "Starting…", tooltip: s.lastStatus?.status === "starting" && s.lastStatus.message ? s.lastStatus.message : `Starting the runtime at ${where}` };
  }
  if (r.running) {
    return {
      ...row, contextValue: r.startedByUs ? "runtime-ours" : "runtime-external", icon: "circle-filled", color: OK, description: `Running · ${where}`,
      tooltip: r.startedByUs
        ? `om-core runtime at ${where}, started by OM Tools. Stop Runtime stops it.`
        : `om-core runtime at ${where}, started outside OM Tools (for example the om-core Qt GUI or a terminal). OM Tools cannot stop it; stop it where it was started.`,
    };
  }
  const lastError = s.lastStatus?.status === "error" && s.lastStatus.message ? `\n\nLast error: ${s.lastStatus.message}` : "";
  if (!s.trusted) {
    return {
      ...row, contextValue: "runtime-restricted", icon: "warning", color: WARN, description: "Not running · Restricted Mode",
      tooltip: `Nothing answers at ${where}. This workspace is not trusted (Restricted Mode), so OM Tools will not start the runtime. Trust the workspace, or start the runtime yourself.${lastError}`,
    };
  }
  return {
    ...row, contextValue: "runtime-stopped", icon: "circle-outline", description: "Not running",
    tooltip: `Nothing answers at ${where}. Start Runtime starts it. Open GUI does not: it only connects to a running runtime.${lastError}`,
  };
}

function guiRow(s: StatusSnapshot): StatusRow {
  const g = s.gui;
  // A click opens the GUI, or brings its tab to the front.
  const row = { id: "gui" as const, label: "GUI", command: "omCore.openGui" };
  if (!g.open) return { ...row, contextValue: "gui-closed", icon: "circle-outline", description: "Not open", tooltip: "Click to open the grid in an editor tab and connect it to the runtime." };
  if (g.connected) {
    return { ...row, contextValue: "gui-connected", icon: "circle-filled", color: OK, description: g.session ? `Connected · session ${g.session.slice(0, 8)}` : "Connected", tooltip: "The GUI tab is connected to the runtime. Click to show it." };
  }
  const st = s.lastStatus;
  if (g.connecting) {
    return { ...row, contextValue: "gui-connecting", icon: "loading~spin", description: "Connecting…", tooltip: st && (st.status === "connecting" || st.status === "starting") && st.message ? st.message : "Connecting to the runtime…" };
  }
  if (st?.status === "error") {
    return { ...row, contextValue: "gui-disconnected", icon: "error", color: ERR, description: oneLine(st.message ?? "Error"), tooltip: (st.message ?? "Error") + "\n\nReconnect tries again." };
  }
  return { ...row, contextValue: "gui-disconnected", icon: "warning", color: WARN, description: "Disconnected", tooltip: (st?.message ? st.message + "\n\n" : "") + "Reconnect connects the GUI again." };
}

function sourceText(p: CorePathInfo): string {
  switch (p.source) {
    case "setting": return `omCore.omCorePath${p.settingScope ? ` (${p.settingScope})` : ""}`;
    case "env": return "the OM_CORE_PATH environment variable";
    case "workspace": return "the open workspace folder";
    default: return "";
  }
}

function pathRow(s: StatusSnapshot): StatusRow {
  const p = s.corePath;
  // A click opens the setting; the Choose folder… link in the omCore.omCorePath setting, or the row's context menu, chooses a folder.
  const row = { id: "path" as const, label: "Engine path", command: "omCore.openSettings" };
  const ignoredText = p.ignored.map((i) => `${i.what} = ${i.value}: ${i.reason}, not used.`).join("\n");
  const notes = (extra: string) => [ignoredText, extra, "Click to open the setting."].filter(Boolean).join("\n\n");

  if (!p.path) {
    const ask = "Choose the om-core folder (the clone that contains main.py) with Choose… in the Actions section, or Start Runtime will ask for it.";
    if (p.ignored.length) {
      const first = p.ignored[0];
      return { ...row, contextValue: "path-none", icon: "warning", color: WARN, description: `${first.value} — ${first.reason}`, tooltip: notes(ask) };
    }
    return { ...row, contextValue: "path-none", icon: "error", color: ERR, description: "Not set", tooltip: notes("omCore.omCorePath is empty. " + ask) };
  }
  if (p.missingParts.length) {
    return {
      ...row, contextValue: "path-not-om-core", icon: "error", color: ERR, description: `${p.path} — not an om-core folder`,
      tooltip: notes(`From ${sourceText(p)}. Missing: ${p.missingParts.join(", ")}. Choose the om-core clone, the folder that contains main.py.`),
    };
  }
  const commit = s.commit ? ` · ${s.commit}` : "";
  const scope = p.source === "setting" && p.settingScope ? `  (${p.settingScope})` : p.source === "env" ? "  (OM_CORE_PATH)" : p.source === "workspace" ? "  (workspace)" : "";
  const approval = p.needsApproval ? "OM Tools will ask once before running om-core from this folder." : "";
  const version = s.commit ? `Commit ${s.commit}.` : "";
  return {
    ...row, contextValue: "path-ok", icon: p.ignored.length ? "warning" : "pass", color: p.ignored.length ? WARN : OK,
    description: `${p.path}${commit}${scope}`,
    tooltip: notes([`From ${sourceText(p)}.`, version, approval].filter(Boolean).join(" ")),
  };
}

function depsRow(s: StatusSnapshot): StatusRow {
  const row = { id: "deps" as const, label: "Dependencies" };
  if (s.venv === null) return { ...row, contextValue: "deps-unknown", icon: "dash", description: "—", tooltip: "Shown once the om-core folder is known." };
  if (s.venv) return { ...row, contextValue: "deps-ok", icon: "pass", color: OK, description: ".venv found", tooltip: `uv sync has been run in ${s.corePath.path}.` };
  return {
    ...row, contextValue: "deps-missing", icon: "warning", color: WARN, description: ".venv missing — run uv sync",
    tooltip: `Run uv sync in ${s.corePath.path}. Without it the first start downloads the dependencies and takes longer than OM Tools waits (20 s).`,
  };
}

function uvRow(s: StatusSnapshot): StatusRow {
  const row = { id: "uv" as const, label: "uv" };
  if (s.uv.onPath) return { ...row, contextValue: "uv-ok", icon: "pass", color: OK, description: s.uv.onPath, tooltip: "OM Tools starts the runtime with uv run." };
  if (s.uv.elsewhere) {
    return {
      ...row, contextValue: "uv-elsewhere", icon: "warning", color: WARN, description: "Not on PATH — restart VS Code",
      tooltip: `uv is installed at ${s.uv.elsewhere}, but VS Code was started before it was added to PATH. Close all VS Code windows and start VS Code again (Reload Window is not enough).`,
    };
  }
  return {
    ...row, contextValue: "uv-missing", command: "omCore.uvInstallHelp", icon: "error", color: ERR, description: "Not found",
    tooltip: `OM Tools starts the runtime with uv. Install it (${UV_INSTALL_URL}), then restart VS Code. Not needed if you start the runtime yourself.\n\nClick to open the installation page.`,
  };
}

export function buildStatusRows(s: StatusSnapshot): StatusRow[] {
  return [runtimeRow(s), guiRow(s), pathRow(s), depsRow(s), uvRow(s)];
}

// ---------- the two buttons under the rows ----------

/** Which button the Actions section shows for the runtime: Start, Stop, nothing to press while it starts, or a note
 *  when the runtime was started by somebody else (OM Tools cannot stop it). */
export type RuntimeButton = "start" | "stop" | "starting" | "external";
/** Same for the GUI tab: Open, Close, or nothing to press while it connects (a second click would close it again). */
export type GuiButton = "open" | "close" | "opening";

/** Context keys that `viewsWelcome` entries of the Actions section test in their `when`. */
export const RUNTIME_BUTTON_KEY = "omCore.runtimeButton";
export const GUI_BUTTON_KEY = "omCore.guiButton";

export function buttonStates(s: StatusSnapshot): { runtime: RuntimeButton; gui: GuiButton } {
  const r = s.runtime;
  const runtime: RuntimeButton = r.starting && !r.running ? "starting" : r.running ? (r.startedByUs ? "stop" : "external") : "start";
  // A tab that is open but not connected (the runtime was stopped or died) is "close": it is reconnected by Start Runtime
  // or Reconnect, and "Opening…" would hide the only way to get rid of it.
  const gui: GuiButton = !s.gui.open ? "open" : s.gui.connecting ? "opening" : "close";
  return { runtime, gui };
}
