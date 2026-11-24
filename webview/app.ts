import { OmApi } from "./api";
import { Store } from "./state";
import { AppShell } from "./components/appShell";
import { applyTheme, sanitizeTheme } from "./theme";
import { parseSession } from "../shared/session";
import { alertDialog } from "./components/dialogs";
import { initTips } from "./tips";
import { initTour } from "./tour";
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

  // Contextual first-use tips (T-tips): subscribes to the store's UI-event channel.
  initTips(store);
  // First-run guided tour: registers the tips suppression gate + first-run invite.
  // The tour opens a catalog example so its steps point at a real model.
  initTour(store, { openExample: (id) => shell.openExampleById(id) });

  // Status updates from the host (connecting/connected/disconnected/error).
  transport.onStatus((status, message, extra) => {
    if (status === "connected") {
      store.setStatus(true, message || "connected");
      // A new runtime holds another model: tabs, file name and "unsaved" of the old one go (like File → New).
      (extra?.freshRuntime ? store.onRuntimeReplaced() : store.refreshModel()).catch(() => {});
      applyPendingSession();
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
    store.state.extVersion = cfg.ext_version || "";
    store.state.tsRuntimeVersion = cfg.ts_runtime_version || "";
    store.notify();
  }).catch(() => {});

  // Engine bus events → refresh model/rules on structural changes.
  api.subscribe("event.dimension.*", () => { store.invalidateDimCache(); store.refreshModel(); });
  api.subscribe("event.cube.*", () => store.refreshModel());
  api.subscribe("event.view.*", () => store.refreshModel());
  api.subscribe("event.workspace.*", (ev) => {
    // Saving serializes the model out — nothing changed, refreshing only repaints.
    if (ev?.topic === "event.workspace.saved") return;
    store.invalidateDimCache(); store.refreshModel();
  });
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

  // Web `?session=`/`#session=` links: the host stashes the fetched descriptor object on
  // window.__omPendingSession (and fires om-session-ready if it arrives after mount).
  // Applied once we're connected — applySessionDescriptor loads the model itself.
  const applyPendingSession = () => {
    const raw = (window as any).__omPendingSession;
    const err = (window as any).__omPendingSessionError;
    if (!api.supportsNativeExternalLinks || !store.state.connected) return;
    if (err) {
      (window as any).__omPendingSessionError = null;
      void alertDialog("Session", "The session link could not be loaded.");
      return;
    }
    if (!raw) return;
    (window as any).__omPendingSession = null;
    const parsed = parseSession(typeof raw === "string" ? raw : JSON.stringify(raw));
    // The fetched session's own URL is the base for a relative model.path —
    // session+model self-hosted in one directory just works.
    if (parsed.ok) void shell.applySessionDescriptor(parsed.session, (window as any).__omPendingSessionUrl ?? null);
  };
  window.addEventListener("om-session-ready", applyPendingSession);
  if (store.state.connected) applyPendingSession();
  (window as any).__om = { api, store, shell };
  return { api, store, shell };
}
