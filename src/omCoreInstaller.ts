// Downloads and installs a managed copy of om-core into the extension's globalStorage
// (plan docs/ue-plans/plan-20261117-0909--download-install-om-core.md).
// Pure Node — no `vscode` import — so it can be tested in plain Node like runtimePolicy.ts/engineStatus.ts.

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { spawn, spawnSync } from "child_process";
import { looksLikeOmCore, missingOmCoreParts } from "./engineStatus";

export const OM_CORE_REPO = "https://github.com/cloudcell/om-core.git";
/** Interpreter for the managed install's `uv sync`. om-core allows >=3.12, but its dependency `pdfo` only ships
 *  wheels for older Pythons: on a newer one uv falls back to a source build that needs a Fortran compiler. 3.12 is
 *  what the pinned commit was tested with and what the lock file has wheels for. */
export const OM_CORE_PYTHON = "3.12";
/** Branch the managed install tracks: the latest commit on `main` at install time, resolved via `git ls-remote`
 *  and then fetched by hash so the checkout is verified against exactly what the remote advertised. */
export const OM_CORE_BRANCH = "main";

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
  /** Test hooks: a local file:// remote, its branch, or a fixed commit instead of resolving the branch. */
  repo?: string;
  branch?: string;
  pin?: string;
  /** Test hook: a fixture checkout has no pyproject to sync. */
  skipUvSync?: boolean;
}

/** Resolve a remote branch to its commit hash via `git ls-remote`, so the fetch below can verify the
 *  checkout against exactly what the remote advertised (and a branch moving mid-install can't smuggle
 *  in a different tree). */
async function resolveRemoteHead(repo: string, branch: string, cwd: string, onOutput?: (s: string) => void): Promise<string> {
  const out = await run("git", ["ls-remote", repo, `refs/heads/${branch}`], cwd, 60_000, onOutput);
  const hash = out.split(/\s+/)[0] ?? "";
  if (!/^[0-9a-f]{40}$/.test(hash)) throw new Error(`could not resolve ${repo} branch "${branch}" to a commit`);
  return hash;
}

/** Clone om-core at the latest `main` commit into `dest` and run `uv sync` in it. Installs through a sibling
 *  `om-core.tmp-*` dir renamed into place, so a failed install never leaves a half checkout that
 *  `looksLikeOmCore` would accept. Preconditions (trusted workspace, git and uv on PATH) are the caller's. */
export async function installOmCore(dest: string, opts: InstallOptions = {}): Promise<void> {
  const repo = opts.repo ?? OM_CORE_REPO;
  const tmp = `${dest}.tmp-${crypto.randomBytes(6).toString("hex")}`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  for (const stale of tmpDirs(dest)) rmRf(stale);
  const GIT_TIMEOUT = 5 * 60_000;
  const UV_TIMEOUT = 15 * 60_000;
  const pin = opts.pin ?? await resolveRemoteHead(repo, opts.branch ?? OM_CORE_BRANCH, path.dirname(dest), opts.onOutput);
  try {
    const git = (args: string[]) => run("git", args, tmp, GIT_TIMEOUT, opts.onOutput);
    fs.mkdirSync(tmp, { recursive: true });
    await git(["init", "--quiet"]);
    await git(["remote", "add", "origin", repo]);
    await git(["fetch", "--depth", "1", "origin", pin]);
    await git(["checkout", "--quiet", "--detach", "FETCH_HEAD"]);
    const head = (await run("git", ["rev-parse", "HEAD"], tmp, 30_000)).trim();
    if (head !== pin) throw new Error(`om-core checkout is ${head}, expected ${pin}`);
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
  if (!opts.skipUvSync) await run("uv", ["sync", "--python", OM_CORE_PYTHON], dest, UV_TIMEOUT, opts.onOutput);
  if (!looksLikeOmCore(dest)) throw new Error("internal error: installed folder is not an om-core checkout");
}
