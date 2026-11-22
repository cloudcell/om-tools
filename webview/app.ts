import { OmApi } from "./api";
import { Store } from "./state";
import { AppShell } from "./components/appShell";
import { applyTheme, sanitizeTheme } from "./theme";
import type { Transport } from "./transport";
import "./styles.css";

export interface MountOptions {
  /** The host's transport: VsCodeTransport in the extension webview,
   *  WebSocketTransport (real ws or a WebSocket-like shim) in the browser. */
  transport: Transport;
}

/** What the host gets back — mostly for debugging/test hooks; the GUI runs itself. */
export interface OmGui {
  api: OmApi;
  store: Store;
  shell: AppShell;
}

/** The GUI library's single entry point. The host supplies a root element and a
 *  Transport; everything else (API client, store, shell, subscriptions) is the
 *  library's business. webview/main.ts is the self-mounting VS Code wrapper. */
export async function mount(root: HTMLElement, opts: MountOptions): Promise<OmGui> {
  const transport = opts.transport;
  const api = new OmApi(transport);
  const store = new Store(api);

  // Saved colour theme goes on <html> before the first render, so nothing paints in the wrong colours.
  applyTheme(sanitizeTheme(api.loadUiState()?.theme));

  // Render the shell first so the GUI is visible even while connecting.
  const shell = new AppShell(store);
  root.replaceWith(shell.render());

  // Status updates from the host (connecting/connected/disconnected/error).
  transport.onStatus((status, message, extra) => {
    if (status === "connected") {
      store.setStatus(true, message || "connected");
      // A new runtime holds another model: tabs, file name and "unsaved" of the old one go (like File → New).
      (extra?.freshRuntime ? store.onRuntimeReplaced() : store.refreshModel()).catch(() => {});
    } else if (status === "disconnected" || status === "error") {
      store.setStatus(false, message || status, extra?.hint);
    } else {
      store.state.statusMessage = message || status;
      store.state.statusHint = "";     // connecting: the way out of "disconnected" is being taken
      store.notify();
    }
  });

  // Pull config (showSystemElements, endpoint) from the host — non-blocking.
  transport.getConfig().then((cfg) => {
    store.state.showSystemElements = cfg.showSystemElements;
    store.state.endpoint = cfg.endpoint;
    store.state.nativeFileDialogs = !!cfg.nativeFileDialogs;
    store.state.serverFileBrowse = !!cfg.serverFileBrowse;
    store.state.defaultDir = cfg.defaultDir || "";
    store.state.engineVersion = cfg.engine_version || "";
    store.notify();
  }).catch(() => {});

  // Engine bus events → refresh model/rules on structural changes.
  api.subscribe("event.dimension.*", () => { store.invalidateDimCache(); store.refreshModel(); });
  api.subscribe("event.cube.*", () => store.refreshModel());
  api.subscribe("event.view.*", () => store.refreshModel());
  api.subscribe("event.workspace.*", () => { store.invalidateDimCache(); store.refreshModel(); });
  api.subscribe("command.*.succeeded", (ev) => {
    const cmd = ev.topic?.split(".")[1];
    // UI-state commands (set_selection on every click, width persists) cannot
    // change model or cell data — refreshing on their echo just repaints twice.
    if (cmd && Store.UI_ONLY_COMMANDS.has(cmd)) return;
    store.refreshModel(); store.refreshRules();
    // Any succeeded command may have changed cell data — reload open views so
    // mutations from other clients (MCP om_command, REPL) show up immediately.
    // Own edits already reloaded; the debounce makes that second pass cheap.
    // Recalc events are the refresh's own echo — scheduling another recalc
    // off them loops forever (each recalc emits calculation.finished again).
    if (cmd === "run_recalculation" || cmd === "recompute_dirty") {
      store.scheduleViewReload();
    } else {
      store.scheduleExternalRefresh(cmd);
    }
  });
  api.subscribe("event.calculation.finished", () => store.scheduleViewReload());

  // If already connected by the time we mount (host auto-connects), load model.
  if (store.state.connected) store.refreshModel().catch(() => {});
  return { api, store, shell };
}
