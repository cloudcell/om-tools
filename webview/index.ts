/** om-gui library entry — what a host imports to embed the OM Core GUI.
 *  Bundled as dist/webview.mjs (ESM); dist/webview.js is the self-mounting
 *  iife variant for hosts that can only load a classic script (VS Code webview,
 *  legacy injection). Source consumers (file:/workspace deps) import this file. */
export { mount, type MountOptions, type OmGui } from "./app";
export {
  createTransport, statusExtra, WebSocketTransport, VsCodeTransport,
  type Transport, type TransportRequest, type WebSocketLike,
} from "./transport";
export { guiVersion, guiVersionShort } from "./version";
