// Rule metadata for the Rules tab: channel, mask, specificity, precedence status (issues #3, #7).
// Port of om-core `lib_gui/rule_panel.py` (`_compute_precedence_statuses`, the channel and mask logic in `rebuild`)
// and `lib_rulepanel` (the pill list, the row tooltip). The engine sends `addr_mask` (one slot per cube dimension,
// `null` = any item); everything else is derived here, as in Qt. Pure functions, no DOM.

import type { RuleDTO } from "./api";
import type { MaterialIcon } from "./menuIcons";

/** The pills of the filter bar, in Qt order (`all_channels` in `RulePanel.rebuild`). A rule belongs to the channel of
 *  its `@` target (`@.fill` ...), `@.value` when it has none. Icons: Material Symbols stand in for Qt's Lucide set. */
export const RULE_CHANNELS: { id: string; icon: MaterialIcon }[] = [
  { id: "@.value", icon: "grid_on" },
  { id: "@.fill", icon: "palette" },
  { id: "@.format_number", icon: "tag" },
  { id: "@.font_family", icon: "title" },
  { id: "@.font_color", icon: "water_drop" },
  { id: "@.font_size", icon: "format_size" },
  { id: "@.font_weight", icon: "format_bold" },
  { id: "@.font_italic", icon: "format_italic" },
  { id: "@.format_text", icon: "text_format" },
  { id: "@.format_null", icon: "circle" },
  { id: "@.format_error", icon: "error" },
  { id: "@.text_h_align", icon: "format_align_left" },
  { id: "@.text_v_align", icon: "vertical_align_top" },
  { id: "@.text_indent", icon: "format_indent_increase" },
  { id: "@.text_wrap", icon: "wrap_text" },
  { id: "@.comment", icon: "comment" },
];

export interface RuleInfo {
  /** Position in the cube's rule list, from 1 — the `#N` in other rules' statuses. */
  number: number;
  channel: string;
  /** `<Unique>`, `Overrides #2, #3`, `Overridden by #8`, or both joined by `; `. */
  status: string;
  /** Number of constrained slots, the `@` slot counted as `value` when the rule names no channel. */
  specificity: number;
  /** `@=value, A=totalgg, B=*` — all dimensions of the cube, `@` first. */
  mask: string;
  tooltip: string;
}

type Mask = (string | null)[];

/** Qt `_normalize_mask`: an implied channel (`null` in the `@` slot) counts as `@.value`, so a rule that names
 *  `@.value` and one that does not compare as equals, as in the engine's `_effective_rule_mask`. */
function normalizeMask(mask: Mask, atSlot: number | null): Mask {
  if (atSlot === null || !mask.length) return mask;
  if (atSlot < mask.length && mask[atSlot] == null) { const m = mask.slice(); m[atSlot] = "at_value"; return m; }
  return mask;
}

/** Qt `_masks_overlap`: can the two masks match the same address? Unknown masks never overlap. */
function masksOverlap(a: Mask, b: Mask): boolean {
  if (!a.length || !b.length) return false;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? null, y = b[i] ?? null;
    if (x !== null && y !== null && x !== y) return false;
  }
  return true;
}

function channelOf(rule: RuleDTO): string {
  for (const t of rule.targets || []) if (Array.isArray(t) && t[0] === "@") return `@.${t[1]}`;
  return "@.value";
}

function maskText(rule: RuleDTO, dimIds: string[] | null, dimName: (id: string) => string): string {
  // Dimension names are case-insensitive in rules: "a.totalgg" is a rule on dimension "A". Show the item as typed.
  const item = new Map<string, { dim: string; item: string }>();
  for (const t of rule.targets || []) if (Array.isArray(t) && t.length === 2) item.set(String(t[0]).toLowerCase(), { dim: String(t[0]), item: String(t[1]) });
  const parts = [`@=${item.get("@")?.item ?? "value"}`];
  if (dimIds) {
    for (const id of dimIds) {
      if (id === "@") continue;
      const name = dimName(id);
      parts.push(`${name}=${item.get(name.toLowerCase())?.item ?? "*"}`);
    }
  } else {
    for (const t of item.values()) if (t.dim !== "@") parts.push(`${t.dim}=${t.item}`);   // Qt without dimension names
  }
  return parts.join(", ");
}

/** Qt `RuleRow` tooltip, word for word. */
export function ruleTooltip(mask: string, specificity: number): string {
  return `Mask: ${mask || "(none)"}\nSpecificity: ${specificity}\n\nPrecedence:\n`
    + "  - More constrained dimensions (higher specificity) win.\n"
    + "  - If specificity ties and rules overlap, later rules override earlier ones.";
}

/** `rules` — the rules of ONE cube in evaluation order (`rule_order`). `dimIds` — the cube's `dimension_ids`, null
 *  until `cube_detail` is loaded (then the `@` slot is assumed to be the first, as the engine puts it, and the mask
 *  lists only the dimensions the rule names). `hasCube` false = rules of all cubes (no active view): no normalisation. */
export function computeRuleInfos(
  rules: RuleDTO[], opts: { dimIds: string[] | null; hasCube: boolean; dimName: (id: string) => string },
): RuleInfo[] {
  let atSlot: number | null = null;
  if (opts.hasCube) {
    if (opts.dimIds) { const i = opts.dimIds.indexOf("@"); atSlot = i < 0 ? null : i; } else atSlot = 0;
  }
  const meta = rules.map((r) => {
    const mask = normalizeMask((r.addr_mask || []) as Mask, atSlot);
    return { cube: r.cube_id, mask, spec: mask.reduce((n, v) => n + (v != null ? 1 : 0), 0) };
  });
  const list = (ns: number[]) => ns.map((n) => `#${n}`).join(", ");

  return rules.map((rule, i) => {
    const me = meta[i];
    let status = "<Unique>";
    if (me.cube) {
      const overrides: number[] = [], overridden: number[] = [];
      meta.forEach((o, j) => {
        if (i === j || o.cube !== me.cube || !masksOverlap(me.mask, o.mask)) return;   // cannot conflict
        if (me.spec > o.spec) overrides.push(j + 1);
        else if (me.spec < o.spec) overridden.push(j + 1);
        else if (i > j) overrides.push(j + 1);            // same specificity: the later rule wins
        else overridden.push(j + 1);
      });
      if (overrides.length && overridden.length) status = `Overrides ${list(overrides)}; Overridden by ${list(overridden)}`;
      else if (overrides.length) status = `Overrides ${list(overrides)}`;
      else if (overridden.length) status = `Overridden by ${list(overridden)}`;
    }
    const mask = maskText(rule, opts.dimIds, opts.dimName);
    return { number: i + 1, channel: channelOf(rule), status, specificity: me.spec, mask, tooltip: ruleTooltip(mask, me.spec) };
  });
}

/** Qt `ChannelFilterBar.on_pill_clicked`. Click: select only this channel, or clear when it is already the only
 *  one. Ctrl/Cmd+click: toggle it in the selection. An empty selection means "all channels". */
export function toggleChannel(selected: ReadonlySet<string>, id: string, multi: boolean): Set<string> {
  const next = new Set(selected);
  if (multi) { if (next.has(id)) next.delete(id); else next.add(id); return next; }
  if (next.size === 1 && next.has(id)) return new Set();
  return new Set([id]);
}
