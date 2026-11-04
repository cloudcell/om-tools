import * as net from "net";
import * as crypto from "crypto";
import { EventEmitter } from "events";

export type EndpointKind = "unix" | "tcp";
export interface TransportEndpoint {
  kind: EndpointKind;
  path?: string;
  host?: string;
  port?: number;
}

export interface WireEnvelope {
  message_id: string;
  message_type: string;
  topic: string;
  correlation_id: string;
  session_id?: string | null;
  client_type?: string | null;
  workspace_id?: string | null;
  actor_id?: string | null;
  timestamp: number;
  payload: any;
  status: string;
  command_id?: string;
  reply_to?: string | null;
  causation_id?: string | null;
}

export interface CommandResult {
  ok: boolean;
  data: any;
  error?: string;
}

export type EndpointParseResult =
  | { ok: true; endpoint: TransportEndpoint }
  | { ok: false; error: string };

export function parseEndpoint(spec: string): EndpointParseResult {
  if (!spec) return { ok: false, error: "empty endpoint" };
  try {
    if (spec.startsWith("unix://")) {
      return { ok: true, endpoint: { kind: "unix", path: spec.slice("unix://".length) } };
    }
    if (spec.startsWith("tcp://")) {
      const rest = spec.slice("tcp://".length);
      const [host, portStr] = rest.split(":");
      const port = parseInt(portStr, 10);
      if (!host || !port) return { ok: false, error: "tcp endpoint needs host:port" };
      return { ok: true, endpoint: { kind: "tcp", host, port } };
    }
    return { ok: false, error: "endpoint must be unix:// or tcp://" };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
}

export function endpointToString(ep: TransportEndpoint): string {
  return ep.kind === "unix" ? `unix://${ep.path}` : `tcp://${ep.host}:${ep.port}`;
}

function corr(): string {
  return crypto.randomBytes(16).toString("hex");
}

function makeEnvelope(
  messageType: string,
  topic: string,
  payload: any,
  sessionId?: string | null
): WireEnvelope {
  return {
    message_id: messageType,
    message_type: messageType,
    topic,
    correlation_id: corr(),
    session_id: sessionId ?? null,
    client_type: "repl",
    workspace_id: null,
    actor_id: null,
    timestamp: Date.now() / 1000,
    payload,
    status: "accepted",
    command_id: "",
    reply_to: null,
    causation_id: null,
  };
}

export interface EngineClientEvents {
  event: (envelope: WireEnvelope) => void;
  disconnect: () => void;
  connect: () => void;
}

/**
 * EngineClient — speaks the om-core newline-delimited JSON envelope protocol
 * over a Unix-domain or TCP socket. Mirrors lib_command/core/transport_socket_client.py.
 */
export class EngineClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private buf = Buffer.alloc(0);
  private pending = new Map<string, { resolve: (e: WireEnvelope) => void; reject: (e: Error) => void }>();
  private eventConn = false;
  readonly endpoint: TransportEndpoint;
  private _connected = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private subscriptions = new Map<string, ((e: WireEnvelope) => void)[]>();
  private sessionId: string | null = null;

  constructor(endpoint: TransportEndpoint) {
    super();
    this.endpoint = endpoint;
  }

  get isConnected(): boolean {
    return this._connected && this.socket !== null;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = this.endpoint.kind === "unix"
        ? net.createConnection(this.endpoint.path!)
        : net.createConnection({ host: this.endpoint.host!, port: this.endpoint.port! });
      this.socket = sock;
      sock.setNoDelay(true);
      sock.setEncoding("utf-8");
      sock.on("data", (chunk: string) => this.onData(chunk));
      sock.on("error", (err) => {
        if (!this._connected) reject(err);
        else this.handleDisconnect();
      });
      sock.on("close", () => this.handleDisconnect());
      sock.on("connect", () => {
        this._connected = true;
        this.emit("connect");
        this.startPolling();
        resolve();
      });
    });
  }

  private handleDisconnect() {
    if (!this._connected) return;
    this._connected = false;
    this.socket = null;
    for (const [, p] of this.pending) p.reject(new Error("connection closed"));
    this.pending.clear();
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null; }
    this.emit("disconnect");
  }

  private onData(chunk: string) {
    this.buf = Buffer.concat([this.buf, Buffer.from(chunk, "utf-8")]);
    while (true) {
      const nl = this.buf.indexOf(0x0a);
      if (nl < 0) break;
      const line = this.buf.subarray(0, nl).toString("utf-8").trim();
      this.buf = this.buf.subarray(nl + 1);
      if (!line) continue;
      let env: WireEnvelope;
      try {
        env = JSON.parse(line);
      } catch {
        continue;
      }
      const cid = env.correlation_id;
      const waiter = cid ? this.pending.get(cid) : undefined;
      if (waiter) {
        this.pending.delete(cid);
        waiter.resolve(env);
      } else {
        // unsolicited — likely a polled event
        this.emit("event", env);
      }
    }
  }

  private sendAndWait(env: WireEnvelope, timeoutMs = 30000): Promise<WireEnvelope> {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this._connected) {
        reject(new Error("not connected"));
        return;
      }
      const to = setTimeout(() => {
        this.pending.delete(env.correlation_id);
        reject(new Error("timeout waiting for reply"));
      }, timeoutMs);
      this.pending.set(env.correlation_id, {
        resolve: (e) => { clearTimeout(to); resolve(e); },
        reject: (e) => { clearTimeout(to); reject(e); },
      });
      const data = JSON.stringify(env) + "\n";
      this.socket!.write(data, (err) => {
        if (err) {
          this.pending.delete(env.correlation_id);
          clearTimeout(to);
          reject(err);
        }
      });
    });
  }

  /** Cleanly close the socket and stop polling. Safe to call when already disconnected. */
  disconnect(): void {
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null; }
    if (this.socket) { this.socket.destroy(); this.socket = null; }
    this._connected = false;
    for (const [, p] of this.pending) p.reject(new Error("connection closed"));
    this.pending.clear();
  }

  async ping(): Promise<boolean> {
    try {
      const r = await this.sendAndWait(makeEnvelope("control", "request.transport.ping", {}));
      return !!r.payload?.data?.pong;
    } catch {
      return false;
    }
  }

  async openSession(clientType = "repl"): Promise<string> {
    const r = await this.sendAndWait(makeEnvelope("control", "request.session.open", { client_type: clientType }));
    const sid = r.payload?.data?.session_id;
    if (!sid) throw new Error(r.payload?.error || "session open failed");
    this.sessionId = sid;
    return sid;
  }

  setSession(id: string | null) { this.sessionId = id; }
  getSession(): string | null { return this.sessionId; }

  async send(commandId: string, params: Record<string, any> = {}, timeoutMs?: number): Promise<CommandResult> {
    const env = makeEnvelope("command", "request.command", { command_id: commandId, ...params }, this.sessionId);
    const r = await this.sendAndWait(env, timeoutMs);
    const p = r.payload || {};
    const ok = p.status === "success" || p.status === "succeeded";
    return { ok, data: p.data, error: p.error };
  }

  async query(queryId: string, params: Record<string, any> = {}, timeoutMs?: number): Promise<any> {
    const env = makeEnvelope("query", "request.query", { query_id: queryId, ...params }, this.sessionId);
    const r = await this.sendAndWait(env, timeoutMs);
    const p = r.payload || {};
    if (p.status === "failed" || p.status === "error") {
      throw new Error(p.error || `query ${queryId} failed`);
    }
    return p.data;
  }

  subscribe(topic: string, cb: (e: WireEnvelope) => void) {
    (this.subscriptions.get(topic) || this.subscriptions.set(topic, []).get(topic)!).push(cb);
  }

  unsubscribe(topic: string, cb?: (e: WireEnvelope) => void) {
    if (!cb) { this.subscriptions.delete(topic); return; }
    const arr = this.subscriptions.get(topic);
    if (arr) this.subscriptions.set(topic, arr.filter((f) => f !== cb));
  }

  private startPolling() {
    const poll = async () => {
      if (!this._connected || this.subscriptions.size === 0) return;
      try {
        const env = makeEnvelope("control", "request.poll_events", { topics: Array.from(this.subscriptions.keys()) });
        const r = await this.sendAndWait(env, 5000);
        const events = r.payload?.data?.events || [];
        for (const ed of events) {
          let ev: WireEnvelope;
          try { ev = typeof ed === "string" ? JSON.parse(ed) : ed; } catch { continue; }
          const topic = ev.topic;
          if (!topic) continue;
          for (const [pattern, cbs] of this.subscriptions) {
            if (topicMatches(pattern, topic)) {
              for (const cb of cbs) { try { cb(ev); } catch {} }
            }
          }
        }
      } catch {
        // non-fatal
      }
    };
    this.pollTimer = setInterval(poll, 400);
  }

  close() {
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null; }
    try { this.socket?.destroy(); } catch {}
    this.socket = null;
    this._connected = false;
  }
}

/** Glob-style topic match (mirrors _topic_matches in message_bus.py). */
export function topicMatches(pattern: string, topic: string): boolean {
  if (pattern === topic) return true;
  if (!pattern.includes("*")) return false;
  const re = new RegExp("^" + pattern.split(".").map((p) => p === "*" ? "[^.]+" : p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\.") + "$");
  return re.test(topic);
}
