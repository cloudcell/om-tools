// Rules for launching and talking to the om-core runtime (T-049, security audit 2026-11-12: DEV-03, DEV-10, DEV-11).
// Pure functions without the `vscode` module, so they can be tested in plain Node.

import * as fs from "fs";
import * as path from "path";
import type { TransportEndpoint } from "./engineClient";

/** Why a configured unix socket path must not be used to start a runtime, or null when it is fine.
 *  The path has to be absolute and either not exist yet or be a socket of the current user. Anything else (a regular file,
 *  a directory, a symlink, somebody else's socket) is refused: the plugin used to `unlink` whatever was there. It never
 *  deletes anything now: om-core removes its own stale socket when it binds, after checking that nobody listens on it. */
export function checkUnixEndpointPath(p: string | undefined): string | null {
  if (!p) return "the unix endpoint has no path";
  if (p.includes("\0")) return "the unix socket path contains a NUL character";
  if (!path.isAbsolute(p)) return `the unix socket path must be absolute: ${p}`;
  let st: fs.Stats;
  try { st = fs.lstatSync(p); } catch (e: any) {
    return e?.code === "ENOENT" ? null : `cannot inspect the unix socket path ${p}: ${e?.code || e}`;
  }
  if (st.isSymbolicLink()) return `${p} is a symbolic link, not a socket`;
  if (!st.isSocket()) return `${p} exists and is not a socket (${st.isDirectory() ? "a directory" : "a regular file"}); it was not touched`;
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) return `${p} is a socket of another user`;
  return null;
}

/** Workspace Trust: the runtime is started with `uv run python main.py` in a folder, i.e. code runs. Not in Restricted Mode. */
export function autoStartBlockedReason(isTrusted: boolean): string | null {
  return isTrusted ? null : "This workspace is not trusted (Restricted Mode), so OM Tools will not start the om-core runtime. "
    + "Start it yourself (uv run python -O main.py --runtime in the om-core folder) or trust the workspace.";
}

/** The runtime protocol has no authentication or encryption: outside this machine the traffic is readable and the peer unverified. */
export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || /^127\.\d+\.\d+\.\d+$/.test(h);
}

export function isRemoteEndpoint(ep: TransportEndpoint): boolean {
  return ep.kind === "tcp" && !isLoopbackHost(ep.host);
}
