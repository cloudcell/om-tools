/** Shared message protocol between the extension host and the webview UI.
 *  Kept transport-agnostic so the same webview bundle can run in a browser
 *  later (the browser transport would be a WebSocket instead of postMessage). */

export type HostRequestMethod = "ping" | "openSession" | "command" | "query" | "subscribe" | "unsubscribe" | "getConfig" | "startRuntime" | "stopRuntime" | "reconnect" | "pickFile" | "fsList" | "setTitle" | "saveUiState" | "openFeedback" | "openExternal" | "readTextFile" | "saveTextFile";

/** One-click feedback: the only external destination the webview may ask the host to open.
 *  The `openFeedback` request carries no URL — the host always opens this. */
export const FEEDBACK_URL = "https://github.com/cloudcell/om-tools/discussions/categories/ideas";

/** Fixed external destinations for the menubar link buttons. `openExternal` carries a URL
 *  but the host only opens one of these — anything else is rejected at the boundary. */
export const LINKS = {
  github: "https://github.com/cloudcell/om-tools",
  discord: "https://discord.gg/GfU5ypAbaD",
  docs: "https://cloudcell.github.io/om-docs/",
} as const;
export const LINK_URLS: readonly string[] = Object.values(LINKS);

/** `readTextFile` params — the webview cannot read files itself; the host returns text.
 *  Scoped: VS Code serves only `*.omsession.json` paths; the browser host serves the
 *  file the user just picked. */
export interface ReadTextFileParams { path: string }
/** `saveTextFile` params — host picks the destination (native save dialog), writes the
 *  text, returns the chosen path. `downloaded` = browser download fallback (no picker). */
export interface SaveTextFileParams { suggestedName?: string; text?: string; bytesB64?: string }

export interface HostRequest {
  type: "request";
  id: string;
  method: HostRequestMethod;
  params?: Record<string, any>;
}

export interface HostResponse {
  type: "response";
  id: string;
  ok: boolean;
  data?: any;
  error?: string;
}

export interface HostEvent {
  type: "event";
  envelope: any;
}

export interface HostStatus {
  type: "status";
  status: "connecting" | "connected" | "disconnected" | "error" | "starting" | "ready";
  message?: string;
  /** Only on "connected": the host launched a new runtime (or stopped the old one) since the page last was connected,
   *  so what the page shows (tabs, file name, "unsaved") belongs to another model. */
  freshRuntime?: boolean;
  /** Only on "disconnected": what the user can do about it, in the host's own terms (VS Code: a button in the side panel).
   *  The page shows it under the menu bar until the connection is back. */
  hint?: string;
}

/** What `onStatus` callbacks get besides the status and its message. */
export interface StatusExtra {
  freshRuntime?: boolean;
  hint?: string;
}

export interface HostConfig {
  type: "config";
  config: AppConfig;
}

export type HostToWebview = HostResponse | HostEvent | HostStatus | HostConfig;
export type WebviewToHost = HostRequest;

export interface AppConfig {
  showSystemElements: boolean;
  endpoint: string;
  /** true: the host shows native Open/Save dialogs (`pickFile`); false: the webview asks for a path in a text field. */
  nativeFileDialogs?: boolean;
  /** true: the host answers `fsList` — the webview offers a server-side file-browser
   *  dialog for Open/Save (bridge mode: the runtime needs a real path, which a
   *  browser file input cannot return). */
  serverFileBrowse?: boolean;
  /** Absolute folder for default file paths. In the bridge, relative paths for save/load resolve against it. */
  defaultDir?: string;
  /** Connected engine's build string (zig `version` RPC), when the host can read it. */
  engine_version?: string;
  /** Host extension's build string (OM_TOOLS_BUILD), when the host is the VS Code extension. */
  ext_version?: string;
  /** TS runtime's build string (`runtime_version` session query), when it can report one. */
  ts_runtime_version?: string;
}

/** `fsList` response: directory listing for the webview's server-side file browser. */
export interface FsListResult {
  dir: string;
  parent: string | null;
  dirs: string[];
  files: string[];
}

/** `pickFile` params. The runtime reads and writes workspace files itself, by path, so the UI only needs an
 *  absolute path on the runtime's machine. Response data: `{ path: string | null }`, null when cancelled. */
export interface PickFileParams {
  mode: "open" | "save";
  /** Current workspace file, if any: Save starts on it, Open starts in its folder. */
  current?: string | null;
  /** File name Save suggests when there is no current file. */
  defaultName?: string;
}

/** Dockable tool-window ids. `"rules"` is the bottom Rule Panel; the others match the
 *  `dockVisible` keys in AppState. */
export type DockPanelId = "browser" | "info" | "format" | "perf" | "timeline" | "rules";

/** Edge dock zones (Quantrix-style): panels tab-stack inside a zone, one visible at a time. */
export type DockZoneId = "left" | "right" | "bottom";

export interface DockZoneState {
  /** Visible panels stacked in this zone; order is the tab order. */
  panels: DockPanelId[];
  /** The tab showing — one of `panels`, or null when the zone is empty. */
  active: DockPanelId | null;
}

/** Which panels sit in which edge zone, and where a hidden panel goes back to (T-dock). */
export interface DockLayout {
  left: DockZoneState;
  right: DockZoneState;
  bottom: DockZoneState;
  /** Last zone a hidden panel lived in — where it re-docks when shown again. */
  lastZone: Record<DockPanelId, DockZoneId>;
}

/** Default zone membership mirrors the default panel visibility: only Model Browser and the
 *  Rule Panel show on first run (info/format/perf/timeline stay in `lastZone` so they re-dock
 *  in their Quantrix home when enabled). */
export const DEFAULT_DOCK: DockLayout = {
  left: { panels: ["browser"], active: "browser" },
  right: { panels: [], active: null },
  // The bottom zone starts empty: rules is a subpane of each view group (aggregate
  // panes), not a dock member. lastZone keeps a slot so persisted layouts stay valid.
  bottom: { panels: [], active: null },
  lastZone: { browser: "left", info: "left", format: "left", perf: "right", timeline: "right", rules: "bottom" },
};

/** Panel sizes the webview remembers (T-045) plus the dock-zone layout (T-dock). Kept by the host
 *  in `globalState` (VS Code) or in `localStorage` (browser). Every field is optional: a missing or
 *  invalid one falls back to the default. */
export interface UiLayout {
  leftDockWidth?: number;
  leftCollapsed?: boolean;
  rightDockWidth?: number;
  rightCollapsed?: boolean;
  rulePanelHeight?: number;
  rulePanelCollapsed?: boolean;
  dock?: DockLayout;
}

/** Colour theme (T-039). Chosen by hand with the switch in the menu bar; dark when nothing is saved. */
export type UiTheme = "light" | "dark";

/** Display options, shown and edited in Tools → Options. All fields optional in the
 *  persisted state; DEFAULT_OPTIONS fills the gaps. */
export interface UiOptions {
  /** Pale-yellow fill + red corner triangle on hardvalue cells (Qt "hardnumber" style). */
  markHardvalues?: boolean;
  /** Sign marking aggregate items in row/column headers, e.g. "Σ". */
  aggregateSign?: string;
  /** Show the AI Assistant panel toggle (om-tools-web). */
  assistant?: boolean;
  /** Quantrix-style dockable panels: edge zones with tabbed tool windows, drag between zones.
   *  Off = the fixed legacy column layout. */
  docking?: boolean;
  /** Experimental panels: Performance Watch and Timeline in the View menu. Off by default. */
  advancedPanels?: boolean;
}

/** What a fresh install uses — shown next to each control in the Options dialog. */
export const DEFAULT_OPTIONS: Required<UiOptions> = {
  markHardvalues: true,
  aggregateSign: "Σ",
  assistant: true,
  docking: true,
  advancedPanels: false,
};

/** Aggregate-sign choices offered in Tools → Options. The first entry is the default. */
export const AGGREGATE_SIGN_CHOICES: { value: string; label: string }[] = [
  { value: "Σ", label: "Σ  Sigma" },
  { value: "+", label: "+  Plus" },
  { value: "≡", label: "≡  Identical" },
  { value: "T", label: "T  Total" },
  { value: "#", label: "#  Hash" },
];

/** Everything the webview persists. `saveUiState` params: `{ state: UiState }`. */
export interface UiState {
  layout?: UiLayout;
  theme?: UiTheme;
  options?: UiOptions;
}

/** Name of the `<meta>` tag through which the VS Code host hands the saved UiState to a new webview
 *  (content: `encodeURIComponent(JSON.stringify(state))`). */
export const UI_STATE_META = "om-ui-state";
