// backend.ts — EngineBackend abstraction behind extension.ts's handleRequest.
//
//   SocketBackend    → EngineClient → newline-JSON envelopes → om-runtime/Python
//   EmbeddedBackend  → worker_threads worker → engineSession → omz_rpc → wasm
//
// Both expose the same surface the host needs: openSession, command/query
// senders, topic subscriptions, ping, dispose. Events arrive as
// {topic, data} envelopes identical to the socket client's WireEnvelope.

import * as path from "path";
import * as fs from "fs";
import { Worker } from "worker_threads";
import { EngineClient, TransportEndpoint, topicMatches } from "./engineClient";

export interface EngineEvent {
    topic: string;
    data?: any;
}

export interface EngineBackend {
    readonly kind: "socket" | "embedded";
    ping(): Promise<boolean>;
    openSession(clientType: string): Promise<string>;
    send(commandId: string, params: Record<string, any>): Promise<{ ok: boolean; data?: any; error?: string }>;
    query(queryId: string, params: Record<string, any>): Promise<any>;
    subscribe(topic: string, cb: (env: EngineEvent) => void): void;
    unsubscribe(topic: string, cb?: (e: EngineEvent) => void): void;
    readonly isConnected: boolean;
    dispose(): Promise<void>;
}

// ── SocketBackend — wraps the existing EngineClient, no behavior change ────
export class SocketBackend implements EngineBackend {
    readonly kind = "socket" as const;
    private client: EngineClient;
    private sessionId: string | null = null;
    onDisconnect?: () => void;

    constructor(endpoint: TransportEndpoint) {
        this.client = new EngineClient(endpoint);
        this.client.on("disconnect", () => this.onDisconnect?.());
    }

    async connect() { await this.client.connect(); }
    get endpoint(): TransportEndpoint { return this.client.endpoint; }
    get isConnected() { return this.client.isConnected; }
    get session() { return this.sessionId; }

    async ping() { return this.client.ping(); }
    async openSession(clientType: string) {
        this.sessionId = await this.client.openSession(clientType);
        return this.sessionId;
    }
    async send(commandId: string, params: Record<string, any>) { return this.client.send(commandId, params); }
    async query(queryId: string, params: Record<string, any>) { return this.client.query(queryId, params); }
    subscribe(topic: string, cb: (env: EngineEvent) => void) { this.client.subscribe(topic, cb); }
    unsubscribe(topic: string, cb?: (e: EngineEvent) => void) { this.client.unsubscribe(topic, cb); }
    async dispose() { this.client.close(); }
}

// ── EmbeddedBackend — worker_threads → engineSession → omz_rpc → wasm ──────
interface Pending {
    resolve: (v: any) => void;
    reject: (e: Error) => void;
}

export class EmbeddedBackend implements EngineBackend {
    readonly kind = "embedded" as const;
    private worker: Worker | null = null;
    private pending = new Map<string, Pending>();
    private subs = new Map<string, ((env: EngineEvent) => void)[]>();
    private seq = 0;
    private ready: Promise<void> | null = null;
    private sessionId: string | null = null;
    private dead = false;
    /** Called when the worker exits unexpectedly — host surfaces the loss. */
    onWorkerExit?: (code: number | null) => void;
    /** Called after an automatic respawn completes — the fresh engine has an
     *  EMPTY workspace; consumers must treat it as a new runtime. */
    onRespawn?: () => void;
    /** Every session event, before topic filtering — mirrors EngineClient's
     *  "event" emit so the webview sees the same envelope stream on both
     *  transports. */
    onAnyEvent?: (env: EngineEvent) => void;

    constructor(
        private opts: {
            workerPath: string; wasmPath: string; stateBytes?: number; scratchBytes?: number;
            /** Worker stdout/stderr, line-buffered (engine log + session diagnostics). */
            onLog?: (line: string) => void;
        },
    ) {}

    get isConnected() { return !this.dead && this.worker !== null; }
    get session() { return this.sessionId; }

    /** Spawn (or respawn) the worker; resolves when the engine is up. */
    connect(): Promise<void> {
        if (this.ready) return this.ready;
        this.dead = false;
        this.worker = new Worker(this.opts.workerPath, {
            workerData: {
                wasmPath: this.opts.wasmPath,
                stateBytes: this.opts.stateBytes,
                scratchBytes: this.opts.scratchBytes,
            },
            // Private streams: the worker's console.* no longer pipes through to
            // the extension host — we own the lines (diagnostics ring + output
            // channel) instead of losing them.
            stdout: true,
            stderr: true,
        });
        this.pipeLines(this.worker.stdout);
        this.pipeLines(this.worker.stderr);
        this.ready = new Promise<void>((resolve, reject) => {
            this.worker!.on("message", (msg: any) => {
                if (msg?.ready) { resolve(); return; }
                if (msg?.fatal) { reject(new Error(msg.fatal)); return; }
                if (msg?.event) {
                    this.onAnyEvent?.(msg.event);
                    const topic = msg.event.topic;
                    if (topic) for (const [pat, cbs] of this.subs)
                        if (topicMatches(pat, topic)) for (const cb of cbs) cb(msg.event);
                    return;
                }
                if (msg?.id !== undefined) {
                    const p = this.pending.get(msg.id);
                    if (p) { this.pending.delete(msg.id); msg.ok ? p.resolve(msg.data) : p.reject(new Error(msg.error || "request failed")); }
                }
            });
            this.worker!.on("error", (e) => {
                for (const [, p] of this.pending) p.reject(e);
                this.pending.clear();
                reject(e);
            });
            this.worker!.on("exit", (code) => {
                const wasExpected = this.dead;
                this.worker = null;
                this.ready = null;
                for (const [, p] of this.pending) p.reject(new Error("embedded engine worker exited"));
                this.pending.clear();
                if (!wasExpected) this.onWorkerExit?.(code);
            });
        });
        return this.ready;
    }

    /** Accumulate stream chunks into whole lines for opts.onLog. */
    private pipeLines(stream: NodeJS.ReadableStream | null) {
        if (!stream) return;
        let buf = "";
        stream.on("data", (c: Buffer) => {
            buf += c.toString("utf8");
            let i: number;
            while ((i = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, i);
                buf = buf.slice(i + 1);
                if (line) this.opts.onLog?.(line);
            }
        });
        stream.on("end", () => { if (buf.trim()) this.opts.onLog?.(buf); });
    }

    /** Respawn the worker if it died unexpectedly; returns true when a fresh
     *  (empty-workspace) engine came up. No-op while alive, or after an
     *  intentional dispose() — a stopped engine stays stopped.
     *  Topic subs persist across respawn (the message handler reads the map
     *  on every event), so nothing else needs re-arming. */
    private async ensureRespawned(): Promise<boolean> {
        if (this.worker || this.dead) return false;
        await this.connect();
        const s = await this.req("openSession", {});
        this.sessionId = s.session_id;
        this.onRespawn?.();
        this.onAnyEvent?.({ topic: "event.engine.restarted", data: { fresh_runtime: true } });
        return true;
    }

    private req(kind: string, params: Record<string, any>): Promise<any> {
        const id = `e${this.seq++}`;
        return new Promise((resolve, reject) => {
            if (!this.worker) return reject(new Error("embedded engine not running"));
            this.pending.set(id, { resolve, reject });
            this.worker.postMessage({ id, kind, ...params });
        });
    }

    async ping() {
        try { await this.req("ping", {}); return true; } catch { return false; }
    }
    async openSession(_clientType: string) {
        await this.ensureRespawned();
        const r = await this.req("openSession", {});
        this.sessionId = r.session_id;
        return this.sessionId as string;
    }
    async send(commandId: string, params: Record<string, any>) {
        try {
            if (await this.ensureRespawned()) {
                // The new engine is empty — never silently replay a mutation
                // into it. The caller decides whether to retry deliberately.
                return { ok: false as const, error: "engine restarted — workspace is empty; re-issue the command if intended" };
            }
            const data = await this.req("command", { command_id: commandId, params });
            return { ok: true as const, data };
        } catch (e: any) {
            return { ok: false as const, error: String(e?.message || e) };
        }
    }
    async query(queryId: string, params: Record<string, any>) {
        const fresh = await this.ensureRespawned();
        const data = await this.req("query", { query_id: queryId, params });
        // Marker is additive-only: array/primitive payloads can't carry it —
        // the engine.restarted event + freshRuntime status cover those.
        return fresh && data && typeof data === "object" && !Array.isArray(data)
            ? { ...data, fresh_runtime: true }
            : data;
    }
    subscribe(topic: string, cb: (env: EngineEvent) => void) {
        (this.subs.get(topic) || this.subs.set(topic, []).get(topic)!).push(cb);
    }
    unsubscribe(topic: string, cb?: (e: EngineEvent) => void) {
        if (!cb) { this.subs.delete(topic); return; }
        const arr = this.subs.get(topic);
        if (arr) this.subs.set(topic, arr.filter((f) => f !== cb));
    }
    async dispose() {
        this.dead = true;
        const w = this.worker;
        this.worker = null;
        this.ready = null;
        if (w) await w.terminate();
    }
    /** Alias matching EngineClient.close() so a conn union can call either. */
    close() { void this.dispose(); }
}

export interface TsRuntimePaths { workerPath: string; wasmPath: string; }

/** Locate the TS runtime (engineWorker.cjs + om_engine.wasm), canonical source
 *  at a sibling ts_runtime checkout. Resolution order:
 *   1. runtimeDir — an explicit pointer (omCore.tsRuntimePath setting or
 *      OM_TS_RUNTIME_DIR env) naming a ts_runtime checkout with a built dist/
 *   2. the extension's own bundled dist/ (what the vsix ships)
 */
export function resolveTsRuntime(extensionDir: string, runtimeDir?: string | null): TsRuntimePaths {
    const candidates = runtimeDir
        ? [runtimeDir]
        : [extensionDir];
    for (const dir of candidates) {
        const workerPath = path.join(dir, "dist", "engineWorker.cjs");
        const wasmPath = path.join(dir, "dist", "om_engine.wasm");
        if (fs.existsSync(workerPath) && fs.existsSync(wasmPath)) return { workerPath, wasmPath };
    }
    throw new Error(runtimeDir
        ? `ts_runtime not built at ${runtimeDir} — run npm install && npm run build in that checkout`
        : "ts_runtime not bundled — run npm run build (needs ../ts_runtime or OM_TS_RUNTIME_DIR)");
}
