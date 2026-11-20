import { el, clear } from "../dom";
import type { Store } from "../state";
import type { DockPanelId, DockZoneId } from "../../shared/messages";
import type { DockDrag } from "./dockDrag";

/** Panel ids → captions shown on zone tabs and in the Move-to context menu.
 *  "Rule Panel", not "Rules": the docked panel keeps its own internal
 *  Rules / Calculation Flow / Circular References tabs, and a second bare
 *  "Rules" right next to them reads as a bug, not a hierarchy. */
export const DOCK_PANEL_TITLES: Record<DockPanelId, string> = {
  browser: "Model Browser", info: "Info", format: "Format",
  perf: "Performance", timeline: "Timeline", rules: "Rule Panel",
};

const ZONE_LABEL: Record<DockZoneId, string> = { left: "Left", right: "Right", bottom: "Bottom" };
export const DOCK_ZONES: DockZoneId[] = ["left", "right", "bottom"];

/** `handle` is the panel's own caption the user grabs to drag it: `.dock-header`
 *  for tool panels, the `.lower-tabs` section strip for the Rule Panel. It is a
 *  stable element inside `el` — attach drag/menu listeners once, not per reconcile. */
export interface DockPanelRef { el: HTMLElement; handle: HTMLElement; title: string }

/** One edge zone: panels stacked as tabs. A zone with a single member renders NO tab
 *  strip at all — the panel's own caption (`handle`) is the drag surface, so a lone
 *  panel costs zero extra rows of chrome. With 2+ members the strip appears: it is
 *  the only way to switch between them, and its tabs are the drag handles.
 *  Membership lives in `store.state.layout.dock`; reconcile() rebuilds the strip and
 *  re-slots the panel elements to match. No store.notify() — presentation only. */
export class DockZone {
  readonly el: HTMLElement;
  readonly tabsEl: HTMLElement;
  private bodyEl: HTMLElement;

  constructor(readonly id: DockZoneId, private ctl: DockController) {
    this.el = el("div", { class: `dock-zone dock-${id}` });
    this.tabsEl = el("div", { class: "lower-tabs dock-tabs" });
    this.bodyEl = el("div", { class: "dock-body" });
    this.el.append(this.tabsEl, this.bodyEl);
  }

  /** Tab strip (multi-member zones only) + member elements from `layout.dock[this.id]`. */
  reconcile() {
    const z = this.ctl.store.state.layout.dock[this.id];
    if (!z.active || !z.panels.includes(z.active)) z.active = z.panels[0] ?? null;
    const solo = z.panels.length === 1;
    this.el.classList.toggle("solo", solo);
    this.el.classList.toggle("multi", z.panels.length > 1);
    this.tabsEl.hidden = solo || z.panels.length === 0;
    clear(this.tabsEl);
    if (!solo) for (const p of z.panels) {
      const ref = this.ctl.panels[p];
      if (!ref) continue;   // stale member (e.g. a persisted "rules") — drop its tab
      const active = p === z.active;
      const tab = el("div", {
        class: "lower-tab dock-tab" + (active ? " active" : ""),
        role: "tab",
        tabindex: "0",
        "aria-selected": String(active),
        title: `${ref.title} — drag to another zone, right-click for options`,
      }, [ref.title]);
      tab.addEventListener("click", () => this.ctl.activate(this.id, p));
      tab.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this.ctl.activate(this.id, p); }
      });
      tab.addEventListener("contextmenu", (e) => { e.preventDefault(); this.ctl.panelMenu(e, this.id, p); });
      this.ctl.drag?.attachHandle(tab, p, this.id);
      this.tabsEl.appendChild(tab);
    }
    for (const p of z.panels) {
      const ref = this.ctl.panels[p];
      if (!ref) continue;   // stale member (e.g. a persisted "rules") — not rendered
      const pe = ref.el;
      pe.hidden = p !== z.active;
      this.bodyEl.appendChild(pe);   // re-appends: moves a re-docked panel into this zone
    }
    const empty = z.panels.length === 0;
    this.el.hidden = empty;
    this.el.classList.toggle("empty", empty);
  }
}

/** Owns the three edge zones and the panel-element registry for one .body build. The shell
 *  creates it with freshly rendered panel components; visibility changes and drops funnel
 *  through reconcile(), which is a pure DOM operation — nothing notifiable happens. */
export class DockController {
  readonly zones: Record<DockZoneId, DockZone>;
  drag: DockDrag | null = null;
  /** Shell hook — e.g. expanding the collapsed bottom zone when its tab is clicked. */
  onActivate: ((zone: DockZoneId, panel: DockPanelId) => void) | null = null;

  constructor(readonly store: Store, readonly panels: Partial<Record<DockPanelId, DockPanelRef>>) {
    this.zones = {
      left: new DockZone("left", this),
      right: new DockZone("right", this),
      bottom: new DockZone("bottom", this),
    };
  }

  reconcile() { for (const z of DOCK_ZONES) this.zones[z].reconcile(); }

  /** Wire each panel's own caption (`.dock-header` / rules `.lower-tabs`) as a drag
   *  handle + context-menu source. Call once after `drag` is set — the elements are
   *  stable for the life of the body build, unlike zone tabs which reconcile() rebuilds. */
  attachHandles() {
    for (const p of Object.keys(this.panels) as DockPanelId[]) {
      const ref = this.panels[p];
      if (!ref?.handle) continue;
      ref.handle.classList.add("dock-handle");
      ref.handle.title = `${ref.title} — drag to another zone, right-click for options`;
      this.drag?.attachHandle(ref.handle, p);
      ref.handle.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        const z = this.store.dockPanelZone(p);
        if (z) this.panelMenu(e, z, p);
      });
    }
  }

  /** Show a member's tab (and run the shell's activate hook — collapsed-zone expansion). */
  activate(zone: DockZoneId, panel: DockPanelId) {
    this.store.activateDockTab(zone, panel);
    this.onActivate?.(zone, panel);
    this.reconcile();
  }

  /** Drop / menu target: append the panel as the active tab of `zone` (same-zone = activate). */
  move(panel: DockPanelId, zone: DockZoneId) {
    if (this.store.dockPanelZone(panel) === zone) { this.activate(zone, panel); return; }
    this.store.moveDockPanel(panel, zone);
    this.onActivate?.(zone, panel);
    this.reconcile();
  }

  /** The keyboard / non-pointer path for the same move: a "Move to … Zone" menu on each tab. */
  panelMenu(e: MouseEvent, from: DockZoneId, panel: DockPanelId) {
    document.querySelector(".ctx-menu")?.remove();
    const menu = el("div", { class: "ctx-menu" });
    for (const z of DOCK_ZONES) {
      const item = el("div", { class: "ctx-item" + (z === from ? " disabled" : "") }, [`Move to ${ZONE_LABEL[z]} Zone`]);
      if (z !== from) item.addEventListener("click", () => { menu.remove(); this.move(panel, z); });
      menu.appendChild(item);
    }
    document.body.appendChild(menu);
    menu.style.left = e.clientX + "px";
    menu.style.top = e.clientY + "px";
    const close = (ev: MouseEvent) => {
      if (!menu.contains(ev.target as Node)) { menu.remove(); document.removeEventListener("click", close); }
    };
    setTimeout(() => document.addEventListener("click", close), 0);
  }
}
