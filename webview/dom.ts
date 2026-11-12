/** Minimal DOM helper — keeps components terse and framework-free (web-portable). */
export type Attrs = { [k: string]: any } & { _children?: (Node | string)[] };

/** Tooltip for controls of features outside the first public (MVP) release. Such controls are
 *  shown disabled, not hidden (design-guidelines: "disabled (greyed out), not hidden"). */
export const NOT_IN_MVP_TITLE = "Not available in this preview version";

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, children: (Node | string)[] = []): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "_children") continue;
    if (k === "class") e.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(e.style, v);
    else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "html") e.innerHTML = v;
    else if (v === true) e.setAttribute(k, "");
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const c of (attrs._children || children)) {
    if (c == null) continue;
    e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return e;
}

export function clear(node: HTMLElement) { while (node.firstChild) node.removeChild(node.firstChild); }

export function icon(svg: string): HTMLElement {
  const span = el("span", { class: "tree-icon" });
  span.innerHTML = svg;
  return span;
}

export const ICONS = {
  dim: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="1"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/></svg>`,
  cube: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l9 5v10l-9 5-9-5V7z"/><path d="M12 2v10l9-5"/><path d="M12 12L3 7"/></svg>`,
  view: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="1"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="9" x2="9" y2="21"/></svg>`,
  item: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="12" r="2"/></svg>`,
  twisty: `<svg viewBox="0 0 24 24" width="10" height="10" fill="currentColor"><path d="M8 5l8 7-8 7z"/></svg>`,
};

// ---- Themed tooltip ----
// A native `title` tooltip is drawn by the browser in the colours of the host window, not of the plugin: a light
// plugin theme inside a dark VS Code showed a dark tooltip. This one takes its colours from the theme variables.
let tipEl: HTMLElement | null = null;
let tipTarget: HTMLElement | null = null;
let tipTimer: number | undefined;

function hideTip() {
  clearTimeout(tipTimer);
  tipTimer = undefined;
  tipEl?.remove();
  tipEl = null;
  tipTarget = null;
  document.removeEventListener("mousemove", tipWatch, true);
  document.removeEventListener("mousedown", hideTip, true);
  document.removeEventListener("wheel", hideTip, true);
  document.removeEventListener("scroll", hideTip, true);
  document.removeEventListener("keydown", hideTip, true);
  window.removeEventListener("blur", hideTip);
}

/** While a tooltip is up: hide it as soon as the pointer is no longer over its element (or the element is gone —
 *  a re-render replaces rows without a mouseleave). */
function tipWatch(e: MouseEvent) {
  if (!tipTarget || !tipTarget.isConnected || !tipTarget.contains(e.target as Node)) hideTip();
}

function showTip(target: HTMLElement, x: number, y: number) {
  tipTimer = undefined;
  const text = target.dataset.tooltip;
  if (!text || !target.isConnected) return;
  hideTip();
  const tip = el("div", { class: "om-tooltip", role: "tooltip" }, [text]);
  document.body.appendChild(tip);
  const w = tip.offsetWidth, h = tip.offsetHeight;
  const left = Math.max(4, Math.min(x + 14, window.innerWidth - w - 8));
  let top = y + 18;
  if (top + h > window.innerHeight - 8) top = Math.max(4, y - h - 10);   // no room below: above the pointer
  tip.style.left = left + "px";
  tip.style.top = top + "px";
  tipEl = tip;
  tipTarget = target;
  document.addEventListener("mousemove", tipWatch, true);
  document.addEventListener("mousedown", hideTip, true);
  document.addEventListener("wheel", hideTip, true);
  document.addEventListener("scroll", hideTip, true);
  document.addEventListener("keydown", hideTip, true);
  window.addEventListener("blur", hideTip);
}

/** Shows `text` (line breaks kept) in a themed tooltip after the pointer rests on `target` for `delayMs`.
 *  The text is kept in `data-tooltip`; do not also set `title`, or the native tooltip appears too. */
export function attachTooltip(target: HTMLElement, text: string, delayMs = 500) {
  target.dataset.tooltip = text;
  let x = 0, y = 0;
  target.addEventListener("mouseenter", (e) => {
    x = e.clientX; y = e.clientY;
    clearTimeout(tipTimer);
    tipTimer = window.setTimeout(() => showTip(target, x, y), delayMs);
  });
  target.addEventListener("mousemove", (e) => { x = e.clientX; y = e.clientY; });
  target.addEventListener("mouseleave", () => { if (tipTarget === target || tipTimer !== undefined) hideTip(); });
}
