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

// `om-example:<id>` load_workspace refs — resolved to the bundled examples/ dir by each host.
export const EXAMPLE_SCHEME = "om-example:";

export interface ExampleCatalogEntry { id: string; title: string; description: string; category: string; file: string }
export interface ExampleCatalog { examples: ExampleCatalogEntry[] }

/** `om-example:<id>` → absolute path inside `examplesDir`. The id must match a strict shape
 *  AND the shipped catalog allowlist, and the catalog's own `file` must be a plain filename —
 *  no path segment is ever caller-controlled. Throws with a legible message otherwise. */
export function resolveExampleRef(rawPath: string, catalog: ExampleCatalog, examplesDir: string): string {
  const m = /^om-example:([a-z0-9-]+)$/.exec(rawPath);
  if (!m) throw new Error(`invalid example reference: ${rawPath}`);
  const entry = catalog.examples.find((e) => e.id === m[1]);
  if (!entry) throw new Error(`unknown example: ${m[1]}`);
  if (!/^[A-Za-z0-9_.-]+\.json$/.test(entry.file)) throw new Error(`bad catalog file for ${m[1]}`);
  return path.join(examplesDir, entry.file);
}
