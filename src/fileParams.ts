// File-path command params — pure functions without the `vscode` module, so they can be
// tested in plain Node and shared by the extension host, the MCP server, and the bridge.
import * as path from "path";

/** Commands whose `path` param is a filesystem path the runtime reads or writes. */
export const FILE_COMMANDS = new Set(["save_workspace", "load_workspace"]);

/** Relative `path` of save_workspace / load_workspace → absolute against `baseDir`. */
export function resolveFileParams(commandId: string, params: Record<string, any>, baseDir: string): Record<string, any> {
  if (!FILE_COMMANDS.has(commandId) || typeof params.path !== "string" || !params.path || path.isAbsolute(params.path)) return params;
  return { ...params, path: path.resolve(baseDir, params.path) };
}
