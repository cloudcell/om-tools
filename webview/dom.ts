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
