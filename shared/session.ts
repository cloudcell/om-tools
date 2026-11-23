/** Session descriptor (`*.omsession.json`) — a link to a model plus the UI state to
 *  restore over it: which view tabs sit in which panes, subpane state, per-grid chips,
 *  selection and scroll. The descriptor is an overlay: every field is optional and
 *  every ID is resolved tolerantly against the actually-loaded model (unknown IDs are
 *  skipped, never fatal). Wire types only — no imports, so this file is host-agnostic
 *  and node-testable (shared/ is also imported by src/).
 *
 *  Resolution order: app defaults < model-file presentation < session < live changes. */

export const SESSION_SCHEMA = "om.session/1";
export const SESSION_EXT = ".omsession.json";
export const EXAMPLE_REF_RE = /^om-example:([a-z0-9-]+)$/;

export interface SessionModelRef {
  /** `om-example:<id>` — catalog allowlist, works on both hosts without a picker. */
  ref?: string;
  /** Absolute path, or relative to the session file's directory (VS Code) / site root (web). */
  path?: string;
  /** http(s) URL — fetched as bytes (web host; VS Code may support later). */
  url?: string;
  /** Zip member name — the model is bundled next to this session inside the same
   *  `.omz` container. Only meaningful when the session itself arrived from a bundle. */
  bundle?: string;
}

export interface SessionZone { panels?: string[]; active?: string | null }

export interface SessionDock {
  left?: SessionZone;
  right?: SessionZone;
  bottom?: SessionZone;
  /** Where a hidden panel re-docks when shown — mirrors DockLayout.lastZone. */
  lastZone?: Record<string, string>;
  sizes?: {
    leftDockWidth?: number;
    rightDockWidth?: number;
    rulePanelHeight?: number;
  };
}

/** Mirrors the webview's AreaNode tree; `gid` labels are descriptor-local keys —
 *  apply maps them onto freshly generated live group ids. */
export interface SessionAreaNode {
  kind: "group" | "split";
  gid?: string;
  dir?: "x" | "y";
  sizes?: number[];
  children?: SessionAreaNode[];
}

export interface SessionGroup {
  tabs?: string[];
  activeTab?: string | null;
  rulesOpen?: boolean;
  rulesCollapsed?: boolean;
  rulesH?: number;
}

export interface SessionViewSel {
  mode?: "cell" | "row" | "col" | "all";
  row?: number;
  col?: number;
  anchorRow?: number;
  anchorCol?: number;
  indices?: number[];
}

export interface SessionViewState {
  /** dim_id → item_id; overrides the model file's page_selections. */
  chips?: Record<string, string>;
  /** Visual grid coordinates — same space the webview's ViewState uses. */
  selection?: SessionViewSel;
  scroll?: { left?: number; top?: number };
}

export interface SessionDescriptor {
  schema: typeof SESSION_SCHEMA;
  name?: string;
  model: SessionModelRef;
  theme?: "light" | "dark";
  dock?: SessionDock;
  viewArea?: SessionAreaNode;
  groups?: Record<string, SessionGroup>;
  focusedGroup?: string;
  views?: Record<string, SessionViewState>;
  /** Shared lower panel (Rules / Calculation Flow): which tab is shown and
   *  whether the panel is collapsed. Unknown tab ids fall back to Rules. */
  lower?: { tab?: string; collapsed?: boolean };
}

export type SessionParseResult =
  | { ok: true; session: SessionDescriptor }
  | { ok: false; error: string };

/** Strict validation of the document skeleton (schema tag + exactly one model source);
 *  the UI sections are checked for shape but their contents resolve tolerantly at apply. */
export function parseSession(text: string): SessionParseResult {
  let obj: any;
  try { obj = JSON.parse(text); } catch (e: any) { return { ok: false, error: `not JSON: ${e?.message || e}` }; }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { ok: false, error: "not a session object" };
  if (obj.schema !== SESSION_SCHEMA) return { ok: false, error: `unsupported schema "${obj.schema}" (want ${SESSION_SCHEMA})` };
  const m = obj.model;
  if (!m || typeof m !== "object") return { ok: false, error: "missing model" };
  const sources = [m.ref, m.path, m.url, m.bundle].filter((v) => typeof v === "string" && v.length > 0);
  if (sources.length !== 1) return { ok: false, error: "model needs exactly one of ref/path/url/bundle" };
  if (typeof m.ref === "string" && m.ref && !EXAMPLE_REF_RE.test(m.ref))
    return { ok: false, error: `bad model ref "${m.ref}"` };
  if (typeof m.url === "string" && m.url && !/^https?:\/\//.test(m.url))
    return { ok: false, error: `model url must be http(s): "${m.url}"` };
  if (typeof m.bundle === "string" && m.bundle &&
      (!/^[A-Za-z0-9_./-]+$/.test(m.bundle) || m.bundle.includes("..") || m.bundle.startsWith("/") || m.bundle.endsWith("/")))
    return { ok: false, error: `bad bundle member "${m.bundle}"` };
  if (obj.theme !== undefined && obj.theme !== "light" && obj.theme !== "dark")
    return { ok: false, error: `bad theme "${obj.theme}"` };
  for (const key of ["groups", "views"] as const) {
    if (obj[key] !== undefined && (typeof obj[key] !== "object" || obj[key] === null || Array.isArray(obj[key])))
      return { ok: false, error: `"${key}" must be an object` };
  }
  if (obj.viewArea !== undefined && !isAreaNode(obj.viewArea))
    return { ok: false, error: "viewArea is not a group/split tree" };
  return { ok: true, session: obj as SessionDescriptor };
}

function isAreaNode(n: any): boolean {
  if (!n || typeof n !== "object") return false;
  if (n.kind === "group") return typeof n.gid === "string";
  if (n.kind === "split")
    return (n.dir === "x" || n.dir === "y") && Array.isArray(n.children) && n.children.every(isAreaNode);
  return false;
}

export type SessionModelKind = "example" | "path" | "url" | "bundle" | null;
export function sessionModelKind(m: SessionModelRef): SessionModelKind {
  if (typeof m?.ref === "string" && m.ref) return "example";
  if (typeof m?.url === "string" && m.url) return "url";
  if (typeof m?.path === "string" && m.path) return "path";
  if (typeof m?.bundle === "string" && m.bundle) return "bundle";
  return null;
}

export function isSessionFileName(name: string | null | undefined): boolean {
  return typeof name === "string" && name.toLowerCase().endsWith(SESSION_EXT);
}
