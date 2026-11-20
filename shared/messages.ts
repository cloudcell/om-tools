/** Shared message protocol between the extension host and the webview UI.
 *  Kept transport-agnostic so the same webview bundle can run in a browser
 *  later (the browser transport would be a WebSocket instead of postMessage). */

export type HostRequestMethod = "ping" | "openSession" | "command" | "query" | "subscribe" | "unsubscribe" | "getConfig" | "startRuntime" | "stopRuntime" | "reconnect" | "pickFile" | "setTitle" | "saveUiState";

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
  /** Absolute folder for default file paths. In the bridge, relative paths for save/load resolve against it. */
  defaultDir?: string;
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

/** Panel sizes the webview remembers (T-045). Kept by the host in `globalState` (VS Code) or in
 *  `localStorage` (browser). Every field is optional: a missing or invalid one falls back to the default. */
export interface UiLayout {
  leftDockWidth?: number;
  leftCollapsed?: boolean;
  rulePanelHeight?: number;
  rulePanelCollapsed?: boolean;
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
}

/** What a fresh install uses — shown next to each control in the Options dialog. */
export const DEFAULT_OPTIONS: Required<UiOptions> = {
  markHardvalues: true,
  aggregateSign: "Σ",
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
