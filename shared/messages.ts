/** Shared message protocol between the extension host and the webview UI.
 *  Kept transport-agnostic so the same webview bundle can run in a browser
 *  later (the browser transport would be a WebSocket instead of postMessage). */

export type HostRequestMethod = "ping" | "openSession" | "command" | "query" | "subscribe" | "unsubscribe" | "getConfig" | "startRuntime" | "stopRuntime" | "reconnect";

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
}

export interface HostConfig {
  type: "config";
  config: { showSystemElements: boolean; endpoint: string };
}

export type HostToWebview = HostResponse | HostEvent | HostStatus | HostConfig;
export type WebviewToHost = HostRequest;

export interface AppConfig {
  showSystemElements: boolean;
  endpoint: string;
}
