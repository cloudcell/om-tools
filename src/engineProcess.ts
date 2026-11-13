import { ChildProcess, spawn, spawnSync } from "child_process";
import * as fs from "fs";
import { EngineClient, TransportEndpoint } from "./engineClient";
import { checkUnixEndpointPath } from "./runtimePolicy";

/** Ends a process and everything it started. On Windows `uv run` is a chain: uv.exe, then the venv launcher
 *  (.venv\Scripts\python.exe), then the real python.exe, and Node's `kill()` ends only the first of them. The runtime
 *  kept answering after Stop Runtime, and after VS Code was closed; the panel then called it "started outside OM Tools".
 *  `taskkill /T` walks the tree. Elsewhere `uv run` replaces itself with python, so the signal reaches the runtime.
 *  Synchronous on purpose: deactivate() cannot wait, and the kill must be done before the extension host exits.
 *  There is no gentler way: om-core has no stop request in its protocol and only handles Ctrl+C, which a child of
 *  the extension host without a console cannot be sent on Windows. */
export function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    const r = spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 5000 });
    if (!r.error) return;      // exit code is not looked at: 128 means the process was already gone, which is fine
  }
  try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
}

/** Runtime output kept for error messages: the newest part only (T-049, DEV-07). */
export const LOG_LIMIT_CHARS = 256 * 1024;

/** Appends `chunk` to a log buffer, keeping only the newest LOG_LIMIT_CHARS characters. */
export function appendLog(buf: string, chunk: string): string {
  const all = buf + chunk;
  return all.length > LOG_LIMIT_CHARS ? all.slice(-LOG_LIMIT_CHARS) : all;
}

export interface RuntimeOptions {
  omCorePath: string;
  endpoint: TransportEndpoint;
}

/**
 * EngineProcess — launches and manages the om-core runtime subprocess
 * (`uv run python -O main.py --runtime`) and waits for the transport endpoint
 * to accept connections. Mirrors lib_runtime/launcher.py + runtime_host.py.
 */
export class EngineProcess {
  private proc: ChildProcess | null = null;
  readonly endpoint: TransportEndpoint;
  readonly omCorePath: string;
  private stdoutBuf = "";
  private stderrBuf = "";

  constructor(opts: RuntimeOptions) {
    this.omCorePath = opts.omCorePath;
    this.endpoint = opts.endpoint;
  }

  get isRunning(): boolean {
    return this.proc !== null && !this.proc.killed;
  }

  async start(): Promise<void> {
    if (this.isRunning) return;
    if (!this.omCorePath) {
      throw new Error("om-core path is not set. Configure the 'omCore.omCorePath' setting.");
    }
    if (!fs.existsSync(this.omCorePath)) {
      throw new Error(`om-core path not found: ${this.omCorePath}`);
    }
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      OPENM_TRANSPORT_HOST: this.endpoint.host || "127.0.0.1",
      OPENM_TRANSPORT_PORT: String(this.endpoint.port || 17391),
    };
    if (this.endpoint.kind === "unix") {
      // Never delete anything here (it used to unlink whatever sat at the configured path). A leftover socket is
      // removed by om-core itself when it binds, after checking that nobody listens on it; anything else is refused.
      const bad = checkUnixEndpointPath(this.endpoint.path);
      if (bad) throw new Error(`Not starting the runtime: ${bad}.`);
      env.OPENM_TRANSPORT_SOCKET = this.endpoint.path || "";
      delete env.OPENM_TRANSPORT_HOST;
      delete env.OPENM_TRANSPORT_PORT;
    }
    this.proc = spawn("uv", ["run", "python", "-O", "main.py", "--runtime"], {
      cwd: this.omCorePath,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.proc.stdout?.on("data", (d) => { this.stdoutBuf = appendLog(this.stdoutBuf, d.toString()); });
    this.proc.stderr?.on("data", (d) => { this.stderrBuf = appendLog(this.stderrBuf, d.toString()); });
    this.proc.on("exit", () => { this.proc = null; });

    await this.waitForReady(20000);
  }

  async waitForReady(timeoutMs = 20000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.proc === null) {
        throw new Error(`runtime exited prematurely. stderr: ${this.stderrBuf.slice(-2000)}`);
      }
      if (await EngineClient.handshake(this.endpoint, 1500)) return;   // a real om-core answers; a squatter on the port does not
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(`runtime did not become ready within ${timeoutMs}ms. stderr: ${this.stderrBuf.slice(-2000)}`);
  }

  /** Is a real om-core runtime listening on this endpoint (without launching anything)? It must answer the protocol's
   *  ping: an open port is not enough, as any other program can listen on 17391 (T-049, DEV-10). */
  static async probe(endpoint: TransportEndpoint): Promise<boolean> {
    if (endpoint.kind === "unix" && (!endpoint.path || !fs.existsSync(endpoint.path))) return false;
    return EngineClient.handshake(endpoint, 2000);
  }

  /** Stops the runtime process and what it started. The kill itself happens before the first `await`, so
   *  `deactivate()` can call this without waiting for it. */
  async stop(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    const kill = (signal: NodeJS.Signals) => {
      if (proc.pid) killProcessTree(proc.pid);
      else { try { proc.kill(signal); } catch {} }
    };
    const gone = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
    kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => { kill("SIGKILL"); resolve(); }, 4000);
      void gone.then(() => { clearTimeout(t); resolve(); });
    });
    this.proc = null;
  }

  getLogs(): { stdout: string; stderr: string } {
    return { stdout: this.stdoutBuf, stderr: this.stderrBuf };
  }
}
