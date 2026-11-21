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
    /** Every session event, before topic filtering — mirrors EngineClient's
     *  "event" emit so the webview sees the same envelope stream on both
     *  transports. */
    onAnyEvent?: (env: EngineEvent) => void;

    constructor(
        private opts: { workerPath: string; wasmPath: string; stateBytes?: number; scratchBytes?: number },
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
        });
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
        const r = await this.req("openSession", {});
        this.sessionId = r.session_id;
        return this.sessionId as string;
    }
    async send(commandId: string, params: Record<string, any>) {
        try {
            const data = await this.req("command", { command_id: commandId, params });
            return { ok: true as const, data };
        } catch (e: any) {
            return { ok: false as const, error: String(e?.message || e) };
        }
    }
    async query(queryId: string, params: Record<string, any>) {
        return this.req("query", { query_id: queryId, params });
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
