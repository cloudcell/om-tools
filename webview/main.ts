import { createTransport } from "./transport";
import { OmApi } from "./api";
import { Store } from "./state";
import { AppShell } from "./components/appShell";
import "./styles.css";

/** Webview entry point. Wires the transport (VSCode postMessage today,
 *  WebSocket in a future browser build) to the OM Core API client and
 *  renders the app shell. */
async function main() {
  const transport = createTransport();
  const api = new OmApi(transport);
  const store = new Store(api);

  // Render the shell first so the GUI is visible even while connecting.
  const shell = new AppShell(store);
  const app = document.getElementById("app")!;
  app.replaceWith(shell.render());

  // Status updates from the host (connecting/connected/disconnected/error).
  transport.onStatus((status, message) => {
    if (status === "connected") {
      store.setStatus(true, message || "connected");
      store.refreshModel().catch(() => {});
    } else if (status === "disconnected" || status === "error") {
      store.setStatus(false, message || status);
    } else {
      store.state.statusMessage = message || status;
      store.notify();
    }
  });

  // Pull config (showSystemElements, endpoint) from the host — non-blocking.
  transport.getConfig().then((cfg) => {
    store.state.showSystemElements = cfg.showSystemElements;
    store.state.endpoint = cfg.endpoint;
    store.state.nativeFileDialogs = !!cfg.nativeFileDialogs;
    store.state.defaultDir = cfg.defaultDir || "";
    store.notify();
  }).catch(() => {});

  // Engine bus events → refresh model/rules on structural changes.
  api.subscribe("event.dimension.*", () => store.refreshModel());
  api.subscribe("event.cube.*", () => store.refreshModel());
  api.subscribe("event.view.*", () => store.refreshModel());
  api.subscribe("event.workspace.*", () => store.refreshModel());
  api.subscribe("command.*.succeeded", () => { store.refreshModel(); store.refreshRules(); });

  // If already connected by the time we mount (host auto-connects), load model.
  if (store.state.connected) store.refreshModel().catch(() => {});
}

main().catch((e) => {
  const app = document.getElementById("app");
  if (app) app.innerHTML = `<div style="padding:24px;color:#d32f2f;font-family:system-ui">OM Core GUI failed to start: ${String(e?.message || e)}</div>`;
});
