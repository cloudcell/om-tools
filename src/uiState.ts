// What the webview may persist in the extension's globalState (T-049, DEV-16): known fields, sane values, small.
// The webview is the less trusted side, so the host re-validates instead of storing whatever object it is handed.
// Pure, no `vscode` import.

import type { UiState, UiLayout, UiTheme } from "../shared/messages";

/** Hard cap on the stored JSON (a real state is ~100 bytes). */
export const UI_STATE_MAX_BYTES = 4096;
const THEMES: readonly UiTheme[] = ["light", "dark"];
const NUMBER_FIELDS: (keyof UiLayout)[] = ["leftDockWidth", "rulePanelHeight"];
const BOOL_FIELDS: (keyof UiLayout)[] = ["leftCollapsed", "rulePanelCollapsed"];
const MAX_PX = 20000;

/** A clean copy with only the known, valid fields, or null when nothing usable is left or the input is not an object. */
export function sanitizeUiState(input: unknown): UiState | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const src = input as Record<string, unknown>;
  const out: UiState = {};
  if (typeof src.theme === "string" && (THEMES as readonly string[]).includes(src.theme)) out.theme = src.theme as UiTheme;
  const layout = src.layout;
  if (layout && typeof layout === "object" && !Array.isArray(layout)) {
    const l = layout as Record<string, unknown>;
    const clean: UiLayout = {};
    for (const k of NUMBER_FIELDS) {
      const v = l[k];
      if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= MAX_PX) (clean as any)[k] = v;
    }
    for (const k of BOOL_FIELDS) if (typeof l[k] === "boolean") (clean as any)[k] = l[k];
    if (Object.keys(clean).length) out.layout = clean;
  }
  if (!out.theme && !out.layout) return null;
  return JSON.stringify(out).length <= UI_STATE_MAX_BYTES ? out : null;
}
