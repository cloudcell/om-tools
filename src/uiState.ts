// What the webview may persist in the extension's globalState (T-049, DEV-16): known fields, sane values, small.
// The webview is the less trusted side, so the host re-validates instead of storing whatever object it is handed.
// Pure, no `vscode` import.

import { AGGREGATE_SIGN_CHOICES } from "../shared/messages";
import type { UiState, UiLayout, UiTheme, UiOptions, UiTips } from "../shared/messages";

/** Hard cap on the stored JSON (a real state is ~100 bytes). */
export const UI_STATE_MAX_BYTES = 4096;
/** Cap on the serialized `tips` member alone — ~100+ tip ids, effectively unlimited
 *  for any real registry while staying well under UI_STATE_MAX_BYTES. */
const TIPS_MAX_BYTES = 2048;
/** Cap on the serialized `dock` member — zone/tab layout is nested but stays small. */
const DOCK_MAX_BYTES = 3072;
const TIP_ID_MAX_CHARS = 64;
const MAX_PX = 20000;
const THEMES: readonly UiTheme[] = ["light", "dark"];
const NUMBER_FIELDS: (keyof UiLayout)[] = ["leftDockWidth", "rightDockWidth", "rulePanelHeight"];
const BOOL_FIELDS: (keyof UiLayout)[] = ["leftCollapsed", "rightCollapsed", "rulePanelCollapsed"];
const OPTION_BOOL_FIELDS: (keyof UiOptions)[] = ["markHardvalues", "assistant", "docking", "advancedPanels", "showTips"];

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
    // The dock-zone layout is nested; bound it by size rather than deep-whitelisting its shape.
    if (l.dock && typeof l.dock === "object" && !Array.isArray(l.dock) && JSON.stringify(l.dock).length <= DOCK_MAX_BYTES)
      clean.dock = l.dock as UiLayout["dock"];
    if (Object.keys(clean).length) out.layout = clean;
  }
  const options = src.options;
  if (options && typeof options === "object" && !Array.isArray(options)) {
    const o = options as Record<string, unknown>;
    const clean: UiOptions = {};
    for (const k of OPTION_BOOL_FIELDS) if (typeof o[k] === "boolean") (clean as any)[k] = o[k];
    if (typeof o.aggregateSign === "string" && AGGREGATE_SIGN_CHOICES.some((c) => c.value === o.aggregateSign))
      clean.aggregateSign = o.aggregateSign;
    if (Object.keys(clean).length) out.options = clean;
  }
  const tips = src.tips;
  if (tips && typeof tips === "object" && !Array.isArray(tips)) {
    const cleanTips: UiTips = {};
    const seen = (tips as Record<string, unknown>).seen;
    if (Array.isArray(seen)) {
      const clean = seen.filter((s): s is string => typeof s === "string" && s.length > 0 && s.length <= TIP_ID_MAX_CHARS);
      // Bound by serialized size, not entry count — drop oldest (FIFO) until it fits.
      while (clean.length && JSON.stringify(clean).length > TIPS_MAX_BYTES) clean.shift();
      if (clean.length) cleanTips.seen = clean;
    }
    // tourDone is only meaningful when true; absent/false both mean "not done".
    if ((tips as Record<string, unknown>).tourDone === true) cleanTips.tourDone = true;
    if (Object.keys(cleanTips).length) out.tips = cleanTips;
  }
  if (!out.theme && !out.layout && !out.options && !out.tips) return null;
  return JSON.stringify(out).length <= UI_STATE_MAX_BYTES ? out : null;
}
