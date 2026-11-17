// Downloads and installs a managed copy of om-core into the extension's globalStorage
// (plan docs/ue-plans/plan-20261117-0909--download-install-om-core.md).
// Pure Node — no `vscode` import — so it can be tested in plain Node like runtimePolicy.ts/engineStatus.ts.

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { spawn, spawnSync } from "child_process";
import { looksLikeOmCore, missingOmCoreParts } from "./engineStatus";

export const OM_CORE_REPO = "https://github.com/cloudcell/om-core.git";
/** README-tested commit. The pin IS the integrity check (a-08-0d): git objects are content-addressed, so a fetched
 *  HEAD equal to this hash proves the tree is exactly the tested one. Never widen it to a branch or tag. */
export const OM_CORE_PINNED_COMMIT = "72a90caa6cbe3399da6c8b19a82ef9cd73f828e6";

/** Where the managed clone lives inside the extension's globalStorage. */
export function managedCoreDir(globalStorage: string): string {
  return path.join(globalStorage, "om-core");
}

/** git on the PATH of the VS Code process (same PATH engineProcess spawns uv with). */
export function gitOnPath(): boolean {
  const r = spawnSync("git", ["--version"], { stdio: "ignore" });
  return r.status === 0;
}

/** A stale tmp dir from a crashed install is removed before a new install and right after one. */
function tmpDirs(dir: string): string[] {
  try {
    return fs.readdirSync(path.dirname(dir))
      .filter((n) => n.startsWith(path.basename(dir) + ".tmp-"))
      .map((n) => path.join(path.dirname(dir), n));
  } catch { return []; }
}

function rmRf(p: string): void {
  fs.rmSync(p, { recursive: true, force: true });
}

/** One subprocess: output streams to onOutput, resolves on exit 0, rejects with the tail of the output. */
function run(cmd: string, args: string[], cwd: string, timeoutMs: number, onOutput?: (s: string) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const feed = (d: Buffer) => { const s = d.toString(); out += s; onOutput?.(s); };
    proc.stdout!.on("data", feed);
    proc.stderr!.on("data", feed);
    const timer = setTimeout(() => { proc.kill(); reject(new Error(`${cmd} ${args[0]} timed out after ${Math.round(timeoutMs / 60000)} min`)); }, timeoutMs);
    proc.on("error", (e) => { clearTimeout(timer); reject(new Error(`cannot run ${cmd}: ${e.message}`)); });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} ${args[0]} failed (exit ${code}): ${out.trim().split("\n").slice(-3).join(" ") || "no output"}`));
    });
  });
}

export interface InstallOptions {
  /** Progress output (git/uv stdout+stderr), for the OM Core output channel. */
  onOutput?: (s: string) => void;
  /** Test hooks: a local file:// remote and its commit instead of the pinned GitHub pin. */
  repo?: string;
  pin?: string;
  /** Test hook: a fixture checkout has no pyproject to sync. */
  skipUvSync?: boolean;
}

/** Clone om-core at the pinned commit into `dest` and run `uv sync` in it. Installs through a sibling
 *  `om-core.tmp-*` dir renamed into place, so a failed install never leaves a half checkout that
 *  `looksLikeOmCore` would accept. Preconditions (trusted workspace, git and uv on PATH) are the caller's. */
export async function installOmCore(dest: string, opts: InstallOptions = {}): Promise<void> {
  const repo = opts.repo ?? OM_CORE_REPO;
  const pin = opts.pin ?? OM_CORE_PINNED_COMMIT;
  const tmp = `${dest}.tmp-${crypto.randomBytes(6).toString("hex")}`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  for (const stale of tmpDirs(dest)) rmRf(stale);
  const GIT_TIMEOUT = 5 * 60_000;
  const UV_TIMEOUT = 15 * 60_000;
  try {
    const git = (args: string[]) => run("git", args, tmp, GIT_TIMEOUT, opts.onOutput);
    fs.mkdirSync(tmp, { recursive: true });
    await git(["init", "--quiet"]);
    await git(["remote", "add", "origin", repo]);
    await git(["fetch", "--depth", "1", "origin", pin]);
    await git(["checkout", "--quiet", "--detach", "FETCH_HEAD"]);
    const head = (await run("git", ["rev-parse", "HEAD"], tmp, 30_000)).trim();
    if (head !== pin) throw new Error(`om-core checkout is ${head}, expected the pinned commit ${pin}`);
    const missing = missingOmCoreParts(tmp);
    if (missing.length) throw new Error(`the downloaded om-core is missing ${missing.join(", ")}`);
    rmRf(dest);
    fs.renameSync(tmp, dest);
  } catch (e) {
    rmRf(tmp);
    throw e;
  }
  // The checkout is already in place when `uv sync` fails: the folder stays so the side panel can show the
  // path and the ".venv missing — run uv sync" row instead of losing the download.
  if (!opts.skipUvSync) await run("uv", ["sync"], dest, UV_TIMEOUT, opts.onOutput);
  if (!looksLikeOmCore(dest)) throw new Error("internal error: installed folder is not an om-core checkout");
}
