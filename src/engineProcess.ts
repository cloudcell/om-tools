import { ChildProcess, spawn } from "child_process";
import * as fs from "fs";
import * as net from "net";
import { TransportEndpoint } from "./engineClient";

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
      env.OPENM_TRANSPORT_SOCKET = this.endpoint.path || "";
      delete env.OPENM_TRANSPORT_HOST;
      delete env.OPENM_TRANSPORT_PORT;
      try { if (this.endpoint.path && fs.existsSync(this.endpoint.path)) fs.unlinkSync(this.endpoint.path); } catch {}
    }
    this.proc = spawn("uv", ["run", "python", "-O", "main.py", "--runtime"], {
      cwd: this.omCorePath,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.proc.stdout?.on("data", (d) => { this.stdoutBuf += d.toString(); });
    this.proc.stderr?.on("data", (d) => { this.stderrBuf += d.toString(); });
    this.proc.on("exit", () => { this.proc = null; });

    await this.waitForReady(20000);
  }

  async waitForReady(timeoutMs = 20000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.proc === null) {
        throw new Error(`runtime exited prematurely. stderr: ${this.stderrBuf.slice(-2000)}`);
      }
      if (await this.isPortOpen()) return;
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(`runtime did not become ready within ${timeoutMs}ms. stderr: ${this.stderrBuf.slice(-2000)}`);
  }

  private isPortOpen(): Promise<boolean> {
    return new Promise((resolve) => {
      if (this.endpoint.kind === "unix") {
        const sock = net.createConnection(this.endpoint.path!);
        sock.once("connect", () => { sock.destroy(); resolve(true); });
        sock.once("error", () => { sock.destroy(); resolve(false); });
      } else {
        const sock = net.createConnection({ host: this.endpoint.host!, port: this.endpoint.port! });
        sock.once("connect", () => { sock.destroy(); resolve(true); });
        sock.once("error", () => { sock.destroy(); resolve(false); });
      }
    });
  }

  /** Probe whether an endpoint already has a runtime listening (without launching). */
  static async probe(endpoint: TransportEndpoint): Promise<boolean> {
    return new Promise((resolve) => {
      if (endpoint.kind === "unix") {
        if (!endpoint.path || !fs.existsSync(endpoint.path)) return resolve(false);
        const sock = net.createConnection(endpoint.path);
        sock.once("connect", () => { sock.destroy(); resolve(true); });
        sock.once("error", () => { sock.destroy(); resolve(false); });
      } else {
        const sock = net.createConnection({ host: endpoint.host!, port: endpoint.port! });
        sock.once("connect", () => { sock.destroy(); resolve(true); });
        sock.once("error", () => { sock.destroy(); resolve(false); });
      }
    });
  }

  async stop(): Promise<void> {
    if (!this.proc) return;
    try { this.proc.kill("SIGTERM"); } catch {}
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => { try { this.proc?.kill("SIGKILL"); } catch {} resolve(); }, 4000);
      this.proc?.once("exit", () => { clearTimeout(t); resolve(); });
    });
    this.proc = null;
  }

  getLogs(): { stdout: string; stderr: string } {
    return { stdout: this.stdoutBuf, stderr: this.stderrBuf };
  }
}
