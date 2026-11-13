import { UI_STATE_META, type AppConfig, type StatusExtra, type UiState } from "../shared/messages";

/** Transport interface — the only webview/VSCode coupling point.
 *  In VSCode, the implementation posts messages to the extension host which
 *  proxies to the om-core socket. In a future browser build, swap in a
 *  WebSocketTransport that speaks the same newline-JSON envelope protocol. */

export interface TransportRequest {
  method: string;
  params?: Record<string, any>;
}

export interface Transport {
  request(method: string, params?: Record<string, any>): Promise<any>;
  subscribe(topic: string, cb: (envelope: any) => void): void;
  /** `extra.freshRuntime` comes only with "connected" (the host started a new runtime since the page was last connected),
   *  `extra.hint` only with "disconnected" (what to do about it). */
  onStatus(cb: (status: string, message?: string, extra?: StatusExtra) => void): void;
  getConfig(): Promise<AppConfig>;
  /** Saved UI state (panel sizes), read synchronously before the first render; null when nothing is saved. */
  loadUiState(): UiState | null;
  /** Persist UI state. Fire-and-forget: a failure only means the sizes are not remembered. */
  saveUiState(state: UiState): void;
}

/** The optional fields of a `status` message, validated (the page does not trust what it is sent more than it has to). */
export function statusExtra(msg: any): StatusExtra {
  return {
    ...(msg.freshRuntime === true ? { freshRuntime: true } : {}),
    ...(typeof msg.hint === "string" && msg.hint ? { hint: msg.hint.slice(0, 500) } : {}),
  };
}

declare function acquireVsCodeApi(): {
  postMessage(msg: any): void;
  getState(): any;
  setState(s: any): void;
};

let _vsCodeApi: any | null | undefined = undefined;
function getVsCode(): any | null {
  if (_vsCodeApi !== undefined) return _vsCodeApi;
  try {
    _vsCodeApi = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : null;
  } catch {
    _vsCodeApi = null;
  }
  return _vsCodeApi;
}

/** Auto-detect the right transport: VSCode postMessage inside a webview,
 *  WebSocket when running standalone in a browser (future web deployment). */
export function createTransport(): Transport {
  if (getVsCode()) return new VsCodeTransport();
  if (typeof WebSocket !== "undefined") return new WebSocketTransport();
  throw new Error("no transport available: not in VSCode and no WebSocket");
}

/** WebSocket transport — for the future standalone browser deployment.
 *  Speaks the same request/response message protocol as VsCodeTransport;
 *  the bridge server (bridge/server.js) proxies envelopes to the om-core socket. */
export class WebSocketTransport implements Transport {
  private ws: WebSocket;
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private statusCbs = new Set<(status: string, message?: string, extra?: StatusExtra) => void>();
  private eventCbs = new Map<string, Set<(env: any) => void>>();
  private seq = 0;
  private cfg: AppConfig | null = null;
  private sendQueue: string[] = [];
  private ready = false;

  constructor(url?: string) {
    // Default to same-origin ws:// — the bridge serves HTTP and WS on one port,
    // so in a real browser deployment this just works. Override via querystring
    // ?ws=host:port to point at a separate bridge.
    const params = new URLSearchParams(location.search);
    const wsHost = params.get("ws") || location.host;
    const u = url || `ws://${wsHost}`;
    this.ws = new WebSocket(u);
    this.ws.onopen = () => {
      this.ready = true;
      for (const m of this.sendQueue) this.ws.send(m);
      this.sendQueue = [];
    };
    this.ws.onmessage = (ev) => this.onMessage(ev.data);
    this.ws.onerror = () => {
      for (const [, p] of this.pending) p.reject(new Error("websocket error"));
      this.pending.clear();
      for (const cb of this.statusCbs) cb("error", "WebSocket connection failed");
    };
    this.ws.onclose = () => {
      for (const [, p] of this.pending) p.reject(new Error("websocket closed"));
      this.pending.clear();
      this.ready = false;
      for (const cb of this.statusCbs) cb("disconnected", "WebSocket closed");
    };
  }

  private onMessage(raw: string) {
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === "response") {
      const p = this.pending.get(msg.id);
      if (p) { this.pending.delete(msg.id); msg.ok ? p.resolve(msg.data) : p.reject(new Error(msg.error || "failed")); }
    } else if (msg.type === "status") {
      for (const cb of this.statusCbs) cb(msg.status, msg.message, statusExtra(msg));
    } else if (msg.type === "event") {
      const topic = msg.envelope?.topic;
      if (!topic) return;
      for (const [pattern, cbs] of this.eventCbs) if (topicMatches(pattern, topic)) for (const cb of cbs) cb(msg.envelope);
    } else if (msg.type === "config") {
      this.cfg = msg.config;
    }
  }

  request(method: string, params?: Record<string, any>): Promise<any> {
    const id = `r${this.seq++}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const data = JSON.stringify({ type: "request", id, method, params });
      if (this.ready) this.ws.send(data); else this.sendQueue.push(data);
    });
  }

  subscribe(topic: string, cb: (envelope: any) => void): void {
    let set = this.eventCbs.get(topic);
    if (!set) { set = new Set(); this.eventCbs.set(topic, set); }
    set.add(cb);
    this.request("subscribe", { topic }).catch(() => {});
  }
  onStatus(cb: (status: string, message?: string, extra?: StatusExtra) => void): void { this.statusCbs.add(cb); }
  async getConfig(): Promise<AppConfig> {
    if (this.cfg) return this.cfg;
    return this.request("getConfig");
  }

  /** Browser: per-origin localStorage (private windows or blocked storage just forget). */
  loadUiState(): UiState | null {
    try { const raw = localStorage.getItem(UI_STATE_KEY); return raw ? JSON.parse(raw) : null; } catch { return null; }
  }
  saveUiState(state: UiState): void {
    try { localStorage.setItem(UI_STATE_KEY, JSON.stringify(state)); } catch { /* not remembered */ }
  }
}

const UI_STATE_KEY = "omCore.uiState";

/** VSCode postMessage transport. */
export class VsCodeTransport implements Transport {
  private vs: any;
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private statusCbs = new Set<(status: string, message?: string, extra?: StatusExtra) => void>();
  private eventCbs = new Map<string, Set<(env: any) => void>>();
  private seq = 0;

  constructor() {
    this.vs = getVsCode();
    if (!this.vs) throw new Error("not running in a VSCode webview");
    window.addEventListener("message", (ev) => this.onMessage(ev.data));
  }

  private onMessage(msg: any) {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "response") {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        msg.ok ? p.resolve(msg.data) : p.reject(new Error(msg.error || "request failed"));
      }
    } else if (msg.type === "status") {
      for (const cb of this.statusCbs) cb(msg.status, msg.message, statusExtra(msg));
    } else if (msg.type === "event") {
      const env = msg.envelope;
      const topic = env?.topic;
      if (!topic) return;
      for (const [pattern, cbs] of this.eventCbs) {
        if (topicMatches(pattern, topic)) for (const cb of cbs) cb(env);
      }
    } else if (msg.type === "config") {
      // handled via getConfig request normally
    }
  }

  request(method: string, params?: Record<string, any>): Promise<any> {
    const id = `r${this.seq++}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.vs.postMessage({ type: "request", id, method, params });
    });
  }

  subscribe(topic: string, cb: (envelope: any) => void): void {
    let set = this.eventCbs.get(topic);
    if (!set) { set = new Set(); this.eventCbs.set(topic, set); }
    set.add(cb);
    this.request("subscribe", { topic }).catch(() => {});
  }

  onStatus(cb: (status: string, message?: string, extra?: StatusExtra) => void): void {
    this.statusCbs.add(cb);
  }

  async getConfig(): Promise<AppConfig> {
    return this.request("getConfig");
  }

  /** `vscode.getState()` first: it survives "Reload Webviews", where the page HTML (and its meta tag) is the
   *  one from panel creation. Otherwise the host's globalState, handed over in the meta tag. */
  loadUiState(): UiState | null {
    try {
      const own = this.vs.getState()?.uiState;
      if (own) return own;
      const meta = document.querySelector(`meta[name="${UI_STATE_META}"]`)?.getAttribute("content");
      return meta ? JSON.parse(decodeURIComponent(meta)) : null;
    } catch { return null; }
  }
  /** Both: setState for webview reloads, the host's globalState for VS Code restarts. */
  saveUiState(state: UiState): void {
    try { this.vs.setState({ ...(this.vs.getState() || {}), uiState: state }); } catch { /* ignore */ }
    this.request("saveUiState", { state }).catch(() => {});
  }
}

function topicMatches(pattern: string, topic: string): boolean {
  if (pattern === topic) return true;
  if (!pattern.includes("*")) return false;
  const re = new RegExp("^" + pattern.split(".").map((p) => p === "*" ? "[^.]+" : p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\.") + "$");
  return re.test(topic);
}
