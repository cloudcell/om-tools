import { el } from "../dom";
import type { Store, AreaNode } from "../state";
import { MultilevelGrid } from "./multilevelGrid";
import { RulePanel } from "./rulePanel";
import { Splitter } from "./splitter";
import { ViewTabDrag } from "./viewTabDrag";

/** The views area: a split tree of aggregate panes. Each pane is ONE unit — a view
 *  tab strip, the grid for its active tab, and its own rules subpane (collapsible
 *  via the pane separator, completely hidable via the ✕ on its strip or the "Rules"
 *  toggle in the tab bar). Dragging a view tab onto a pane edge splits that pane
 *  (viewTabDrag → store.moveTab rewrites state.viewArea).
 *
 *  The tree is rebuilt ONLY when the group structure changes (signature compare) —
 *  grids and rule panels keep living DOM/subscriptions across ordinary notifies. */
export class ViewArea {
  private root = el("div", { class: "view-area", "data-tour": "view-area" });
  private grids = new Map<string, MultilevelGrid>();
  private drag: ViewTabDrag;
  private sig = "";
  private subsDispose: (() => void) | null = null;

  constructor(private store: Store) {
    this.drag = new ViewTabDrag(store);
  }

  render(): HTMLElement {
    this.rebuild();
    this.store.subscribe(() => this.onNotify());
    return this.root;
  }

  /** Menu/toolbar/keyboard actions act on the focused pane's grid. */
  focusedGrid(): MultilevelGrid | null {
    return this.grids.get(this.store.state.focusedGroup) ?? null;
  }

  gridFor(gid: string): MultilevelGrid | null { return this.grids.get(gid) ?? null; }

  /** What requires a pane rebuild: group membership of the tree + each pane's
   *  rulesOpen flag. Sizes, active tabs and view data do NOT (panes self-refresh). */
  private treeSig(n: AreaNode): string {
    if (n.kind === "group") return `g:${n.gid}:${this.store.group(n.gid)?.rulesOpen ? 1 : 0}`;
    return `s:${n.dir}(${n.children.map((c) => this.treeSig(c)).join(",")})`;
  }

  private onNotify() {
    const s = this.treeSig(this.store.state.viewArea);
    if (s !== this.sig) { this.rebuild(); return; }
    this.markFocused();
  }

  private rebuild() {
    this.sig = this.treeSig(this.store.state.viewArea);
    this.subsDispose?.();
    this.grids.clear();
    const { result, dispose } = this.store.captureSubscriptions(() => this.build(this.store.state.viewArea));
    this.subsDispose = dispose;
    this.root.replaceChildren(result);
    this.markFocused();
  }

  private markFocused() {
    this.root.querySelectorAll<HTMLElement>(".va-group").forEach((e) => {
      e.classList.toggle("focused", e.dataset.gid === this.store.state.focusedGroup);
    });
  }

  private build(node: AreaNode): HTMLElement {
    if (node.kind === "group") return this.buildGroup(node.gid);
    const wrap = el("div", { class: `va-split va-split-${node.dir}` });
    node.children.forEach((child, i) => {
      const cel = this.build(child);
      const w = node.sizes[i];
      cel.style.flex = `${Number.isFinite(w) && w > 0 ? w : 1} 1 0`;
      wrap.appendChild(cel);
      if (i < node.children.length - 1) wrap.appendChild(this.divider(node, i));
    });
    return wrap;
  }

  /** Sash between split siblings: drags shift flex-grow weight between neighbours
   *  (runtime-only state — no notify, no persistence; splits are session state). */
  private divider(node: Extract<AreaNode, { kind: "split" }>, i: number): HTMLElement {
    const d = el("div", { class: `va-divider va-divider-${node.dir}` });
    d.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const parent = d.parentElement!;
      const horizontal = node.dir === "x";
      const total = (horizontal ? parent.clientWidth : parent.clientHeight) - (node.children.length - 1) * (horizontal ? d.offsetWidth : d.offsetHeight);
      const start = horizontal ? e.clientX : e.clientY;
      // Heal sizes a previously-broken gesture may have left non-finite (a NaN/±Infinity
      // weight renders the pane collapsed and freezes every later drag).
      if (!Number.isFinite(node.sizes[i]) || node.sizes[i] <= 0) node.sizes[i] = 1;
      if (!Number.isFinite(node.sizes[i + 1]) || node.sizes[i + 1] <= 0) node.sizes[i + 1] = 1;
      const w0 = node.sizes[i], w1 = node.sizes[i + 1];
      const pxPerGrow = total / (w0 + w1);
      if (!Number.isFinite(pxPerGrow) || pxPerGrow <= 0) return;
      const min = Math.min(80 / pxPerGrow, (w0 + w1) / 2);
      const kids = [...parent.querySelectorAll<HTMLElement>(":scope > :not(.va-divider)")];
      kids[i].style.flexGrow = String(w0);
      kids[i + 1].style.flexGrow = String(w1);
      const onMove = (ev: PointerEvent) => {
        const delta = ((horizontal ? ev.clientX : ev.clientY) - start) / pxPerGrow;
        const a = Math.min(Math.max(min, w0 + delta), w0 + w1 - min);
        if (!Number.isFinite(a)) return;
        node.sizes[i] = a;
        node.sizes[i + 1] = w0 + w1 - a;
        kids[i].style.flexGrow = String(node.sizes[i]);
        kids[i + 1].style.flexGrow = String(node.sizes[i + 1]);
      };
      const done = () => {
        window.removeEventListener("pointermove", onMove, true);
        window.removeEventListener("pointerup", done, true);
        window.removeEventListener("pointercancel", done, true);
      };
      window.addEventListener("pointermove", onMove, true);
      window.addEventListener("pointerup", done, true);
      window.addEventListener("pointercancel", done, true);
    });
    return d;
  }

  /** One aggregate pane: MultilevelGrid (renders this group's tab strip + matrix)
   *  over its own rules subpane behind a pane separator. */
  private buildGroup(gid: string): HTMLElement {
    const pane = el("div", { class: "va-group", "data-gid": gid });
    pane.addEventListener("pointerdown", () => this.store.focusGroup(gid), true);
    const g = this.store.group(gid);
    if (!g) return pane;

    const grid = new MultilevelGrid(this.store, gid);
    grid.onViewTab = (t, viewId) => this.drag.attach(t, viewId);
    this.grids.set(gid, grid);
    pane.appendChild(grid.render());

    if (g.rulesOpen) {
      const rp = new RulePanel(this.store, gid);
      const rules = rp.render();
      rules.classList.add("va-rules");
      rules.dataset.tour = "rules";
      const layout = this.store.state.layout;
      const sep = new Splitter({
        axis: "y", grow: -1, min: 60, collapsedSize: 28,
        max: () => Math.max(60, pane.clientHeight - 160),
        defaultSize: 200, label: "the rules pane",
        // Rendered height while expanded: the stored value can disagree with what is on
        // screen (CSS max-height cap, a stale share) and a wrong start size makes the
        // sash jump on the first move — the "leads/lags the pointer" symptom.
        get: () => ({
          size: g.rulesCollapsed ? (g.rulesH ?? layout.rulePanelHeight) : (rules.offsetHeight || g.rulesH || layout.rulePanelHeight),
          collapsed: g.rulesCollapsed,
        }),
        apply: (size, collapsed) => {
          const changed = collapsed !== g.rulesCollapsed;
          g.rulesH = size;
          g.rulesCollapsed = collapsed;
          rules.style.height = collapsed ? "28px" : `${size}px`;
          rules.classList.toggle("collapsed", collapsed);
          if (changed) this.store.notify();
        },
        commit: () => this.store.saveLayout(),
      });
      rp.onExpand = () => sep.setCollapsed(false);
      // Like the legacy bottom panel: the collapsed strip itself is the drag handle —
      // dragging it up re-opens the subpane under the mouse (the 5px sash also works).
      const tabRow = rules.querySelector(".lower-tabs") as HTMLElement | null;
      tabRow?.addEventListener("pointerdown", (e) => {
        if (g.rulesCollapsed && !(e.target as HTMLElement).closest(".lower-tab")) sep.beginDrag(e, tabRow);
      });
      rules.style.height = g.rulesCollapsed ? "28px" : `${g.rulesH ?? layout.rulePanelHeight}px`;
      rules.classList.toggle("collapsed", g.rulesCollapsed);
      pane.appendChild(sep.el);
      pane.appendChild(rules);
    }
    return pane;
  }
}
