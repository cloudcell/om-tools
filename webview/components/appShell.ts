import { Store, AppState, SET_RULE_PLACEHOLDER, ruleBarText, DEFAULT_LAYOUT } from "../state";
import { DEFAULT_DOCK, FEEDBACK_URL, LINKS, type DockLayout, type DockPanelId, type DockZoneId, type UiLayout, type UiTheme } from "../../shared/messages";
import { parseSession, type SessionDescriptor } from "../../shared/session";
import { makeBundle, BUNDLE_MODEL_MEMBER, BUNDLE_EXT } from "../../shared/omz";
import { applyTheme, currentTheme } from "../theme";
import { el, clear, ICONS, NOT_IN_MVP_TITLE } from "../dom";
import { materialIconSvg as msym, brandIconSvg, type MaterialIcon } from "../menuIcons";
import { tipsEnabled, setTipsEnabled, resetTips } from "../tips";
import { startTour } from "../tour";
import { ModelBrowser } from "./modelBrowser";
import { MultilevelGrid } from "./multilevelGrid";
import { RulePanel } from "./rulePanel";
import { StatusBar } from "./statusBar";
import { InfoToolbox } from "./infoToolbox";
import { FormatToolbox } from "./formatToolbox";
import { PerformanceWatch } from "./performanceWatch";
import { inputDialog, confirmDialog, alertDialog, pickDialog, choiceDialog, optionsDialog, browseDialog, examplePickerDialog, shareSessionDialog, type ExampleEntry } from "./dialogs";
import catalogData from "../../shared/catalog.json";
import { Timeline } from "./timeline";
import { ModelActions } from "./modelActions";
import { Splitter } from "./splitter";
import { DockController, DOCK_PANEL_TITLES, DOCK_ZONES, type DockPanelRef } from "./dockZone";
import { ViewArea } from "./viewGroups";
import { DockDrag } from "./dockDrag";

/** `icon` is inline SVG markup; a `checked` item shows a check mark in the icon column instead. */
type DockName = keyof AppState["dockVisible"];

interface MenuItem { label?: string; icon?: string; sep?: boolean; disabled?: boolean; fn?: () => void; submenu?: MenuItem[]; checked?: boolean; title?: string }

/** `YYYYMMDD_HHMMSS`, local time — Qt's default save name is `New_Model_<this>.json`. */
function timestamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Panel limits, px (T-045). The grid keeps at least GRID_MIN_HEIGHT under a tall bottom panel
 *  (styles.css repeats it in `.rule-panel { max-height }` for when the window shrinks). */
const LEFT_MIN = 160;
const BOTTOM_MIN = 60;
const GRID_MIN_HEIGHT = 120;

const DOCK_PANEL_IDS: DockPanelId[] = ["browser", "info", "format", "perf", "timeline", "rules"];
const DOCK_ZONE_IDS: DockZoneId[] = ["left", "right", "bottom"];

/** Bundled example catalog (shared/catalog.json — same file the web host fetches and the
 *  extension's fileParams allowlist is built from). */
const CATALOG: ExampleEntry[] = (catalogData as { examples: ExampleEntry[] }).examples;

/** Saved layout from storage: keep only sane values, the rest falls back to DEFAULT_LAYOUT. */
function sanitizeLayout(raw: unknown): Partial<Required<UiLayout>> {
  const out: Partial<Required<UiLayout>> = {};
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;
  const px = (v: unknown, min: number) => typeof v === "number" && Number.isFinite(v) && v >= min && v < 10000 ? Math.round(v) : undefined;
  const w = px(r.leftDockWidth, LEFT_MIN), rw = px(r.rightDockWidth, LEFT_MIN), h = px(r.rulePanelHeight, BOTTOM_MIN);
  if (w !== undefined) out.leftDockWidth = w;
  if (rw !== undefined) out.rightDockWidth = rw;
  if (h !== undefined) out.rulePanelHeight = h;
  if (typeof r.leftCollapsed === "boolean") out.leftCollapsed = r.leftCollapsed;
  if (typeof r.rightCollapsed === "boolean") out.rightCollapsed = r.rightCollapsed;
  if (typeof r.rulePanelCollapsed === "boolean") out.rulePanelCollapsed = r.rulePanelCollapsed;
  const dock = sanitizeDock(r.dock);
  if (dock) out.dock = dock;
  return out;
}

/** Stored `layout.dock` is user-corruptible: validate field-by-field, drop what is broken,
 *  dedupe panels that ended up in two zones. Returns null when nothing usable remains. */
function sanitizeDock(raw: unknown): DockLayout | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;
  const seen = new Set<DockPanelId>();
  const zone = (z: unknown): { panels: DockPanelId[]; active: DockPanelId | null } | null => {
    if (!z || typeof z !== "object") return null;
    const p = (z as Record<string, unknown>).panels;
    if (!Array.isArray(p)) return null;
    // "rules" is filtered out: it is no longer a dock-zone member (aggregate panes own it).
    const panels = p.filter((x): x is DockPanelId => x !== "rules" && DOCK_PANEL_IDS.includes(x as DockPanelId) && !seen.has(x as DockPanelId));
    panels.forEach((x) => seen.add(x));
    const a = (z as Record<string, unknown>).active;
    const active = panels.includes(a as DockPanelId) ? (a as DockPanelId) : null;
    return { panels, active };
  };
  const left = zone(d.left), right = zone(d.right), bottom = zone(d.bottom);
  if (!left || !right || !bottom) return null;
  const lastZone = { ...DEFAULT_DOCK.lastZone };
  if (d.lastZone && typeof d.lastZone === "object") {
    for (const p of DOCK_PANEL_IDS) {
      const z = (d.lastZone as Record<string, unknown>)[p];
      if (DOCK_ZONE_IDS.includes(z as DockZoneId)) lastZone[p] = z as DockZoneId;
    }
  }
  return { left, right, bottom, lastZone };
}

/** Menu items for features outside the MVP preview: greyed out, not hidden. */
const NOT_IN_MVP: Pick<MenuItem, "disabled" | "title"> = { disabled: true, title: NOT_IN_MVP_TITLE };

/** App shell — assembles the full OM Core GUI layout per om-gui.conf:
 *  menu bar + toolbar (top); left docks (Model Browser, Info, Format);
 *  center view workspace with rule bar; right docks (Performance, Timeline);
 *  bottom rule panel; status bar. Mirrors lib_gui/app.py MainWindow. */
export class AppShell {
  constructor(private store: Store) {
    this.actions = new ModelActions(store);
    // captureSession reads live scroll only for views that are a group's rendered tab.
    store.scrollProbe = (viewId) => {
      const s = store.state;
      if (s.options.docking) {
        const g = s.viewGroups.find((g) => g.activeTab === viewId);
        return g ? this.viewArea?.gridFor(g.id)?.scrollOffsets() ?? null : null;
      }
      return s.activeView?.viewId === viewId ? this.matrixGrid.scrollOffsets() : null;
    };
  }
  private perf: PerformanceWatch | null = null;
  private matrixGrid = new MultilevelGrid(this.store);
  private viewArea: ViewArea | null = null;
  private ruleBarInput: HTMLInputElement | null = null;
  private actions: ModelActions;
  private bodyEl: HTMLElement | null = null;
  private bodyDispose: (() => void) | null = null;

  render(): HTMLElement {
    const app = el("div", { id: "app" });
    // One top row (T-039, stage 2): the toolbar sits inside the menu bar between the menus and the right-hand
    // status / theme controls. Both keep their classes (`.menubar`, `.toolbar`).
    const mb = this.menuBar();
    mb.insertBefore(this.toolbar(), mb.querySelector(".spacer"));
    app.appendChild(mb);
    app.appendChild(this.ruleBar());
    this.bodyEl = el("div", { class: "body" });
    app.appendChild(this.bodyEl);
    app.appendChild(new StatusBar(this.store).render());

    // Saved layout first: panel renders already check whether it is collapsed.
    const layout = this.store.state.layout;
    Object.assign(layout, sanitizeLayout(this.store.api.loadUiState()?.layout));

    this.buildBody();
    // Tools → Options → "Dockable panels" swaps the body between zone and legacy layout.
    // The subscriber is shell-scoped (not captured): it outlives body rebuilds.
    let docked = this.store.state.options.docking;
    this.store.subscribe(() => {
      if (this.store.state.options.docking !== docked) { docked = this.store.state.options.docking; this.buildBody(); }
    });

    this.store.subscribe(() => this.updateTitle());
    this.updateTitle();
    return app;
  }

  /** Build the .body children for the current layout mode. Components subscribe inside render(),
   *  so the whole body is built inside captureSubscriptions() — tearing it down releases every
   *  listener it registered instead of leaking them onto detached DOM. */
  private buildBody() {
    this.bodyDispose?.();
    this.perf?.dispose();
    this.perf = null;
    const docked = this.store.state.options.docking;
    this.bodyEl!.classList.toggle("body-docked", docked);
    const { result, dispose } = this.store.captureSubscriptions(() =>
      docked ? this.buildDockedBody() : this.buildLegacyBody());
    this.bodyDispose = dispose;
    this.bodyEl!.replaceChildren(...result);
  }

  /** Not connected: say what to do about it, in the host's words (VS Code: a button in the side panel). Hidden while connected. */
  private buildEngineHint(): HTMLElement {
    const hint = el("div", { class: "engine-hint", role: "status" });
    const syncHint = () => {
      const s = this.store.state;
      hint.textContent = s.statusHint;
      hint.hidden = s.connected || !s.statusHint;
    };
    this.store.subscribe(syncHint);
    syncHint();
    return hint;
  }

  // ---- Legacy fixed layout (option off): left docks | center | right docks, bottom rule panel ----
  private buildLegacyBody(): HTMLElement[] {
    const layout = this.store.state.layout;
    const saveLayout = () => this.store.saveLayout();

    const docks: Record<Exclude<DockName, "rules">, HTMLElement> = {
      browser: new ModelBrowser(this.store).render(),
      info: new InfoToolbox(this.store).render(),
      format: new FormatToolbox(this.store).render(),
      perf: (this.perf = new PerformanceWatch(this.store)).render(),
      timeline: new Timeline(this.store).render(),
    };

    const left = el("div", { class: "left-docks" });
    left.append(docks.browser, docks.info, docks.format);

    const center = el("div", { class: "center" });
    const rulePanel = new RulePanel(this.store);
    const rulePanelEl = rulePanel.render();

    const right = el("div", { class: "right-docks" });
    right.append(docks.perf, docks.timeline);

    // ---- Resizable, collapsible left column and bottom panel (T-045) ----
    // Sizes change without notify(): the grid would rebuild on every mouse move. Only the bottom
    // panel's collapse/expand notifies, so RulePanel stops / resumes rendering.
    const bodyEl = this.bodyEl!;
    const applyLeft = (size: number, collapsed: boolean) => {
      layout.leftDockWidth = size;
      layout.leftCollapsed = collapsed;
      bodyEl.style.setProperty("--left-dock-width", `${size}px`);
      left.classList.toggle("collapsed", collapsed);
    };
    const applyBottom = (size: number, collapsed: boolean) => {
      const changed = collapsed !== layout.rulePanelCollapsed;
      layout.rulePanelHeight = size;
      layout.rulePanelCollapsed = collapsed;
      bodyEl.style.setProperty("--rule-panel-height", `${size}px`);
      rulePanelEl.classList.toggle("collapsed", collapsed);
      if (changed) this.store.notify();
    };
    const leftMax = () => Math.max(LEFT_MIN, bodyEl.clientWidth * 0.5);
    // The splitter is now a 6px gap between two cards (T-039 stage 3), so its height comes off the room for the grid too.
    let bottomSplitEl: HTMLElement | null = null;   // set below: the Splitter constructor already calls get() (and so bottomMax)
    const bottomMax = (): number => Math.max(BOTTOM_MIN, center.clientHeight - GRID_MIN_HEIGHT - (bottomSplitEl ? bottomSplitEl.offsetHeight : 0));
    const leftSplit = new Splitter({
      axis: "x", grow: 1, min: LEFT_MIN, max: leftMax, defaultSize: DEFAULT_LAYOUT.leftDockWidth,
      collapsedSize: 8, label: "the left panel",
      get: () => ({ size: Math.min(layout.leftDockWidth, leftMax()), collapsed: layout.leftCollapsed }),
      apply: applyLeft, commit: saveLayout,
    });
    const bottomSplit = new Splitter({
      axis: "y", grow: -1, min: BOTTOM_MIN, max: bottomMax, defaultSize: DEFAULT_LAYOUT.rulePanelHeight,
      collapsedSize: 28, label: "the bottom panel",   // the collapsed panel is its 28px tab strip (--tabbar-height)
      get: () => ({ size: Math.min(layout.rulePanelHeight, bottomMax()), collapsed: layout.rulePanelCollapsed }),
      apply: applyBottom, commit: saveLayout,
    });
    applyLeft(layout.leftDockWidth, layout.leftCollapsed);
    bottomSplitEl = bottomSplit.el;
    applyBottom(layout.rulePanelHeight, layout.rulePanelCollapsed);
    // Collapsed bottom panel = its tab row: a tab click opens the panel on that tab,
    // the empty part of the row works like the splitter (drag, or click to open).
    rulePanel.onExpand = () => bottomSplit.setCollapsed(false);
    const tabRow = rulePanelEl.querySelector(".lower-tabs") as HTMLElement;
    tabRow.addEventListener("pointerdown", (e) => {
      if (layout.rulePanelCollapsed && !(e.target as HTMLElement).closest(".lower-tab")) bottomSplit.beginDrag(e, tabRow);
    });

    center.appendChild(this.buildEngineHint());
    this.matrixGrid = new MultilevelGrid(this.store);
    center.appendChild(this.matrixGrid.render());
    center.appendChild(bottomSplit.el);
    center.appendChild(rulePanelEl);

    // View menu toggles flip store.state.dockVisible; show/hide panels to match.
    // A side column with no visible panels is hidden too (with its splitter), so the grid takes the space.
    // Turning a left dock on while the column is collapsed expands the column.
    const prevVis = { ...this.store.state.dockVisible };
    const applyDockVisibility = () => {
      const vis = this.store.state.dockVisible;
      const adv = this.store.state.options.advancedPanels;
      for (const name of Object.keys(docks) as (keyof typeof docks)[]) docks[name].hidden = !vis[name] || ((name === "perf" || name === "timeline") && !adv);
      rulePanelEl.hidden = bottomSplit.el.hidden = !vis.rules;
      left.hidden = !(vis.browser || vis.info || vis.format);
      leftSplit.el.hidden = left.hidden;
      right.hidden = !(vis.perf || vis.timeline);
      const turnedOn = (["browser", "info", "format"] as const).some((n) => vis[n] && !prevVis[n]);
      Object.assign(prevVis, vis);
      if (turnedOn && layout.leftCollapsed) leftSplit.setCollapsed(false);
    };
    this.store.subscribe(applyDockVisibility);
    applyDockVisibility();

    return [left, leftSplit.el, center, right];
  }

  // ---- Quantrix-style docked layout (option on, default): edge zones of tabbed panels ----
  private buildDockedBody(): HTMLElement[] {
    const layout = this.store.state.layout;
    const dock = layout.dock;
    const saveLayout = () => this.store.saveLayout();
    const bodyEl = this.bodyEl!;

    // Visibility derives from zone membership: the dock layout is persisted, dockVisible
    // mirrors it (transient — View menu checkmarks) so an arrangement survives a reload.
    // "rules" is excepted — it is a subpane of each view group, not a dock-zone member.
    const members = new Set<DockPanelId>([...dock.left.panels, ...dock.right.panels, ...dock.bottom.panels]);
    const dv = this.store.state.dockVisible;
    for (const n of Object.keys(dv) as DockName[]) { if (n !== "rules") dv[n] = members.has(n); }

    this.perf = new PerformanceWatch(this.store);
    const toolRef = (el: HTMLElement, title: string): DockPanelRef =>
      ({ el, title, handle: el.querySelector(".dock-header") as HTMLElement });
    const panels: Partial<Record<DockPanelId, DockPanelRef>> = {
      browser: toolRef(new ModelBrowser(this.store).render(), DOCK_PANEL_TITLES.browser),
      info: toolRef(new InfoToolbox(this.store).render(), DOCK_PANEL_TITLES.info),
      format: toolRef(new FormatToolbox(this.store).render(), DOCK_PANEL_TITLES.format),
      perf: toolRef(this.perf.render(), DOCK_PANEL_TITLES.perf),
      timeline: toolRef(new Timeline(this.store).render(), DOCK_PANEL_TITLES.timeline),
    };
    const ctl = new DockController(this.store, panels);
    const zones = ctl.zones;

    const center = el("div", { class: "center" });
    center.appendChild(this.buildEngineHint());
    // The views area: aggregate panes (tab strip + grid + rules subpane) in a split
    // tree — view tabs drag out to pane edges to spawn sibling panes.
    this.viewArea = new ViewArea(this.store);
    center.appendChild(this.viewArea.render());

    // ---- Zone splitters: same mechanics as the legacy columns; the right one is new ----
    const applyLeft = (size: number, collapsed: boolean) => {
      layout.leftDockWidth = size;
      layout.leftCollapsed = collapsed;
      bodyEl.style.setProperty("--left-dock-width", `${size}px`);
      zones.left.el.classList.toggle("collapsed", collapsed);
    };
    const applyRight = (size: number, collapsed: boolean) => {
      layout.rightDockWidth = size;
      layout.rightCollapsed = collapsed;
      bodyEl.style.setProperty("--right-dock-width", `${size}px`);
      zones.right.el.classList.toggle("collapsed", collapsed);
    };
    const applyBottom = (size: number, collapsed: boolean) => {
      const changed = collapsed !== layout.rulePanelCollapsed;
      layout.rulePanelHeight = size;
      layout.rulePanelCollapsed = collapsed;
      bodyEl.style.setProperty("--rule-panel-height", `${size}px`);
      zones.bottom.el.classList.toggle("collapsed", collapsed);
      if (changed) this.store.notify();
    };
    const sideMax = () => Math.max(LEFT_MIN, bodyEl.clientWidth * 0.5);
    const row = el("div", { class: "body-row" });
    let bottomSplitEl: HTMLElement | null = null;
    // The zone lives in .body-docked, NOT inside .center: center shrinks as the zone
    // grows, so max must add the zone's own height back — centerH + zoneH is constant
    // during the gesture. (Was: center.clientHeight alone, undercounting by zoneH.)
    const bottomMax = (): number => Math.max(BOTTOM_MIN, center.clientHeight + zones.bottom.el.offsetHeight - GRID_MIN_HEIGHT - (bottomSplitEl ? bottomSplitEl.offsetHeight : 0));
    const leftSplit = new Splitter({
      axis: "x", grow: 1, min: LEFT_MIN, max: sideMax, defaultSize: DEFAULT_LAYOUT.leftDockWidth,
      collapsedSize: 8, label: "the left panel",
      get: () => ({ size: Math.min(layout.leftDockWidth, sideMax()), collapsed: layout.leftCollapsed }),
      apply: applyLeft, commit: saveLayout,
    });
    const rightSplit = new Splitter({
      axis: "x", grow: -1, min: LEFT_MIN, max: sideMax, defaultSize: DEFAULT_LAYOUT.rightDockWidth,
      collapsedSize: 8, label: "the right panel",
      get: () => ({ size: Math.min(layout.rightDockWidth, sideMax()), collapsed: layout.rightCollapsed }),
      apply: applyRight, commit: saveLayout,
    });
    const bottomSplit = new Splitter({
      axis: "y", grow: -1, min: BOTTOM_MIN, max: bottomMax, defaultSize: DEFAULT_LAYOUT.rulePanelHeight,
      collapsedSize: 28, label: "the bottom panel",   // collapsed = the zone's own tab strip
      // Rendered height while expanded — a stored value that outlived a window resize
      // would otherwise give a wrong drag baseline and snap the sash on the first move.
      get: () => ({ size: layout.rulePanelCollapsed ? layout.rulePanelHeight : (zones.bottom.el.offsetHeight || layout.rulePanelHeight), collapsed: layout.rulePanelCollapsed }),
      apply: applyBottom, commit: saveLayout,
    });
    applyLeft(layout.leftDockWidth, layout.leftCollapsed);
    applyRight(layout.rightDockWidth, layout.rightCollapsed);
    bottomSplitEl = bottomSplit.el;
    applyBottom(layout.rulePanelHeight, layout.rulePanelCollapsed);

    // Collapsed bottom zone shows only its tab strip: a tab click re-opens the zone on that
    // tab (the activate hook), and the strip's empty part drags like the splitter.
    ctl.onActivate = (zone) => { if (zone === "bottom" && layout.rulePanelCollapsed) bottomSplit.setCollapsed(false); };
    zones.bottom.tabsEl.addEventListener("pointerdown", (e) => {
      if (layout.rulePanelCollapsed && !(e.target as HTMLElement).closest(".lower-tab")) bottomSplit.beginDrag(e, zones.bottom.tabsEl);
    });
    // Zone visibility: empty zones (and their splitters) hide so the grid takes the space;
    // a zone that gains members while collapsed expands.
    const syncZoneChrome = () => {
      leftSplit.el.hidden = dock.left.panels.length === 0;
      rightSplit.el.hidden = dock.right.panels.length === 0;
      bottomSplit.el.hidden = dock.bottom.panels.length === 0;
    };

    // Mask experimental panels before the first reconcile — a persisted dock that lists
    // them must not flash them for a frame while the option is off.
    if (!this.store.state.options.advancedPanels) { dv.perf = false; dv.timeline = false; }
    this.store.syncDockMembership();

    // The drag controller must exist before reconcile() — multi-zone tabs are wired there;
    // panel captions (solo-zone handles) are stable elements, wired once here.
    ctl.drag = new DockDrag(ctl, bodyEl);
    ctl.attachHandles();
    ctl.reconcile();
    syncZoneChrome();

    // View-menu toggles flip dockVisible; membership follows (hide → lastZone, show → re-dock).
    // Reconcile only when membership actually changed — a rebuild during a tab drag would
    // detach the tab and kill its pointer capture.
    const applyDockVisibility = () => {
      // Experimental panels have no enabled View-menu path while the option is off —
      // masking the flag makes membership drop them (they re-dock from lastZone on re-show).
      if (!this.store.state.options.advancedPanels) { dv.perf = false; dv.timeline = false; }
      const before = DOCK_ZONE_IDS.map((z) => dock[z].panels.length);
      if (!this.store.syncDockMembership()) return;
      ctl.reconcile();
      syncZoneChrome();
      DOCK_ZONE_IDS.forEach((z, i) => {
        if (before[i] === 0 && dock[z].panels.length > 0) {
          if (z === "left" && layout.leftCollapsed) leftSplit.setCollapsed(false);
          if (z === "right" && layout.rightCollapsed) rightSplit.setCollapsed(false);
          if (z === "bottom" && layout.rulePanelCollapsed) bottomSplit.setCollapsed(false);
        }
      });
    };
    this.store.subscribe(applyDockVisibility);

    // The bottom zone lives inside the center column under the aggregate panes —
    // tool panels docked at the bottom do not underlap the side zones (Qt-style).
    center.appendChild(bottomSplit.el);
    center.appendChild(zones.bottom.el);
    row.append(zones.left.el, leftSplit.el, center, rightSplit.el, zones.right.el);
    return [row];
  }

  dispose() { this.bodyDispose?.(); this.perf?.dispose(); this.perf = null; }

  /** The grid menus/toolbar/keyboard act on: the focused aggregate pane's grid in
   *  docked mode, the single grid in the legacy fixed layout. */
  private focusedGrid(): MultilevelGrid | null {
    return this.store.state.options.docking ? this.viewArea?.focusedGrid() ?? null : this.matrixGrid;
  }

  private lastTitle = "";
  /** Qt `_update_window_title`: `OM Core: *<file>`. In VS Code `document.title` does not reach the editor tab,
   *  so the host sets `panel.title` (`setTitle`; a no-op in the bridge). Sent only when the text changes. */
  private updateTitle() {
    const s = this.store.state;
    const title = `OM Core: ${s.dirty ? "*" : ""}${this.store.fileName()}`;
    if (title === this.lastTitle) return;
    this.lastTitle = title;
    document.title = title;
    this.store.api.setTitle(title).catch(() => {});
  }

  // ---- Menu bar ----
  private menuBar(): HTMLElement {
    const mb = el("div", { class: "menubar", "data-tour": "menubar" });
    // Item lists are produced on each open so checked/disabled states reflect current store state.
    const menus: [string, () => MenuItem[]][] = [
      ["File", () => this.fileMenuItems()],
      ["Edit", () => this.editMenuItems()],
      ["Model", () => this.modelMenuItems()],
      ["View", () => this.viewMenuItems()],
      ["Tools", () => this.toolsMenuItems()],
      ["Window", () => this.windowMenuItems()],
      ["Developer", () => this.devMenuItems()],
      ["Help", () => this.helpMenuItems()],
    ];
    for (const [label, getItems] of menus) {
      const mi = el("div", { class: "menu-item", ...(label === "Help" ? { "data-tour": "help-menu" } : {}) }, [label]);
      let dd = this.buildMenuList(getItems(), "menu-dropdown");
      mi.appendChild(dd);
      const open = () => {
        this.closeAllMenus();
        const fresh = this.buildMenuList(getItems(), "menu-dropdown");
        dd.replaceWith(fresh);
        dd = fresh;
        mi.classList.add("open");
      };
      mi.addEventListener("click", (e) => {
        e.stopPropagation();
        // Clicks inside the dropdown are handled by the entries themselves.
        if (dd.contains(e.target as Node)) return;
        if (mi.classList.contains("open")) this.closeAllMenus();
        else open();
      });
      // Once a menu is open, hovering another top-level item switches to it.
      mi.addEventListener("mouseenter", () => {
        if (mi.classList.contains("open")) return;
        if (!mb.querySelector(".menu-item.open")) return;
        open();
      });
      mb.appendChild(mi);
    }
    // Close open menus on any press outside a top-level item or its dropdown.
    // Capture phase so handlers that stop propagation (grid, tree) can't block it.
    document.addEventListener("mousedown", (e) => {
      const target = e.target as Element | null;
      if (!target?.closest?.(".menubar .menu-item")) this.closeAllMenus();
    }, true);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.closeAllMenus();
    });
    // Capture phase, so the grid's own key handler never sees these combinations.
    document.addEventListener("keydown", (e) => this.onShortcut(e), true);
    window.addEventListener("blur", () => this.closeAllMenus());
    mb.appendChild(el("div", { class: "spacer" }));
    const indicator = el("div", { class: "engine-indicator", "data-tour": "engine-status" }, [
      el("span", { class: "engine-dot" }, []),
      el("span", { class: "engine-text" }, ["disconnected"]),
    ]);
    this.store.subscribe(() => {
      const s = this.store.state;
      const dot = indicator.querySelector(".engine-dot") as HTMLElement;
      const txt = indicator.querySelector(".engine-text") as HTMLElement;
      dot.className = "engine-dot " + (s.connected ? "connected" : s.statusMessage.includes("connect") ? "connecting" : s.statusMessage.includes("error") ? "error" : "");
      // Compact: just "engine" while connected, the address is in the tooltip; other states show their message.
      const full = s.connected ? `engine: ${s.endpoint || "auto"}` : s.statusMessage;
      txt.textContent = s.connected ? "engine" : s.statusMessage;
      indicator.title = full;
    });
    mb.appendChild(this.buildFeedbackControl());
    mb.appendChild(this.buildLinkButtons());
    mb.appendChild(indicator);
    mb.appendChild(this.buildThemeSwitch());
    return mb;
  }

  /** Permanent one-click feedback entry point (speech-bubble icon + "Feedback"), immediately
   *  left of the engine indicator. A real anchor in a browser host — native navigation is the
   *  most reliable way to open a new tab (`window.open` is governed by popup blockers); a
   *  button in the VS Code webview, where the host opens the link via `vscode.env.openExternal`.
   *  No anchor in VS Code on purpose: the webview's own link interception plus our click would
   *  risk opening the page twice. At narrow widths CSS hides the label; the icon stays. */
  private buildFeedbackControl(): HTMLElement {
    const children = [
      el("span", { class: "feedback-icon", html: msym("comment") }),
      el("span", { class: "feedback-label" }, ["Feedback"]),
    ];
    const attrs = {
      class: "feedback-btn",
      title: "Share feedback or suggest an improvement",
      "aria-label": "Feedback — opens GitHub Discussions in your browser",
    };
    return this.store.api.supportsNativeExternalLinks
      ? el("a", { ...attrs, href: FEEDBACK_URL, target: "_blank", rel: "noopener noreferrer" }, children)
      : el("button", { ...attrs, type: "button", onclick: () => { void this.store.api.openFeedback(); } }, children);
  }

  /** Icon-only external links (GitHub repo, Discord, documentation), grouped between Feedback
   *  and the engine indicator. Same host split as Feedback: real anchors in a browser host
   *  (native new-tab navigation, keyboard-focusable, no popup-blocker involvement); buttons
   *  in the VS Code webview that ask the host to open the URL — which it only does when the
   *  URL is one of the fixed `LINKS` destinations. */
  private buildLinkButtons(): HTMLElement {
    const defs: { icon: string; title: string; label: string; url: string }[] = [
      { icon: brandIconSvg("github"), title: "Open Modeling on GitHub", label: "GitHub repository", url: LINKS.github },
      { icon: brandIconSvg("discord"), title: "Open Modeling Discord", label: "Discord community", url: LINKS.discord },
      { icon: msym("menu_book"), title: "Open Modeling documentation", label: "Documentation", url: LINKS.docs },
    ];
    const group = el("div", { class: "link-btns", role: "group", "aria-label": "External links" });
    for (const d of defs) {
      const attrs = {
        class: "link-btn",
        title: d.title,
        "aria-label": `${d.title} — opens in your browser`,
      };
      const children = [el("span", { class: "link-icon", html: d.icon })];
      group.appendChild(
        this.store.api.supportsNativeExternalLinks
          ? el("a", { ...attrs, href: d.url, target: "_blank", rel: "noopener noreferrer" }, children)
          : el("button", { ...attrs, type: "button", onclick: () => { void this.store.api.openExternal(d.url); } }, children));
    }
    return group;
  }

  /** Light / dark switch at the right end of the menu bar (T-039). The choice is saved with the panel sizes. */
  private buildThemeSwitch(): HTMLElement {
    const options: { theme: UiTheme; title: string; icon: MaterialIcon }[] = [
      { theme: "light", title: "Light theme", icon: "light_mode" },
      { theme: "dark", title: "Dark theme", icon: "dark_mode" },
    ];
    const group = el("div", { class: "theme-switch", role: "group", "aria-label": "Theme" });
    const buttons = options.map((o) => el("button", {
      class: "theme-btn", type: "button", title: o.title, "aria-label": o.title, html: msym(o.icon),
      onclick: () => {
        applyTheme(o.theme);
        sync();
        this.store.api.updateUiState({ theme: o.theme });
      },
    }) as HTMLButtonElement);
    const sync = () => {
      const cur = currentTheme();
      buttons.forEach((b, i) => b.setAttribute("aria-pressed", String(options[i].theme === cur)));
    };
    group.append(...buttons);
    sync();
    return group;
  }

  /** Builds a dropdown (or nested submenu) list; submenus open on hover via CSS. */
  private buildMenuList(items: MenuItem[], cls: string): HTMLElement {
    const list = el("div", { class: cls });
    for (const item of items) {
      if (item.sep) { list.appendChild(el("div", { class: "ctx-sep" })); continue; }
      const entryCls = "ctx-item" + (item.disabled ? " disabled" : "") + (item.submenu ? " has-sub" : "");
      const iconCol = el("span", { class: "ctx-icon" });
      if (item.checked) iconCol.appendChild(el("span", { class: "ctx-checkmark" }, ["✓"]));
      else if (item.icon) iconCol.innerHTML = item.icon;
      const entry = el("div", { class: entryCls, title: item.title || item.label || "" }, [
        iconCol,
        el("span", { class: "ctx-label" }, [item.label || ""]),
      ]);
      if (item.submenu) entry.appendChild(this.buildMenuList(item.submenu, "menu-submenu"));
      if (!item.disabled && item.fn) {
        entry.addEventListener("click", (e) => { e.stopPropagation(); item.fn!(); this.closeAllMenus(); });
      }
      list.appendChild(entry);
    }
    return list;
  }

  private closeAllMenus() {
    document.querySelectorAll(".menu-item.open").forEach((m) => m.classList.remove("open"));
  }

  private fileMenuItems(): MenuItem[] {
    return [
      { icon: msym("note_add"), label: "New", fn: () => this.confirmDirty(() => this.store.newWorkspace()) },
      { icon: msym("folder_open"), label: "Open…", fn: () => this.openAny() },
      { icon: msym("grid_on"), label: "Open Example…", fn: () => this.openExample() },
      { sep: true },
      { icon: msym("save"), label: "Save Model (json)…", fn: () => this.saveFile() },
      { icon: msym("save"), label: "Save Workspace (omz)…", fn: () => this.saveWorkspaceBundle() },
      ...(this.store.api.supportsNativeExternalLinks
        ? [{ icon: msym("open_in_new"), label: "Share…", fn: () => this.shareSession() }]
        : []),
      { sep: true },
      { icon: msym("logout"), label: "Quit", fn: () => alertDialog("Quit", "Quit is handled by closing the browser tab or VS Code window.") },
    ];
  }

  /** Window-wide shortcuts, as in Qt (lib_gui/actions.py): Ctrl+Z undo, Ctrl+Y / Ctrl+Shift+Z redo,
   *  F9 recalculate view, Shift+F9 recalculate full model, Ctrl+= Set Rule…, Ctrl+L focus rule bar.
   *  Letters are matched by e.code (physical key), so they also work with a non-Latin layout.
   *  Skipped while a dialog is open or a text field has focus: there the field keeps native
   *  editing (its own Ctrl+Z), and a recalc would rebuild the grid under an open cell editor. */
  private onShortcut(e: KeyboardEvent) {
    if (e.repeat || e.altKey) return;
    if (document.querySelector(".dlg-overlay")) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
    const s = this.store.state;
    const ctrl = e.ctrlKey || e.metaKey;
    let action: (() => void) | null = null;
    if (ctrl && !e.shiftKey && e.code === "KeyZ") action = () => { if (s.canUndo) this.store.undo(); };
    else if (ctrl && ((!e.shiftKey && e.code === "KeyY") || (e.shiftKey && e.code === "KeyZ"))) action = () => { if (s.canRedo) this.store.redo(); };
    else if (!ctrl && !e.shiftKey && e.key === "F9") action = () => this.store.recalc("dirty");
    else if (!ctrl && e.shiftKey && e.key === "F9") action = () => this.store.recalc("all");
    else if (ctrl && !e.shiftKey && (e.code === "Equal" || e.key === "=")) action = () => { if (s.activeView) this.openSetRuleDialog(); };
    else if (ctrl && !e.shiftKey && e.code === "KeyL") action = () => { this.ruleBarInput?.focus(); this.ruleBarInput?.select(); };
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    this.closeAllMenus();
    action();
  }

  private async openSetRuleDialog() {
    const text = await inputDialog("Set Value or Rule", "", SET_RULE_PLACEHOLDER);
    if (text) this.store.applyInput(text);
  }

  private editMenuItems(): MenuItem[] {
    const s = this.store.state;
    return [
      { icon: msym("undo"), label: "Undo" + (s.undoDesc ? ` (${s.undoDesc})` : ""), fn: () => this.store.undo(), disabled: !s.canUndo },
      { icon: msym("redo"), label: "Redo" + (s.redoDesc ? ` (${s.redoDesc})` : ""), fn: () => this.store.redo(), disabled: !s.canRedo },
      { sep: true },
      { icon: msym("content_copy"), label: "Copy", fn: () => this.focusedGrid()?.copyToClipboard(), disabled: !s.activeView },
      { icon: msym("content_paste"), label: "Paste", fn: () => this.focusedGrid()?.pasteFromClipboard(), disabled: !s.activeView },
      { icon: msym("content_paste_go"), label: "Paste as New Cube…", fn: () => this.pasteAsNewCube(), ...NOT_IN_MVP },
      { sep: true },
      { icon: msym("label"), label: "Convert Selection to Dimension Labels…", fn: () => this.convertSelectionToDimLabels(), ...NOT_IN_MVP },
      { icon: msym("new_label"), label: "Assign Item Labels from Selection…", fn: () => this.assignItemLabels(), ...NOT_IN_MVP },
      { icon: msym("delete"), label: "Delete Selected Dimension Items…", fn: () => this.deleteSelectedDimItems() },
      { sep: true },
      // As in Qt: enabled only when the active cell holds an override; clears that cell only.
      { icon: msym("format_clear"), label: "Clear Override", fn: () => this.store.clearActiveOverride(), disabled: this.store.activeCell()?.explain?.source !== "override" },
      { sep: true },
      { icon: msym("function"), label: "Set Rule…", fn: () => this.openSetRuleDialog(), disabled: !s.activeView },
      { label: "Focus Rule Bar", fn: () => this.ruleBarInput?.focus() },
    ];
  }

  private modelMenuItems(): MenuItem[] {
    return [
      { icon: ICONS.dim, label: "New Dimension…", fn: () => this.actions.newDimension() },
      { icon: msym("add"), label: "Create Dimension Item…", fn: () => this.actions.newDimensionItem() },
      { icon: msym("delete"), label: "Delete Dimension…", fn: () => this.actions.deleteDimension() },
      { sep: true },
      { icon: msym("table_rows"), label: "Add Group to Row Dim…", fn: () => this.addGroupToAxis("row"), ...NOT_IN_MVP },
      { icon: msym("view_column"), label: "Add Group to Col Dim…", fn: () => this.addGroupToAxis("col"), ...NOT_IN_MVP },
      { sep: true },
      { icon: ICONS.cube, label: "New Cube…", fn: () => this.actions.newCube() },
      { icon: msym("delete"), label: "Delete Cube…", fn: () => this.actions.deleteCube() },
      { sep: true },
      { icon: msym("link"), label: "Attach Dimension to Cube…", fn: () => this.actions.attachDimension("row"), disabled: !this.store.state.activeView },
      { sep: true },
      { icon: msym("pivot_table_chart"), label: "Edit View Axes…", fn: () => this.editViewAxes() },
      { sep: true },
      { icon: ICONS.view, label: "New View…", fn: () => this.actions.newView() },
    ];
  }

  private viewMenuItems(): MenuItem[] {
    const s = this.store.state;
    const adv = s.options.advancedPanels;
    const gated = (item: MenuItem): MenuItem => adv ? item : { ...item, disabled: true, title: "Enable via Tools → Options → Performance & Timeline panels" };
    return [
      { label: "Model Browser", checked: s.dockVisible.browser, fn: () => this.store.toggleDock("browser") },
      { label: "Info Toolbox", checked: s.dockVisible.info, fn: () => this.store.toggleDock("info") },
      { label: "Format Toolbox", checked: s.dockVisible.format, fn: () => this.store.toggleDock("format"), ...NOT_IN_MVP },
      gated({ label: "Performance Watch", checked: s.dockVisible.perf && adv, fn: () => this.store.toggleDock("perf") }),
      gated({ label: "Timeline", checked: s.dockVisible.timeline && adv, fn: () => this.store.toggleDock("timeline") }),
      // Docked: toggles the focused pane's rules subpane. Legacy: hides the fixed panel.
      { label: "Rule Panel", checked: s.options.docking ? this.store.groupRulesOpen() : s.dockVisible.rules,
        fn: () => { if (s.options.docking) this.store.toggleGroupRules(); else this.store.toggleDock("rules"); } },
      { sep: true },
      { label: "Show System Elements", checked: s.showSystemElements, fn: () => { this.store.state.showSystemElements = !this.store.state.showSystemElements; this.store.notify(); this.store.refreshModel(); } },
      { sep: true },
      { icon: msym("refresh"), label: "Recalculate View (F9)", fn: () => this.store.recalc("dirty") },
      { icon: msym("sync"), label: "Recalculate Full Model (Shift+F9)", fn: () => this.store.recalc("all") },
    ];
  }

  private toolsMenuItems(): MenuItem[] {
    const s = this.store.state;
    return [
      { icon: msym("memory"), label: "Calculation Engine", submenu: [
        { label: "Python (embedded in the runtime)", checked: s.engineType === "python", fn: () => this.store.api.setEngine("python").then(() => { this.store.set({ engineType: "python", isRemote: false }); }) },
        { label: `Remote — ${s.endpoint || "in-browser"}`, checked: s.engineType === "remote", fn: () => this.store.api.setEngine("remote").then(() => { this.store.set({ engineType: "remote", isRemote: true }); }) },
      ], ...NOT_IN_MVP },
      { sep: true },
      { icon: msym("settings"), label: "Options…", fn: () => this.openOptions() },
    ];
  }

  private async openOptions() {
    const result = await optionsDialog(this.store.state.options, () => resetTips());
    if (result) this.store.setOptions(result);
  }

  private windowMenuItems(): MenuItem[] {
    return [
      { icon: msym("open_in_new"), label: "New Window", fn: () => window.open(window.location.href), ...NOT_IN_MVP },
      // window.close() does nothing in a VS Code webview or a tab the user opened, so it is gated too.
      { icon: msym("close"), label: "Close Window", fn: () => window.close(), ...NOT_IN_MVP },
    ];
  }

  private devMenuItems(): MenuItem[] {
    return [
      { icon: msym("bug_report"), label: "GUI Debug Tooltips", fn: () => alertDialog("Debug Tooltips", "Debug tooltips toggle pending."), ...NOT_IN_MVP },
    ];
  }

  private helpMenuItems(): MenuItem[] {
    return [
      // Web host only: the standalone app's welcome.js listens for this event on
      // the same window and reopens the welcome screen (informational, non-gating).
      ...(this.store.api.supportsNativeExternalLinks
        ? [{ icon: msym("water_drop"), label: "Welcome Screen…", fn: () => window.dispatchEvent(new CustomEvent("om-show-welcome")) } as MenuItem]
        : []),
      { icon: msym("menu_book"), label: "Take the Tour…", fn: () => startTour() },
      { icon: msym("info"), label: "Show Tips", checked: tipsEnabled(), fn: () => setTipsEnabled(!tipsEnabled()) },
      { icon: msym("refresh"), label: "Reset Tips…", fn: () => resetTips() },
      { sep: true },
      { icon: msym("info"), label: "About OM Core", fn: () => alertDialog("About OM Core", "OM Core — multidimensional modeling engine GUI.\nVSCode/VSCodium extension connecting to the om-core runtime.\n\nhttps://cloudcell.github.io/om-docs/") },
    ];
  }

  // ---- Toolbar ----
  private toolbar(): HTMLElement {
    const tb = el("div", { class: "toolbar" });
    // Icon-only buttons: aria-label gives them an accessible name (title alone is not reliable).
    const ibtn = (name: MaterialIcon, fn: () => void, title: string) =>
      el("button", { class: "tb-btn", title, "aria-label": title, onclick: fn, html: msym(name) }) as HTMLButtonElement;

    tb.appendChild(ibtn("database", () => this.store.refreshModel().catch(() => {}), "Refresh model"));
    tb.appendChild(ibtn("sync", () => this.store.recalc("all"), "Recalculate (Shift+F9)"));
    tb.appendChild(ibtn("refresh", () => this.store.recalc("dirty"), "Recalculate View (F9)"));
    tb.appendChild(el("span", { class: "tb-sep" }));
    const undoBtn = ibtn("undo", () => this.store.undo(), "Undo");
    const redoBtn = ibtn("redo", () => this.store.redo(), "Redo");
    tb.appendChild(undoBtn);
    tb.appendChild(redoBtn);
    tb.appendChild(el("span", { class: "tb-sep" }));
    const copyBtn = ibtn("content_copy", () => this.focusedGrid()?.copyToClipboard(), "Copy");
    const pasteBtn = ibtn("content_paste", () => this.focusedGrid()?.pasteFromClipboard(), "Paste");
    tb.appendChild(copyBtn);
    tb.appendChild(pasteBtn);
    tb.appendChild(el("span", { class: "tb-sep" }));

    // Same enable rules as the Edit menu.
    const syncEnabled = () => {
      const s = this.store.state;
      undoBtn.disabled = !s.canUndo;
      redoBtn.disabled = !s.canRedo;
      copyBtn.disabled = pasteBtn.disabled = !s.activeView;
    };
    syncEnabled();
    this.store.subscribe(syncEnabled);

    // Formatting is outside the MVP preview: controls stay visible but disabled (handlers kept for later).
    const off = (label: string) => ({ disabled: true, title: `${label} — ${NOT_IN_MVP_TITLE}` });
    // No text labels in the compact row ("Fill", "Font", "Format"): the title of each control names it.

    // Format buttons: one segmented block
    const seg = el("div", { class: "tb-seg" });
    const boldBtn = el("button", { class: "tb-btn", ...off("Bold"), style: { fontWeight: "700" } }, ["B"]);
    boldBtn.addEventListener("click", () => this.store.api.formatBold("selection", true).catch(() => {}));
    seg.appendChild(boldBtn);
    const italicBtn = el("button", { class: "tb-btn", ...off("Italic"), style: { fontStyle: "italic" } }, ["I"]);
    italicBtn.addEventListener("click", () => this.store.api.formatItalic("selection", true).catch(() => {}));
    seg.appendChild(italicBtn);
    const underlineBtn = el("button", { class: "tb-btn", ...off("Underline"), style: { textDecoration: "underline" } }, ["U"]);
    underlineBtn.addEventListener("click", () => this.store.api.formatUnderline("selection", true).catch(() => {}));
    seg.appendChild(underlineBtn);
    tb.appendChild(seg);
    tb.appendChild(el("span", { class: "tb-sep" }));

    // Fill color
    const fillInput = el("input", { class: "tb-color", type: "color", value: "#ffffff", ...off("Fill color") }) as HTMLInputElement;
    fillInput.addEventListener("change", () => this.store.api.formatBgColor("selection", fillInput.value).catch(() => {}));
    tb.appendChild(fillInput);

    // Font color
    const fontInput = el("input", { class: "tb-color", type: "color", value: "#000000", ...off("Font color") }) as HTMLInputElement;
    fontInput.addEventListener("change", () => this.store.api.formatColor("selection", fontInput.value).catch(() => {}));
    tb.appendChild(fontInput);
    tb.appendChild(el("span", { class: "tb-sep" }));

    // Number format
    const fmt = el("select", { class: "tb-select", ...off("Number format") }) as HTMLSelectElement;
    [["general", "General"], ["number", "Number"], ["currency", "Currency"], ["percent", "Percent"], ["scientific", "Scientific"]].forEach(([v, l]) => fmt.appendChild(el("option", { value: v }, [l])));
    fmt.addEventListener("change", () => this.store.api.formatNumberFormat("selection", fmt.value).catch(() => {}));
    tb.appendChild(fmt);

    return tb;
  }

  // ---- Rule bar ----
  private ruleBar(): HTMLElement {
    const bar = el("div", { class: "rule-bar" });
    const nameBox = el("div", { class: "name-box" }, ["—"]);
    const input = el("input", { type: "text", placeholder: "Rule: Dim.Item = expr  •  Cell: =expr or value" }) as HTMLInputElement;
    this.ruleBarInput = input;
    // The bar mirrors the active cell (ruleBarText) whenever the user is not typing in it.
    let shown = "";
    const sync = () => {
      const v = this.store.state.activeView;
      const cell = v && v.selectedRow >= 0 && v.selectedCol >= 0 && v.cells
        ? this.store.cellAtVisual(v, v.selectedRow, v.selectedCol) : undefined;
      const hr = v ? this.store.dataRowIndex(v, v.selectedRow) : -1;
      const hc = v ? this.store.dataColIndex(v, v.selectedCol) : -1;
      nameBox.textContent = v && cell ? `${v.rowHeaders[hr] || ""} / ${v.colHeaders[hc] || ""}` : "—";
      shown = ruleBarText(cell);
      if (document.activeElement !== input) input.value = shown;
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const text = input.value.trim();
        // As in Qt, Enter and Escape hand the keyboard back to the grid. Enter on unchanged text
        // does nothing: re-applying "=expr" shown for a cube rule would turn it into a cell rule.
        if (text && text !== shown.trim()) this.store.applyInput(text);
        this.focusedGrid()?.focusGrid();
      } else if (e.key === "Escape") {
        e.preventDefault();
        input.value = shown;
        this.focusedGrid()?.focusGrid();
      }
    });
    input.addEventListener("blur", sync);
    // `fx` marker inside the field (T-039 stage 2): the wrapper only positions it, the input is unchanged.
    const field = el("div", { class: "rule-field" }, [el("span", { class: "rule-fx", "aria-hidden": "true" }, ["fx"]), input]);
    bar.appendChild(nameBox);
    bar.appendChild(field);
    this.store.subscribe(sync);
    return bar;
  }

  // ---- Menu action implementations ----
  /** Qt `_check_unsaved_changes`: Save / Discard / Cancel, Save is the default. After Save the action goes on
   *  only if the file was actually saved (the dialog was not cancelled and the save did not fail). */
  private async confirmDirty(fn: () => void | Promise<void>) {
    if (this.store.state.dirty) {
      const choice = await choiceDialog("Unsaved Changes", "The current workspace has unsaved changes. Do you want to save them?", [
        { label: "Discard", value: "discard", kind: "destructive" },
        { label: "Cancel", value: "cancel" },
        { label: "Save", value: "save", kind: "primary" },
      ], "save");
      if (choice === null || choice === "cancel") return;
      if (choice === "save" && !(await this.saveFile())) return;
    }
    await fn();
  }

  /** File → Open Example…: pick a bundled example, then load it through the normal
   *  workspace path (`om-example:<id>` is resolved to bytes by each host at its
   *  file-reading boundary). confirmDirty protects unsaved work, loadWorkspaceFile
   *  surfaces failures and resets the UI — same as File → Open. */
  private async openExample() {
    const ex = await examplePickerDialog("Open Example", CATALOG);
    if (!ex) return;
    await this.openExampleById(ex.id);
  }

  /** Open a catalog example by id — used by Open Example… and the guided tour
   *  (which loads a real model to tour against). Same flow as the picker:
   *  .omz session first, plain model load otherwise, confirmDirty protects
   *  unsaved work. */
  async openExampleById(id: string): Promise<void> {
    const ex = CATALOG.find((e) => e.id === id);
    if (!ex) return;
    const ref = `om-example:${ex.id}`;
    // .omz examples carry a saved session — apply it the way File → Open does
    // for a picked bundle; anything unreadable falls back to the model load.
    if (/\.omz$/i.test(ex.file ?? "") && await this.applyBundleSession(ref)) return;
    await this.confirmDirty(() => this.store.loadWorkspaceFile(ref));
  }

  /** Serve an .omz's session member and apply it, as File → Open does for a
   *  picked bundle. Returns true when a session was applied — false means the
   *  caller should fall back to a plain model load (unreadable member, not a
   *  session, unreadable file — never a hard error for an otherwise valid bundle). */
  private async applyBundleSession(path: string): Promise<boolean> {
    const r = await this.store.api.readTextFile(path).catch(() => null);
    if (!r?.text) return false;
    const parsed = parseSession(r.text);
    if (!parsed.ok) return false;
    await this.applySessionDescriptor(parsed.session, path);
    return true;
  }

  /** File → Open…: one dialog for every openable file — a model `.json`/`.msgpack`,
   *  a session `.omsession.json`, or a `.omz` bundle. The file's extension picks the
   *  route; a session route that fails on `.omz` falls back to opening it as a model
   *  (a missing/corrupt session member never blocks a valid bundle). */
  private async openAny() {
    const path = await this.pickWorkspacePath("open");
    if (!path) return;
    if (/\.(omz|omsession\.json)$/i.test(path)) {
      const r = await this.store.api.readTextFile(path).catch(() => null);
      if (r?.text) {
        const parsed = parseSession(r.text);
        if (parsed.ok) { await this.applySessionDescriptor(parsed.session, path); return; }
        if (!/\.omz$/i.test(path)) { await alertDialog("Open Session", parsed.error); return; }
      }
      if (!/\.omz$/i.test(path)) { await alertDialog("Open Session", "Could not read the session file."); return; }
      await this.confirmDirty(() => this.store.loadWorkspaceFile(path));
      return;
    }
    // load_workspace reads only JSON; an .openm script is run by om-core's REPL or `main.py --batch` (T-012, finding 1)
    if (/\.openm$/i.test(path)) {
      await alertDialog("Open Workspace", `"${path.split(/[\\/]/).pop()}" is an OpenM script, not a saved workspace. Open a workspace file (.json) instead. Scripts run in om-core with main.py --batch <file>.`);
      return;
    }
    await this.confirmDirty(() => this.store.loadWorkspaceFile(path));
  }

  /** Load a parsed descriptor's model and overlay its UI state. Public so the web
   *  build's `?session=`/`#session=` bootstrap can drive the same path — a fresh page
   *  is never dirty, so confirmDirty just falls through there. */
  async applySessionDescriptor(session: SessionDescriptor, sessionPath: string | null) {
    await this.confirmDirty(async () => {
      let skips: string[] = [];
      try { skips = await this.store.applySession(session, sessionPath); }
      catch (e: any) { await alertDialog("Open Session", e?.message || String(e)); return; }
      // example-opened fires only on real apply success — errors are swallowed above (F4).
      if (sessionPath?.startsWith("om-example:")) this.store.emitUiEvent("example-opened");
      if (session.theme && session.theme !== currentTheme()) {
        applyTheme(session.theme);
        this.store.api.updateUiState({ theme: session.theme });
      }
      if (skips.length)
        await alertDialog("Session partly applied", skips.slice(0, 8).join("\n") + (skips.length > 8 ? `\n…and ${skips.length - 8} more` : ""));
    });
  }

  /** Write a session descriptor through the host's save dialog (File System Access
   *  on web, native dialog in VS Code; the download fallback announces itself like
   *  Save does). Used by the share dialog's "session file only" action. */
  private async writeSessionJson(json: string) {
    const suggested = this.store.fileName().replace(/\.(json|msgpack|omz)$/i, "") + ".omsession.json";
    const res = await this.store.api.saveTextFile(suggested, json).catch(() => null);
    if (res?.downloaded)
      await alertDialog("Saved to Downloads", "Your browser doesn't support choosing a save location — the session was downloaded to your default Downloads folder.");
  }

  /** Save the current model + session as one .omz zip — the single self-contained
   *  share artifact. The model is serialized live from the engine (so unsaved edits
   *  ride along); the session's model source becomes the bundle's own member. */
  private async bundleBytes(): Promise<{ suggested: string; bytes: Uint8Array } | null> {
    const snap = await this.store.api.serializeWorkspace().catch(() => null);
    if (!snap?.json) {
      await alertDialog("Save Workspace", "This engine cannot serialize the workspace — bundles need an engine that supports it.");
      return null;
    }
    const session = this.store.captureSession(currentTheme());
    session.model = { bundle: BUNDLE_MODEL_MEMBER };
    const bytes = await makeBundle(new TextEncoder().encode(snap.json), JSON.stringify(session, null, 2));
    // Workspace bundles always default to OM_Workspace_<ts>.omz — a fixed
    // name collides on every save and a model-derived name misdescribes
    // the bundle (model + session, not the model file).
    const suggested = `OM_Workspace_${timestamp()}${BUNDLE_EXT}`;
    return { suggested, bytes };
  }

  private async saveWorkspaceBundle() {
    const b = await this.bundleBytes();
    if (!b) return;
    const res = await this.store.api.saveBinaryFile(b.suggested, b.bytes).catch(() => null);
    if (res?.downloaded)
      await alertDialog("Saved to Downloads", "Your browser doesn't support choosing a save location — the bundle was downloaded to your default Downloads folder.");
    if (res) this.store.emitUiEvent("bundle-saved");
  }

  /** File → Share Session… (web build only — the menu item is gated on
   *  supportsNativeExternalLinks): capture the live session and hand it to the
   *  share dialog, which regenerates links/files when the user supplies a public
   *  model URL for an otherwise-local model path. */
  private async shareSession() {
    const session = this.store.captureSession(currentTheme());
    const localModel = session.model.path && !/^https?:\/\//.test(session.model.path)
      ? session.model.path : null;
    const suggested = this.store.fileName().replace(/\.(json|msgpack)$/i, "") + ".omsession.json";
    await shareSessionDialog({
      localModel,
      build: (modelUrl) => {
        if (modelUrl) session.model = { url: modelUrl };
        const json = JSON.stringify(session);
        // b64 must survive a URL hash and JSON can carry unicode names — encode bytes.
        const selfLink = json.length <= 1800
          ? `${location.origin}${location.pathname}#session=${encodeURIComponent(btoa(String.fromCharCode(...new TextEncoder().encode(json))))}`
          : null;
        return { json, selfLink };
      },
      makeLink: (url) => `${location.origin}${location.pathname}?session=${encodeURIComponent(url)}`,
      onDownload: async (json) => {
        // The self-host artifact is an .omz — the session's model pointer becomes
        // the bundle's own member, so the uploaded file needs nothing beside it.
        const snap = await this.store.api.serializeWorkspace().catch(() => null);
        if (!snap?.json) {
          await alertDialog("Share", "This engine cannot serialize the workspace — bundles need an engine that supports it.");
          return;
        }
        const s = JSON.parse(json) as SessionDescriptor;
        s.model = { bundle: BUNDLE_MODEL_MEMBER };
        const bytes = await makeBundle(new TextEncoder().encode(snap.json), JSON.stringify(s, null, 2));
        const res = await this.store.api.saveBinaryFile(suggested.replace(/\.omsession\.json$/i, "") + BUNDLE_EXT, bytes).catch(() => null);
        if (res?.downloaded)
          await alertDialog("Saved to Downloads", "Your browser doesn't support choosing a save location — the bundle was downloaded to your default Downloads folder.");
      },
      onDownloadSession: (json) => this.writeSessionJson(json),
    });
  }



  /** Qt `_on_save`: always asks for the path (prefilled), appends `.json` when missing. Returns true when saved. */
  private async saveFile(): Promise<boolean> {
    const path = await this.pickWorkspacePath("save");
    return path ? this.store.saveWorkspace(path) : false;
  }

  /** A workspace file path from the user, or null when cancelled. The runtime reads and writes the file
   *  itself, so only the path is needed. VS Code: the native dialog, shown by the extension host.
   *  Browser: no API returns a file path, so a text field prefilled with an absolute path. */
  private async pickWorkspacePath(mode: "open" | "save"): Promise<string | null> {
    const s = this.store.state;
    const defaultName = `New_Model_${timestamp()}.json`;
    let path: string | null;
    if (s.nativeFileDialogs) {
      try { path = (await this.store.api.pickFile({ mode, current: s.filePath, defaultName })).path; }
      catch (e: any) { await alertDialog(mode === "save" ? "Save failed" : "Load failed", e?.message || String(e)); return null; }
    } else if (s.serverFileBrowse) {
      const fileDir = s.filePath ? s.filePath.replace(/[\\/][^\\/]*$/, "") : "";
      try {
        path = await browseDialog({
          title: mode === "save" ? "Save Workspace" : "Open Workspace",
          api: this.store.api, mode,
          startDir: fileDir || s.defaultDir || "/",
          defaultName: mode === "save" ? defaultName : undefined,
        });
      } catch (e: any) { await alertDialog(mode === "save" ? "Save failed" : "Load failed", e?.message || String(e)); return null; }
    } else {
      const dir = s.defaultDir.replace(/[\\/]+$/, "");
      const sep = dir.includes("\\") ? "\\" : "/";
      const prefill = s.filePath || (dir ? dir + sep + (mode === "save" ? defaultName : "") : mode === "save" ? defaultName : "");
      path = await inputDialog(mode === "save" ? "Save Workspace" : "Open Workspace", prefill, "File path");
    }
    path = path?.trim() || null;
    if (path && mode === "save" && !/\.json$/i.test(path)) path += ".json";
    return path;
  }

  private async addGroupToAxis(axis: "row" | "col") {
    const v = this.store.state.activeView;
    if (!v) { await alertDialog("No Active View", "Open a view first."); return; }
    const dimIds = axis === "row" ? v.rowDimIds : v.colDimIds;
    if (!dimIds.length) { await alertDialog("No Dimensions", `No dimensions on the ${axis} axis.`); return; }
    let dimId = dimIds[0];
    if (dimIds.length > 1) {
      const dimNames = dimIds.map((id) => this.store.dimName(id));
      const chosen = await pickDialog("Which dimension to group?", dimNames);
      if (!chosen) return;
      const dim = this.store.state.dimensions.find((d) => d.name === chosen.trim());
      if (!dim) { await alertDialog("Not Found", "Dimension not found."); return; }
      dimId = dim.id;
    }
    const label = await inputDialog("Add Group", "", "Group name");
    if (!label || !label.trim()) return;
    console.log("[addGroupToAxis] creating group", { dimId, label: label.trim() });
    try {
      const r = await this.store.api.createGroup(dimId, label.trim());
      console.log("[addGroupToAxis] group created:", r);
      this.store.markDirty();
      this.store.invalidateDimCache(dimId);
      this.store.loadView(v.viewId);
      this.store.refreshModel();
    } catch (e: any) { await alertDialog("Create Group Failed", e?.message || String(e)); }
  }

  private async editViewAxes() {
    const v = this.store.state.activeView;
    if (!v) { await alertDialog("No Active View", "Open a view first."); return; }
    // Qt `_on_edit_view_axes`: only the view's cube dimensions, current row / column preselected
    let cubeDimIds: string[] = [];
    try { cubeDimIds = ((await this.store.api.cubeDetail(v.cubeId))?.dimension_ids || []).filter((d: string) => d !== "@"); }
    catch (e: any) { await alertDialog("Edit View Axes", e?.message || String(e)); return; }
    const dims = cubeDimIds.map((id) => this.store.state.dimensions.find((d) => d.id === id)).filter(Boolean) as { id: string; name: string }[];
    if (dims.length < 2) { await alertDialog("Edit View Axes", "Cube needs at least 2 dimensions."); return; }
    const dimNames = dims.map((d) => d.name);
    const at = (id: string | undefined) => Math.max(0, dims.findIndex((d) => d.id === id));
    const rowName = await pickDialog("Row Dimension", dimNames, at(v.rowDimIds[0]));
    if (!rowName) return;
    const rowDim = dims.find((d) => d.name === rowName.trim());
    if (!rowDim) return;
    const colName = await pickDialog("Column Dimension", dimNames, at(v.colDimIds[0]));
    if (!colName) return;
    const colDim = dims.find((d) => d.name === colName.trim());
    if (!colDim) return;
    try { await this.store.api.setViewAxes(v.viewId, rowDim.id, colDim.id); this.store.markDirty(); this.store.loadView(v.viewId); }
    catch (e: any) { await alertDialog("Failed", e?.message || String(e)); }
  }

  private async pasteAsNewCube() { await alertDialog("Paste as New Cube", "Requires clipboard data with row/col dimension structure."); }
  private async convertSelectionToDimLabels() { await alertDialog("Convert Selection", "Select cells first, then use this."); }
  private async assignItemLabels() { await alertDialog("Assign Item Labels", "Select rows/columns first."); }

  /** Qt `_on_delete_selected_dimension_items`: a whole row-header or
   *  column-header selection resolves to leaf items of that axis' first
   *  dimension (item_id = the key's last element, like Qt's `key[-1]`).
   *  Anything else — cell selection, non-leaf rows — refuses with the Qt
   *  warning text. Then the Qt `_confirm_and_delete_dimension_items` flow:
   *  impact query → item/cube/rule counts → confirm → delete. */
  private async deleteSelectedDimItems() {
    const v = this.store.state.activeView;
    let dimId: string | null = null;
    const itemIds: string[] = [];
    if (v && v.selMode === "row" && v.rowDimIds.length) {
      dimId = v.rowDimIds[0];
      for (const i of [...(v.selIndices as Set<number>)].sort((a, b) => a - b)) {
        const dr = this.store.dataRowIndex(v, i);
        if (dr < 0 || dr >= v.rowKeys.length) { dimId = null; break; }
        const key = v.rowKeys[dr];
        if (!key.length) { dimId = null; break; }
        itemIds.push(key[key.length - 1]);
      }
    } else if (v && v.selMode === "col" && v.colDimIds.length) {
      dimId = v.colDimIds[0];
      for (const i of [...(v.selIndices as Set<number>)].sort((a, b) => a - b)) {
        const dc = this.store.dataColIndex(v, i);
        if (dc < 0 || dc >= v.colKeys.length) { dimId = null; break; }
        const key = v.colKeys[dc];
        if (!key.length) { dimId = null; break; }
        itemIds.push(key[key.length - 1]);
      }
    }
    if (!dimId || !itemIds.length) {
      await alertDialog("Delete Dimension Items", "Select row headers or column headers in the active view to delete their dimension items.");
      return;
    }

    let impact;
    try { impact = await this.store.api.dimensionItemDeletionImpact(dimId, itemIds); }
    catch (e: any) { await alertDialog("Delete Dimension Items", e?.message || String(e)); return; }
    const deleteIds = impact.item_ids ?? [];
    if (!deleteIds.length) {
      await alertDialog("Delete Dimension Items", "No dimension items are selected for deletion.");
      return;
    }

    const names = impact.item_names ?? [];
    let itemLines = names.slice(0, 12).map((n) => `- ${n}`).join("\n");
    if (names.length > 12) itemLines += `\n- … and ${names.length - 12} more`;
    const cubeLines = (impact.impacted_cubes ?? []).map((c) => `- ${c.cube_name}: ${c.data_cell_count} data cells`).join("\n") || "- No stored data cells found";
    const ruleLines = (impact.total_affected_rules ?? 0) > 0
      ? `- Anchored rules: ${impact.affected_anchored_rules}\n- Rules: ${impact.affected_rules}`
      : "- No rules will be affected";
    const message =
      `Delete ${deleteIds.length} item(s) from dimension '${impact.dim_name}'?\n\n` +
      `Items:\n${itemLines}\n\n` +
      `Affected cubes (${impact.cube_count}) and data cells to be deleted (${impact.total_data_cell_count} total):\n${cubeLines}\n\n` +
      `Rules to be affected (${impact.total_affected_rules} total):\n${ruleLines}\n\n` +
      `Note: Rules referencing deleted items will show #REF! errors.`;
    if (!(await confirmDialog("Delete Dimension Items", message, "Delete", true))) return;

    try { await this.store.api.deleteDimensionItems(dimId, deleteIds); }
    catch (e: any) { await alertDialog("Delete Dimension Items", e?.message || String(e)); return; }
    // Qt refreshes every view whose cube uses the dim — the deleted items
    // may appear on any loaded view, so reload all of them.
    await this.store.afterStructureChange();
    for (const vid of Object.keys(this.store.state.viewStates)) {
      if (vid !== this.store.state.activeView?.viewId) await this.store.loadView(vid);
    }
  }
}
