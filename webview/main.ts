import { mount } from "./app";
import { createTransport } from "./transport";

/** Self-mounting entry for the bundled iife build (dist/webview.js) — the VS
 *  Code webview's index.html loads it as a classic script, so it picks its
 *  transport and mounts on its own. Hosts that drive the ESM build
 *  (dist/webview.mjs) call mount() themselves instead. */
const app = document.getElementById("app")!;
mount(app, { transport: createTransport() }).catch((e) => {
  // textContent, not innerHTML: the message can carry text from the runtime or the model (T-049, DEV-08).
  const box = document.createElement("div");
  box.style.cssText = "padding:24px;color:#d32f2f;font-family:system-ui";
  box.textContent = `OM Core GUI failed to start: ${String(e?.message || e)}`;
  app.replaceChildren(box);
});
