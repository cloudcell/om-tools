import { OmApi, DimSummary, DimDetail, CubeSummary, ViewSummary, ViewDetail, CellRangeDTO, RuleDTO, WorkspaceSummary, CellDTO } from "./api";
import { formatCellValue } from "./formatting";
import { alertDialog } from "./components/dialogs";
import { DEFAULT_DOCK, DEFAULT_OPTIONS, type DockPanelId, type DockZoneId, type UiLayout, type UiOptions } from "../shared/messages";
import { SESSION_SCHEMA, sessionModelKind, type SessionAreaNode, type SessionDescriptor, type SessionViewState } from "../shared/session";

/** Default panel sizes, px (T-045); same as the CSS variables in styles.css. */
export const DEFAULT_LAYOUT: Required<UiLayout> = {
  leftDockWidth: 250, leftCollapsed: false, rightDockWidth: 280, rightCollapsed: false,
  rulePanelHeight: 200, rulePanelCollapsed: false, dock: DEFAULT_DOCK,
};

export type SelMode = "cell" | "row" | "col" | "all";

export interface ViewState {
  viewId: string;
  viewName: string;
  cubeId: string;
  rowDimIds: string[];
  colDimIds: string[];
  pageDimIds: string[];
  pageSelections: Record<string, string>;
  rowKeys: string[][];
  colKeys: string[][];
  rowHeaders: string[];
  colHeaders: string[];
  cells: CellRangeDTO | null;
  /** Visual grid row/col index -> cell-data index, published by MultilevelGrid.buildGrid.
   *  -1 = group/placeholder entry with no cell data. Selection state below is in VISUAL
   *  grid coordinates; translate through these maps before indexing cells/rowKeys/colKeys
   *  (Qt does the same via _leaf_row_index). Absent on flat grids -> identity map. */
  cellRowMap?: number[];
  cellColMap?: number[];
  selectedRow: number;
  selectedCol: number;
  selMode: SelMode;
  selIndices: Set<any>;
  anchorRow: number;
  anchorCol: number;
  /** Per-view column pixel widths (col_index → px), persisted by the engine. */
  colWidths: Record<number, number>;
  /** Per-view row-header level pixel widths (depth_or_index → px). */
  rowHeaderWidths: Record<number, number>;
  loading: boolean;
}

/** One aggregate pane: a view tab strip + grid + optional rules subpane. A view lives
 *  in exactly one group at a time (dragging it out moves it, like VS Code). */
export interface ViewGroupState {
  id: string;
  tabs: { viewId: string; viewName: string }[];
  activeTab: string | null;
  /** The pane's rules subpane is completely hidable — this is that hide flag. */
  rulesOpen: boolean;
  /** rules subpane collapsed to just its section strip (pane separator). */
  rulesCollapsed: boolean;
  /** rules subpane height in px (session state — each pane owns its own, like split sizes). */
  rulesH?: number;
  /** The pane's lower-panel tab ("rules" | "calcflow" | "circrefs") — per-pane,
   *  unset groups fall back to the shared state.rulesTab default. */
  rulesTab?: string;
}

/** Where a dropped view tab lands relative to its target pane. */
export type AreaSide = "left" | "right" | "top" | "bottom" | "center";

/** Split tree for the views area: leaves are group panes, inner nodes tile children. */
export type AreaNode =
  | { kind: "group"; gid: string }
  | { kind: "split"; dir: "x" | "y"; sizes: number[]; children: AreaNode[] };

export interface AppState {
  connected: boolean;
  statusMessage: string;
  /** What the host says to do about a lost connection ("" when connected or none given); shown as a banner. */
  statusHint: string;
  showSystemElements: boolean;
  endpoint: string;
  dimensions: DimSummary[];
  cubes: CubeSummary[];
  views: ViewSummary[];
  workspaceSummary: WorkspaceSummary | null;
  rules: RuleDTO[];
  ruleOrder: string[];
  activeView: ViewState | null;
  openTabs: { viewId: string; viewName: string }[];
  activeTab: string | null;
  focusPath: string;
  selectionStats: Record<string, any>;
  /** Status-bar stats widget: which metrics render (Qt _selection_stats_actions).
   *  In-memory like Qt; empty set == "None" checked. */
  statsMetrics: Set<"selcount" | "count" | "counta" | "sum" | "avg" | "min" | "max">;
  statsSci: boolean;
  dirty: boolean;
  filePath: string | null;
  /** From the host config: native Open/Save dialogs (VS Code) or a text field (browser). */
  nativeFileDialogs: boolean;
  /** Host answers `fsList` (bridge): Open/Save use a server-side file-browser dialog. */
  serverFileBrowse: boolean;
  /** From the host config: absolute folder for default file paths in the text field. */
  defaultDir: string;
  /** Connected engine's build string (status-bar version chip); "" when unknown. */
  engineVersion: string;
  /** Host extension's build string; "" when the host isn't the VS Code extension. */
  extVersion: string;
  /** Host repo's full commit sha (om-tools-web on web, om-tools in the
   *  extension) — drives the `git` element in the status bar. */
  hostGitSha: string;
  /** TS runtime's build string; "" when the backend can't report one. */
  tsRuntimeVersion: string;
  canUndo: boolean;
  canRedo: boolean;
  undoDesc: string;
  redoDesc: string;
  engineType: string;
  depTrackingEnabled: boolean;
  /** Edits seen on command.*.succeeded while depTrackingEnabled was false —
   *  the status-bar pill's "·N pending" count. Client-side and approximate. */
  pendingEditsWhileUntracked: number;
  /** Bumped when a refetch flips depTrackingEnabled and the change did not
   *  originate from this client's own toggle — the pill flashes on change. */
  depTrackingFlipSeq: number;
  mtEnabled: boolean;
  isRemote: boolean;
  dockVisible: { browser: boolean; info: boolean; format: boolean; perf: boolean; timeline: boolean; rules: boolean };
  /** Shared lower panel's active tab ("rules" | "calcflow" | "circrefs") — session-restored. */
  rulesTab: string;
  /** Aggregate panes (Quantrix editor groups): each group owns a tab list, an active
   *  tab and its own rules subpane. `openTabs`/`activeTab`/`activeView` remain the
   *  FOCUSED group's mirrors — kept in sync by syncViewMirror() so unscoped readers
   *  (menus, status bar, actions) never need to know about groups. */
  viewGroups: ViewGroupState[];
  /** Loaded ViewState keyed by viewId — two panes can show different views at once. */
  viewStates: Record<string, ViewState>;
  focusedGroup: string;
  /** Split tree describing how group panes tile the views area (runtime only). */
  viewArea: AreaNode;
  /** Left column / bottom panel sizes and collapsed state (T-045). Sizes change without notify() while
   *  dragging; notify() only when a panel collapses or expands. Persisted via api.saveUiState. */
  layout: Required<UiLayout>;
  /** Display options (Tools → Options). Persisted via api.saveUiState. */
  options: Required<UiOptions>;
}

type Listener = () => void;

export class Store {
  state: AppState = {
    connected: false,
    statusMessage: "disconnected",
    statusHint: "",
    showSystemElements: false,
    endpoint: "",
    dimensions: [],
    cubes: [],
    views: [],
    workspaceSummary: null,
    rules: [],
    ruleOrder: [],
    activeView: null,
    openTabs: [],
    activeTab: null,
    focusPath: "OM Core",
    selectionStats: {},
    statsMetrics: new Set(["avg", "sum"]),   // Qt default: Average and Sum enabled
    statsSci: false,
    dirty: false,
    filePath: null,
    nativeFileDialogs: false,
    serverFileBrowse: false,
    defaultDir: "",
    engineVersion: "",
    extVersion: "",
    hostGitSha: "",
    tsRuntimeVersion: "",
    canUndo: false,
    canRedo: false,
    undoDesc: "",
    redoDesc: "",
    engineType: "python",
    depTrackingEnabled: true,
    pendingEditsWhileUntracked: 0,
    depTrackingFlipSeq: 0,
    mtEnabled: false,
    isRemote: false,
    // perf/timeline are outside the MVP (their View menu items are disabled), so start hidden.
    dockVisible: { browser: true, info: false, format: false, perf: false, timeline: false, rules: true },
    rulesTab: "rules",
    viewGroups: [{ id: "g0", tabs: [], activeTab: null, rulesOpen: true, rulesCollapsed: false }],
    viewStates: {},
    focusedGroup: "g0",
    viewArea: { kind: "group", gid: "g0" },
    layout: { ...DEFAULT_LAYOUT, dock: structuredClone(DEFAULT_DOCK) },
    options: { ...DEFAULT_OPTIONS },
  };
  api: OmApi;
  private listeners = new Set<Listener>();
  private uiEventListeners = new Set<(name: string) => void>();
  /** Set for the whole duration of applySession — restored panes/tabs/subpanes are not
   *  "first use". UI-event subscribers check it to suppress tips mid-restore (T-tips). */
  private restoring = false;
  isRestoring() { return this.restoring; }
  /** Why the in-flight notify() is running — a subscriber whose rebuild is expensive,
   *  or whose DOM may be the target of a press in progress, can skip a reason that
   *  cannot change what it renders. "focus" = only focusedGroup moved. Rebuilding
   *  the press target mid-gesture makes browsers retarget the rest of the gesture
   *  (mousedown/click) to a live ancestor, losing the cell/header hit. */
  notifyReason: string | null = null;
  dimCache = new Map<string, DimDetail>();
  cubeCache = new Map<string, any>();

  constructor(api: OmApi) {
    this.api = api;
    this.state.options = { ...DEFAULT_OPTIONS, ...(api.loadUiState()?.options ?? {}) };
  }

  /** Persist + apply display options; a set() repaint follows via subscribers. */
  setOptions(patch: UiOptions) {
    this.set({ options: { ...this.state.options, ...patch } });
    this.api.updateUiState({ options: this.state.options });
    // App-level listeners outside the webview bundle (om-tools-web Assistant
    // panel) get a DOM event — it is a no-op where nothing listens.
    document.dispatchEvent(new CustomEvent("omCore.optionsChanged", { detail: this.state.options }));
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    const unsub = () => this.listeners.delete(fn);
    this.capture?.add(unsub);
    return unsub;
  }
  notify(reason?: string) {
    this.notifyReason = reason ?? null;
    // A throwing subscriber must not starve the rest — or unwind into a caller
    // mid-gesture (a drag's update→set→apply→notify chain dies with it).
    for (const l of [...this.listeners]) {
      try { l(); } catch (e) { console.error("notify subscriber failed", e); }
    }
    this.notifyReason = null;
  }

  /** Typed UI-action events for app-level observers (T-tips onboarding): a GUI-local
   *  signal channel (a-07 permits it for UI-only concerns), not the engine MessageBus.
   *  Kebab-case names; `emitUiEvent` is fire-and-forget like `notify()` — a throwing
   *  subscriber is logged and dropped, it must never unwind into the caller. */
  onUiEvent(fn: (name: string) => void): () => void {
    this.uiEventListeners.add(fn);
    return () => this.uiEventListeners.delete(fn);
  }
  emitUiEvent(name: string) {
    for (const l of [...this.uiEventListeners]) {
      try { l(name); } catch (e) { console.error("uiEvent subscriber failed", e); }
    }
  }

  /** While set, every subscribe() also lands in this bag. See captureSubscriptions(). */
  private capture: Set<() => void> | null = null;

  /** Run fn() and collect every subscription it makes (components subscribe inside render());
   *  `dispose` releases them all at once. Lets the shell rebuild a subtree without leaking
   *  listeners onto detached DOM (T-dock body swap on the docking option toggle). */
  captureSubscriptions<T>(fn: () => T): { result: T; dispose: () => void } {
    const bag = new Set<() => void>();
    const prev = this.capture;
    this.capture = bag;
    try {
      const result = fn();
      return { result, dispose: () => { for (const u of bag) u(); bag.clear(); } };
    } finally {
      this.capture = prev;
    }
  }

  set(partial: Partial<AppState>) { Object.assign(this.state, partial); this.notify(); }

  setStatus(connected: boolean, message: string, hint = "") {
    this.state.connected = connected;
    this.state.statusMessage = message;
    this.state.statusHint = connected ? "" : hint;
    this.notify();
  }

  markDirty(d = true) { this.state.dirty = d; this.notify(); }

  /** File name for the title and the status bar; `New_Model.json` while the workspace has no file. */
  fileName(): string { return this.state.filePath ? this.state.filePath.split(/[\\/]/).pop() || this.state.filePath : "New_Model.json"; }

  isSystem(name: string): boolean { return typeof name === "string" && name.startsWith("%"); }
  visibleDims(): DimSummary[] { return this.state.showSystemElements ? this.state.dimensions : this.state.dimensions.filter((d) => !this.isSystem(d.name)); }
  visibleCubes(): CubeSummary[] { return this.state.showSystemElements ? this.state.cubes : this.state.cubes.filter((c) => !this.isSystem(c.name)); }
  visibleViews(): ViewSummary[] { return this.state.showSystemElements ? this.state.views : this.state.views.filter((v) => !this.isSystem(v.name)); }

  dimName(dimId: string): string {
    const d = this.dimCache.get(dimId);
    if (d) return d.name;
    const sum = this.state.dimensions.find((x) => x.id === dimId);
    return sum?.name || dimId.slice(0, 8);
  }
  dimIsSeq(dimId: string): boolean {
    const d = this.dimCache.get(dimId);
    return !!(d && (d as any).dim_type === "seq");
  }
  dimItems(dimId: string): { id: string; name: string }[] {
    const d = this.dimCache.get(dimId);
    return d?.items || [];
  }
  async ensureDimCache(dimIds: string[]) {
    const missing = dimIds.filter((id) => !this.dimCache.has(id));
    if (!missing.length) return;
    const details = await Promise.all(missing.map((id) => this.api.dimensionDetail(id).catch(() => null)));
    for (const d of details) if (d) this.dimCache.set(d.id, d);
  }

  invalidateDimCache(dimId?: string) {
    if (dimId) this.dimCache.delete(dimId);
    else { this.dimCache.clear(); this.cubeCache.clear(); }
  }

  /** `dimension_ids` of a cube in cube order (the `@` channel included), once `ensureCubeDetail` has run. */
  cubeDimensionIds(cubeId: string): string[] | null {
    const ids = this.cubeCache.get(cubeId)?.dimension_ids;
    return Array.isArray(ids) ? ids : null;
  }
  /** Loads `cube_detail` once per cube; a failure is cached too (as `{}`), so callers do not retry in a loop.
   *  Dropped with the dimension cache on structure changes and when another workspace is loaded. */
  async ensureCubeDetail(cubeId: string) {
    if (this.cubeCache.has(cubeId)) return;
    let detail: any = null;
    try { detail = await this.api.cubeDetail(cubeId); } catch { /* fall through: cached as empty */ }
    this.cubeCache.set(cubeId, detail || {});
  }

  /** Set by openOptions() before it sends set_dependency_tracking — the next
   *  flag refetch is our own toggle's echo, not an external flip. */
  private depTrackingToggledLocally = false;
  noteLocalDepTrackingToggle() { this.depTrackingToggledLocally = true; }

  /** command.*.succeeded accounting for the recalc pill's "·N pending": edits
   *  made while tracking is off can't have marked dependents dirty. Recalc
   *  echoes do NOT clear the count while off — the topic carries no scope, a
   *  dirty-scope recalc recomputes nothing untracked, and scheduleExternalRefresh
   *  fires a no-op one after every external command. Reset happens on the flag
   *  refetching true and on workspace (re)load. */
  notePendingEdit(cmd: string | undefined) {
    if (this.state.depTrackingEnabled || !cmd) return;
    if (cmd === "set_dependency_tracking" || cmd === "run_recalculation" || cmd === "recompute_dirty") return;
    this.set({ pendingEditsWhileUntracked: this.state.pendingEditsWhileUntracked + 1 });
  }

  async refreshModel() {
    const [dims, cubes, views, ws, dep] = await Promise.all([
      this.api.dimensionList(),
      this.api.cubeList(),
      this.api.viewList(),
      this.api.workspaceSummary(),
      this.api.diagnosticsDependencyTrackingState().catch(() => null),
    ]);
    // diagnostics_dependency_tracking_state resolves a bare boolean on some
    // runtimes, {dependency_tracking_enabled} on others — accept both.
    const depEnabled = typeof dep === "boolean" ? dep
      : (dep?.dependency_tracking_enabled ?? this.state.depTrackingEnabled);
    // External flip (MCP om_command, REPL, second GUI) → bump the seq so the
    // pill flashes; an own toggle's echo is not a surprise.
    const flipped = depEnabled !== this.state.depTrackingEnabled;
    const externalFlip = flipped && !this.depTrackingToggledLocally;
    this.depTrackingToggledLocally = false;
    this.set({
      dimensions: dims.dimensions, cubes: cubes.cubes, views: views.views, workspaceSummary: ws,
      depTrackingEnabled: depEnabled,
      depTrackingFlipSeq: this.state.depTrackingFlipSeq + (externalFlip ? 1 : 0),
      pendingEditsWhileUntracked: depEnabled ? 0 : this.state.pendingEditsWhileUntracked,
    });
    this.syncTabsWithViews();
    // Externally-driven changes (MCP agent, second client) re-run refreshModel via
    // event.* subscriptions but never invalidateDimCache — a dim cached before its
    // items existed stays stale and stacked axes render raw item_ids. dimension_list
    // already returns item_list; drop entries that no longer match it.
    const freshIds = new Set(dims.dimensions.map((d) => d.id));
    for (const id of [...this.dimCache.keys()]) if (!freshIds.has(id)) this.dimCache.delete(id);
    for (const s of dims.dimensions) {
      const c = this.dimCache.get(s.id);
      if (!c) continue;
      const list = s.item_list;
      const sameItems = list
        ? c.items.length === list.length && c.items.every((it, i) => it.id === list[i].id && it.name === list[i].name)
        : c.items.length === s.items;
      if (c.name !== s.name || !sameItems) this.dimCache.delete(s.id);
    }
    // dimension_list has no dim_type, so the Model Browser knew "sequential" only for dimensions of an opened view.
    // Fetch the missing details once (the cache lives until the next model load), then redraw (issue #2).
    const missing = dims.dimensions.some((d) => !this.dimCache.has(d.id));
    if (missing) this.ensureDimCache(dims.dimensions.map((d) => d.id)).then(() => this.notify()).catch(() => {});
  }

  /** Tabs follow the runtime's views: a deleted view (Delete View, Delete Cube) loses its tab, a renamed one
   *  its old name. When the active view is gone the first remaining tab opens, or none. */
  private syncTabsWithViews() {
    const byId = new Map(this.state.views.map((v) => [v.id, v.name]));
    let changed = false;
    const reload: string[] = [];
    for (const g of this.state.viewGroups) {
      const kept = g.tabs.filter((t) => byId.has(t.viewId));
      if (kept.length !== g.tabs.length) changed = true;
      for (const t of kept) { const n = byId.get(t.viewId)!; if (t.viewName !== n) { t.viewName = n; changed = true; } }
      g.tabs = kept;
      if (g.activeTab && !byId.has(g.activeTab)) {
        g.activeTab = kept[0]?.viewId ?? null;
        if (g.activeTab) reload.push(g.activeTab);
        changed = true;
      }
    }
    for (const id of Object.keys(this.state.viewStates)) {
      if (!this.groupForView(id)) { delete this.state.viewStates[id]; changed = true; }
    }
    if (!changed) return;
    this.syncViewMirror();
    for (const vid of reload) void this.loadView(vid);
    this.notify();
  }

  /** Qt `_finalize_structure_change`: after creating or deleting dimensions, items, cubes, views —
   *  model browser, rules and the active view are reloaded; `focus` opens a new view (New Cube, New View). */
  async afterStructureChange(focus?: { viewId: string; viewName: string }) {
    this.markDirty();
    this.invalidateDimCache();
    try { await this.refreshModel(); await this.refreshRules(); }
    catch (e: any) { await alertDialog("Refresh failed", e?.message || String(e)); return; }
    if (focus) await this.openView(focus.viewId, focus.viewName);
    else if (this.state.activeView && this.state.views.some((v) => v.id === this.state.activeView!.viewId)) await this.loadView(this.state.activeView.viewId);
  }

  async refreshUndoState() {
    try {
      const s = await this.api.undoState();
      this.set({ canUndo: s.can_undo, canRedo: s.can_redo, undoDesc: s.undo_description || "", redoDesc: s.redo_description || "" });
    } catch {}
  }

  async openView(viewId: string, viewName: string) {
    // A view already open in another pane gets focused there, not duplicated.
    const gid = this.groupForView(viewId) ?? this.state.focusedGroup;
    const g = this.group(gid)!;
    if (!g.tabs.find((t) => t.viewId === viewId)) g.tabs.push({ viewId, viewName });
    g.activeTab = viewId;
    this.state.focusedGroup = gid;
    this.syncViewMirror();
    this.notify();
    await this.loadView(viewId);
  }

  async loadView(viewId: string) {
    const cur = this.state.viewStates[viewId];
    if (!cur) {
      this.state.viewStates[viewId] = { viewId, viewName: "", cubeId: "", rowDimIds: [], colDimIds: [], pageDimIds: [], pageSelections: {}, rowKeys: [], colKeys: [], rowHeaders: [], colHeaders: [], cells: null, selectedRow: -1, selectedCol: -1, selMode: "cell", selIndices: new Set(), anchorRow: 0, anchorCol: 0, colWidths: {}, rowHeaderWidths: {}, loading: true };
    } else {
      cur.loading = true;
    }
    this.syncViewMirror();
    this.notify();
    try {
      const detail = await this.api.viewDetail(viewId);
      const allDimIds = [...detail.row_dim_ids, ...detail.col_dim_ids, ...detail.page_dim_ids];
      await this.ensureDimCache(allDimIds);
      // One page_selection query per page dimension (the runtime has no "all selections" query).
      const pageSel: Record<string, string> = {};
      await Promise.all(detail.page_dim_ids.map(async (dimId: string) => {
        try {
          const ps = await this.api.pageSelection(viewId, dimId);
          if (ps?.item_id) pageSel[dimId] = ps.item_id;
        } catch (e) {
          // Non-fatal: grid data still uses the view's server-side selection; only the page chip label may be stale.
          console.error(`page_selection failed for dim ${dimId}`, e);
        }
      }));
      const rk = (await this.api.viewRowKeys(viewId)).keys;
      const ck = (await this.api.viewColKeys(viewId)).keys;
      const rowHeaders = await Promise.all(rk.map((_, i) => this.api.viewRowHeader(viewId, i).then((r) => r.header).catch(() => "")));
      const colHeaders = await Promise.all(ck.map((_, i) => this.api.viewColHeader(viewId, i).then((r) => r.header).catch(() => "")));
      const cells = rk.length && ck.length ? await this.api.cellRange(viewId, rk, ck) : null;
      if (cells) await this.mergeChannelPaints(cells, viewId, rk, ck, pageSel);
      const prev = this.state.viewStates[viewId];
      // Visual->data maps survive a reload only while the key space is identical;
      // a regrouped/reordered axis rebuilds them on the grid's next render.
      const sameKeys = (a: string[][] | undefined, b: string[][] | undefined) =>
        !!a && !!b && a.length === b.length && a.every((k, i) => k.length === b[i].length && k.every((p, j) => p === b[i][j]));
      const keepMaps = !!(prev && prev.viewId === viewId && sameKeys(rk, prev.rowKeys) && sameKeys(ck, prev.colKeys));
      const visRows = keepMaps ? (prev!.cellRowMap?.length ?? rk.length) : rk.length;
      const visCols = keepMaps ? (prev!.cellColMap?.length ?? ck.length) : ck.length;
      this.state.viewStates[viewId] = {
        viewId, viewName: detail.name, cubeId: detail.cube_id,
        rowDimIds: detail.row_dim_ids, colDimIds: detail.col_dim_ids, pageDimIds: detail.page_dim_ids,
        pageSelections: pageSel,
        rowKeys: rk, colKeys: ck, rowHeaders, colHeaders,
        cells,
        cellRowMap: keepMaps ? prev!.cellRowMap : undefined,
        cellColMap: keepMaps ? prev!.cellColMap : undefined,
        selectedRow: prev && prev.viewId === viewId && prev.selectedRow >= 0 && prev.selectedRow < visRows ? prev.selectedRow : (rk.length ? 0 : -1),
        selectedCol: prev && prev.viewId === viewId && prev.selectedCol >= 0 && prev.selectedCol < visCols ? prev.selectedCol : (ck.length ? 0 : -1),
        selMode: prev && prev.viewId === viewId ? prev.selMode : "cell",
        selIndices: prev && prev.viewId === viewId ? prev.selIndices : new Set(),
        anchorRow: prev && prev.viewId === viewId ? prev.anchorRow : 0,
        anchorCol: prev && prev.viewId === viewId ? prev.anchorCol : 0,
        // Native: engine-emitted col_widths/row_header_widths use string keys.
        colWidths: Object.fromEntries(Object.entries(detail.col_widths ?? {}).map(([k, w]) => [Number(k), w as number])),
        rowHeaderWidths: Object.fromEntries(Object.entries(detail.row_header_widths ?? {}).map(([k, w]) => [Number(k), w as number])),
        loading: false,
      };
      // The rule bar / window title describe the focused pane — a background pane
      // reloading its view must not retitle the app.
      if (this.viewOf(this.state.focusedGroup)?.viewId === viewId) this.state.focusPath = `OM Core View: ${detail.name}`;
      this.syncViewMirror();
      this.notify();
      await this.refreshRules();
      this.updateSelectionStats();
      await this.refreshUndoState();
    } catch (e: any) {
      this.state.viewStates[viewId] = { ...this.state.viewStates[viewId]!, loading: false };
      this.syncViewMirror();
      this.notify();
      console.error("loadView failed", e);
    }
  }

  // ---- Aggregate panes (Quantrix editor groups) ----
  // `openTabs`/`activeTab`/`activeView` are mirrors of the focused group so legacy
  // unscoped readers keep working; group-aware code uses the helpers below.

  group(gid: string): ViewGroupState | undefined {
    return this.state.viewGroups.find((g) => g.id === gid);
  }

  groupTabs(gid: string) { return this.group(gid)?.tabs ?? []; }

  /** The view a pane shows. Without `gid` — the focused group's (same as state.activeView). */
  viewOf(gid?: string): ViewState | null {
    if (gid === undefined) return this.state.activeView;
    const g = this.group(gid);
    return g?.activeTab ? this.state.viewStates[g.activeTab] ?? null : null;
  }

  /** Which group a view's tab lives in (a view is in at most one group), or null. */
  groupForView(viewId: string): string | null {
    for (const g of this.state.viewGroups) if (g.tabs.some((t) => t.viewId === viewId)) return g.id;
    return null;
  }

  /** Re-derive the focused-group mirrors. Call after every group/viewStates mutation. */
  private syncViewMirror() {
    const g = this.group(this.state.focusedGroup);
    this.state.openTabs = this.state.viewGroups.flatMap((x) => x.tabs);
    this.state.activeTab = g?.activeTab ?? null;
    this.state.activeView = g?.activeTab ? this.state.viewStates[g.activeTab] ?? null : null;
  }

  /** Menus, the rule bar and keyboard commands act on the focused pane; clicking
   *  anywhere inside a pane (tab, grid, rules) focuses it first. */
  focusGroup(gid: string) {
    if (this.state.focusedGroup === gid || !this.group(gid)) return;
    this.state.focusedGroup = gid;
    this.syncViewMirror();
    this.notify("focus");
  }

  /** Tab click in a pane: show that view there and focus the pane. */
  async activateViewTab(gid: string, viewId: string) {
    const g = this.group(gid);
    if (!g || !g.tabs.some((t) => t.viewId === viewId)) return;
    g.activeTab = viewId;
    this.state.focusedGroup = gid;
    this.syncViewMirror();
    this.notify();
    await this.loadView(viewId);
  }

  /** × on a tab: remove it; an emptied pane collapses out of the split tree. */
  async closeViewTab(gid: string, viewId: string) {
    const g = this.group(gid);
    if (!g) return;
    const idx = g.tabs.findIndex((t) => t.viewId === viewId);
    if (idx < 0) return;
    g.tabs.splice(idx, 1);
    if (g.activeTab === viewId) g.activeTab = g.tabs[Math.max(0, idx - 1)]?.viewId ?? null;
    if (!this.groupForView(viewId)) delete this.state.viewStates[viewId];
    const emptied = g.tabs.length === 0 && this.state.viewGroups.length > 1;
    if (emptied) this.removeGroup(gid);
    this.syncViewMirror();
    this.notify();
    if (!emptied && g.activeTab) await this.loadView(g.activeTab);
  }

  /** Drop a view tab: `center` merges it into the target pane; an edge splits that
   *  pane and the moved view opens in the new sibling. */
  moveTab(viewId: string, targetGid: string, side: AreaSide) {
    const tgt = this.group(targetGid);
    if (!tgt) return;
    const srcGid = this.groupForView(viewId);
    const src = srcGid ? this.group(srcGid) : undefined;
    const name = src?.tabs.find((t) => t.viewId === viewId)?.viewName
      ?? this.state.views.find((v) => v.id === viewId)?.name ?? "View";
    if (srcGid === targetGid && side === "center") { void this.activateViewTab(targetGid, viewId); return; }
    if (src) {
      src.tabs = src.tabs.filter((t) => t.viewId !== viewId);
      if (src.activeTab === viewId) src.activeTab = src.tabs[0]?.viewId ?? null;
    }
    if (side === "center") {
      tgt.tabs.push({ viewId, viewName: name });
      tgt.activeTab = viewId;
      this.state.focusedGroup = targetGid;
    } else {
      const ng: ViewGroupState = { id: `g${++Store.gidSeq}`, tabs: [{ viewId, viewName: name }], activeTab: viewId, rulesOpen: true, rulesCollapsed: false };
      this.state.viewGroups.push(ng);
      this.splitGroupNode(targetGid, side, ng.id);
      this.state.focusedGroup = ng.id;
      this.emitUiEvent("view-split");
    }
    if (src && src.tabs.length === 0 && this.state.viewGroups.length > 1) this.removeGroup(src.id);
    this.syncViewMirror();
    this.notify();
    void this.loadView(viewId);
  }

  private static gidSeq = 0;

  /** Wrap the target group node in a split; `side` picks the new pane's direction/position. */
  private splitGroupNode(targetGid: string, side: AreaSide, newGid: string) {
    const dir = side === "left" || side === "right" ? "x" : "y";
    const wrap = (node: AreaNode): AreaNode => {
      if (node.kind === "group") {
        if (node.gid !== targetGid) return node;
        const fresh: AreaNode = { kind: "group", gid: newGid };
        const first = side === "left" || side === "top";
        return { kind: "split", dir, sizes: [50, 50], children: first ? [fresh, node] : [node, fresh] };
      }
      return { ...node, children: node.children.map(wrap) };
    };
    this.state.viewArea = wrap(this.state.viewArea);
  }

  /** Collapse a group leaf out of the split tree (its split sibling takes the space). */
  private removeGroup(gid: string) {
    this.state.viewGroups = this.state.viewGroups.filter((g) => g.id !== gid);
    const prune = (node: AreaNode): AreaNode | null => {
      if (node.kind === "group") return node.gid === gid ? null : node;
      const children = node.children.map(prune).filter((c): c is AreaNode => c !== null);
      if (children.length === 0) return null;
      if (children.length === 1) return children[0];
      return { ...node, children };
    };
    const pruned = prune(this.state.viewArea);
    // The last group can never leave (there is always one pane).
    this.state.viewArea = pruned ?? { kind: "group", gid: this.state.viewGroups[0]?.id ?? "g0" };
    if (!this.group(this.state.focusedGroup)) this.state.focusedGroup = this.state.viewGroups[0]?.id ?? "g0";
  }

  /** Hide/show a pane's rules subpane (View → Rule Panel acts on the focused pane). */
  toggleGroupRules(gid?: string) {
    const g = this.group(gid ?? this.state.focusedGroup);
    if (!g) return;
    g.rulesOpen = !g.rulesOpen;
    this.notify();
    if (g.rulesOpen) this.emitUiEvent("rules-opened");
  }

  groupRulesOpen(gid?: string): boolean {
    return this.group(gid ?? this.state.focusedGroup)?.rulesOpen ?? false;
  }

  /** `@`-channel paints (fill/font_color rules) for the loaded tile — engine-side
   *  styling, merged onto the CellDTOs. Cosmetic: failures leave cells unpainted. */
  private async mergeChannelPaints(cells: CellRangeDTO, viewId: string, rk: string[][], ck: string[][], pageSel: Record<string, string>) {
    try {
      const fmtChannels = ["format_number", "format_text", "format_null", "format_error"];
      const snap = await this.api.gridViewportSnapshot(viewId, rk, ck, pageSel, ["fill", "font_color", ...fmtChannels]);
      const chans = snap?.channels ?? {};
      const fills = chans.fill ?? {}, fonts = chans.font_color ?? {};
      cells.cells.forEach((cell, i) => {
        const key = makeViewportCellKey(rk[Math.floor(i / ck.length)] ?? [], ck[i % ck.length] ?? []);
        if (fills[key] != null) cell.fill = String(fills[key]);
        if (fonts[key] != null) cell.font_color = String(fonts[key]);
        let hasFmt = false;
        for (const ch of fmtChannels) {
          const v = (chans[ch] ?? {})[key];
          if (v != null) { (cell as any)[ch] = String(v); hasFmt = true; }
        }
        if (hasFmt) cell.display_value = formatCellValue(cell.value, cell, cell.kind);
      });
    } catch { /* channels are cosmetic — the grid still renders without them */ }
  }

  async moveDimension(dimId: string, dest: "row" | "col" | "page", index?: number, gid?: string) {
    const v = this.viewOf(gid);
    if (!v) return;
    try {
      await this.api.moveViewDimension(v.viewId, dimId, dest, index);
      this.markDirty();
      await this.loadView(v.viewId);
    } catch (e: any) { console.error("moveDimension failed", e); await alertDialog("Move dimension failed", e?.message || String(e)); }
  }

  async setPageItem(dimId: string, itemId: string, gid?: string) {
    const v = this.viewOf(gid);
    if (!v) return;
    try {
      await this.api.setPageItemId(v.viewId, dimId, itemId);
      v.pageSelections[dimId] = itemId;
      // No notify() here: it would repaint the grid with the OLD slice's
      // cells first. loadView notifies once, with the new values.
      await this.loadView(v.viewId);
    } catch (e: any) { console.error("setPageItem failed", e); }
  }

  async refreshRules() {
    try {
      const r = await this.api.workspaceRules();
      this.set({ rules: r.rules || [], ruleOrder: r.rule_order || [] });
    } catch {}
  }

  /** Visual grid index -> cell-data index, via the maps MultilevelGrid publishes
   *  (-1 for group/placeholder entries). Identity when no map exists (flat grids). */
  dataRowIndex(v: ViewState, visRow: number): number {
    return v.cellRowMap ? v.cellRowMap[visRow] ?? -1 : (visRow < v.rowKeys.length ? visRow : -1);
  }
  dataColIndex(v: ViewState, visCol: number): number {
    return v.cellColMap ? v.cellColMap[visCol] ?? -1 : (visCol < v.colKeys.length ? visCol : -1);
  }
  /** Cell-data index -> visual grid index (selection coordinates). -1 when the
   *  data row/col has no visible entry (shouldn't happen for leaf keys). */
  visualRowIndex(v: ViewState, dataRow: number): number {
    return v.cellRowMap ? v.cellRowMap.indexOf(dataRow) : (dataRow < v.rowKeys.length ? dataRow : -1);
  }
  visualColIndex(v: ViewState, dataCol: number): number {
    return v.cellColMap ? v.cellColMap.indexOf(dataCol) : (dataCol < v.colKeys.length ? dataCol : -1);
  }
  /** Look up the cell under a VISUAL grid coordinate. Selection state is visual;
   *  v.cells is indexed by data coordinates. */
  cellAtVisual(v: ViewState, visRow: number, visCol: number): CellDTO | undefined {
    if (!v.cells) return undefined;
    const dr = this.dataRowIndex(v, visRow);
    const dc = this.dataColIndex(v, visCol);
    return dr >= 0 && dc >= 0 ? v.cells.cells[dr * v.colKeys.length + dc] : undefined;
  }

  private statsTimer: any = null;
  private statsGen = 0;

  /** Qt debounces 100ms (_stats_debounce_timer) so arrow-key sweeps and drags
   *  don't flood the engine with stats queries; a generation counter drops
   *  stale replies the same way Qt's _generation does. */
  updateSelectionStats() {
    const gen = ++this.statsGen;
    if (this.statsTimer) clearTimeout(this.statsTimer);
    this.statsTimer = setTimeout(() => { void this.doSelectionStats(gen); }, 100);
  }

  private async doSelectionStats(gen: number) {
    const v = this.state.activeView;
    if (!v || !v.cells || v.selectedRow < 0 || v.selectedCol < 0) {
      if (gen === this.statsGen) { this.state.selectionStats = {}; this.notify(); }
      return;
    }
    try {
      // Engine wants key tuples, like Qt's _build_selection_stats_payload
      // (which translates visual rows through _leaf_row_index the same way).
      const MAX_KEYS = 10_000;
      const params: any = { view_id: v.viewId, mode: v.selMode, page_selections: v.pageSelections };
      if (v.selMode === "cell") {
        const keys: any[] = [];
        for (const [r, c] of this.iterSelectedCells()) {
          const dr = this.dataRowIndex(v, r), dc = this.dataColIndex(v, c);
          if (dr < 0 || dc < 0) continue;
          keys.push([v.rowKeys[dr], v.colKeys[dc]]);
          if (keys.length >= MAX_KEYS) break;
        }
        params.cell_keys = keys;
      } else if (v.selMode === "row") {
        params.row_keys = [...(v.selIndices as Set<number>)]
          .map((i) => this.dataRowIndex(v, i)).filter((i) => i >= 0 && i < v.rowKeys.length)
          .slice(0, MAX_KEYS).map((i) => v.rowKeys[i]);
      } else if (v.selMode === "col") {
        params.col_keys = [...(v.selIndices as Set<number>)]
          .map((i) => this.dataColIndex(v, i)).filter((i) => i >= 0 && i < v.colKeys.length)
          .slice(0, MAX_KEYS).map((i) => v.colKeys[i]);
      }
      const stats = await this.api.selectionStats(params);
      if (gen !== this.statsGen) return;
      this.state.selectionStats = stats;
      this.notify();
    } catch {
      // fallback: compute locally — counta counts every non-empty value, count only numerics
      // (cmd_selection_stats semantics; cell.value == engine.get_cell_by_addr)
      let count = 0, counta = 0, sum = 0, min: number | null = null, max: number | null = null, total = 0;
      for (const [r, c] of this.iterSelectedCells()) {
        const cell = this.cellAtVisual(v, r, c);
        if (!cell) continue;
        total++;
        if (cell.value === null || cell.value === undefined || cell.value === "") continue;
        counta++;
        const num = Number(cell.value);
        if (!isNaN(num)) {
          count++; sum += num;
          if (min === null || num < min) min = num;
          if (max === null || num > max) max = num;
        }
      }
      if (gen !== this.statsGen) return;
      this.state.selectionStats = { total_count: total, count, counta, sum, avg: count ? sum / count : 0, min, max, sampled: false };
      this.notify();
    }
  }

  *iterSelectedCells(gid?: string): Generator<[number, number]> {
    const v = this.viewOf(gid);
    if (!v || !v.cells) return;
    // Yields VISUAL grid coordinates — translate via dataRowIndex/cellAtVisual at use.
    const visRows = v.cellRowMap?.length ?? v.rowKeys.length;
    const visCols = v.cellColMap?.length ?? v.colKeys.length;
    if (v.selMode === "all") {
      for (let r = 0; r < visRows; r++) for (let c = 0; c < visCols; c++) yield [r, c];
    } else if (v.selMode === "row") {
      for (const idx of v.selIndices as Set<number>) for (let c = 0; c < visCols; c++) yield [idx, c];
    } else if (v.selMode === "col") {
      for (const idx of v.selIndices as Set<number>) for (let r = 0; r < visRows; r++) yield [r, idx];
    } else if (v.selMode === "cell") {
      if ((v.selIndices as Set<string>).size === 0) {
        if (v.selectedRow >= 0 && v.selectedCol >= 0) yield [v.selectedRow, v.selectedCol];
      } else {
        for (const key of v.selIndices as Set<string>) {
          const [r, c] = key.split(",").map(Number);
          yield [r, c];
        }
      }
    }
  }

  setSelection(row: number, col: number, gid?: string) {
    const v = this.viewOf(gid);
    if (!v) return;
    v.selectedRow = row;
    v.selectedCol = col;
    this.notify();
    this.updateSelectionStats();
  }

  setSelectionFull(row: number, col: number, mode: SelMode, indices: Set<any>, anchorRow?: number, anchorCol?: number, gid?: string) {
    const v = this.viewOf(gid);
    if (!v) return;
    v.selectedRow = row;
    v.selectedCol = col;
    v.selMode = mode;
    v.selIndices = indices;
    v.anchorRow = anchorRow ?? row;
    v.anchorCol = anchorCol ?? col;
    this.notify();
    this.updateSelectionStats();
    try { this.api.setSelection(row, col, mode, v.anchorRow, v.anchorCol, [...indices] as any, v.viewId); } catch {}
  }

  /** Apply text the user typed into a cell editor, the rule bar or the Set Rule dialog.
   *  Grammar is parseCellInput(). `at` is the target for the grid editor: either the
   *  resolved cell (preferred — immune to visual/data index drift) or a VISUAL grid
   *  coordinate; without it the active cell is used and, as in Qt, a multi-cell
   *  selection is refused for cell entries. */
  async applyInput(raw: string, at?: { row?: number; col?: number; cell?: CellDTO }, gid?: string) {
    const v = this.viewOf(gid);
    if (!v || !v.cells) return;
    const input = parseCellInput(raw);
    if (!input) return;
    try {
      if (input.kind === "cubeRule") {
        const resolved = await this.api.ruleTargetResolve(v.cubeId, input.lhs);
        if (resolved?.error || !resolved?.targets?.length) {
          throw new Error(resolved?.error || `Cannot resolve rule target "${input.lhs}"`);
        }
        await this.api.setRule(v.cubeId, resolved.targets, input.expr, input.anchored);
      } else {
        if (!at && this.hasMultiCellSelection(gid)) {
          await alertDialog("Single cell only", "Several cells are selected. A value or =expression applies to one cell. Select a single cell and try again.");
          return;
        }
        const cell = at?.cell ?? this.cellAtVisual(v, at?.row ?? v.selectedRow, at?.col ?? v.selectedCol);
        if (!cell?.addr) { await alertDialog("No cell selected", "Select a cell and try again."); return; }
        if (input.kind === "cellRule") {
          await this.api.setRuleAnchored(v.viewId, { kind: "ids", row_key: cell.row_key, col_key: cell.col_key }, input.expr);
        } else {
          await this.api.setCellHardvalueByAddr(v.cubeId, cell.addr, input.value);
        }
      }
      this.markDirty();
      await this.api.recalc("dirty");
      await this.reloadOpenViews();   // dependents in other panes (PL_View) change too — not only the edited view
      if (input.kind !== "value") await this.refreshRules();
    } catch (e: any) {
      await alertDialog(input.kind === "value" ? "Set cell failed" : "Rule error", e?.message || String(e));
    }
  }

  private hasMultiCellSelection(gid?: string): boolean {
    let n = 0;
    for (const _ of this.iterSelectedCells(gid)) if (++n > 1) return true;
    return false;
  }

  /** Delete key: remove stored values (override or plain input) from the selection, as Qt does
   *  (clipboard.clear_selection). Cells that only a rule computes, or that are empty, hold
   *  nothing to clear: they are skipped, so no empty undo steps and no false "unsaved" flag.
   *  A cell's own rule (=expr) is not removed — neither does Qt; delete it in the Rules tab. */
  async clearSelectedCells(gid?: string) {
    const v = this.viewOf(gid);
    if (!v || !v.cells) return;
    const cells = [...this.iterSelectedCells(gid)]
      .map(([r, c]) => this.cellAtVisual(v, r, c))
      .filter((cell): cell is CellDTO => !!cell?.addr && !["rule", "empty"].includes(cell.explain?.source));
    await this.clearHardvalues(cells, v);
  }

  /** Edit → Clear Override: the active cell only, and only when it holds an override (Qt _on_clear_override). */
  async clearActiveOverride(gid?: string) {
    const cell = this.activeCell(gid);
    if (cell?.explain?.source === "override") await this.clearHardvalues([cell], this.viewOf(gid)!);
  }

  activeCell(gid?: string): CellDTO | undefined {
    const v = this.viewOf(gid);
    if (!v || !v.cells || v.selectedRow < 0 || v.selectedCol < 0) return undefined;
    return this.cellAtVisual(v, v.selectedRow, v.selectedCol);
  }

  private async clearHardvalues(cells: CellDTO[], v: ViewState) {
    if (!v || !cells.length) return;
    try {
      for (const cell of cells) await this.api.clearCellHardvalue(v.viewId, { kind: "ids", row_key: cell.row_key, col_key: cell.col_key });
      this.markDirty();
      await this.api.recalc("dirty");
      await this.reloadOpenViews();
    } catch (e: any) { await alertDialog("Clear failed", e?.message || String(e)); }
  }

  async copySelectionToClipboard(gid?: string): Promise<string> {
    const v = this.viewOf(gid);
    if (!v || !v.cells) return "";
    const cells = [...this.iterSelectedCells(gid)];
    if (!cells.length) return "";
    const rows = new Map<number, Map<number, string>>();
    for (const [r, c] of cells) {
      const cell = this.cellAtVisual(v, r, c);
      const val = cell?.display_value ?? (cell?.value != null ? String(cell.value) : "");
      if (!rows.has(r)) rows.set(r, new Map());
      rows.get(r)!.set(c, val);
    }
    const sortedRows = [...rows.keys()].sort((a, b) => a - b);
    return sortedRows.map(r => {
      const cols = [...rows.get(r)!.keys()].sort((a, b) => a - b);
      return cols.map(c => rows.get(r)!.get(c) || "").join("\t");
    }).join("\n");
  }

  async pasteFromClipboard(text: string, gid?: string) {
    const v = this.viewOf(gid);
    if (!v || !v.cells) return;
    const lines = text.split("\n").filter((l) => l !== "");
    const grid = lines.map((l) => l.split("\t"));
    const entries: { addr: string[]; value: any }[] = [];
    for (let dr = 0; dr < grid.length; dr++) {
      for (let dc = 0; dc < grid[dr].length; dc++) {
        const r = v.selectedRow + dr;
        const c = v.selectedCol + dc;
        const cell = this.cellAtVisual(v, r, c);   // paste block walks VISUAL rows/cols
        if (!cell?.addr) continue;
        const raw = grid[dr][dc];
        const val = raw === "" ? null : (isNaN(Number(raw)) ? raw : Number(raw));
        entries.push({ addr: cell.addr, value: val });
      }
    }
    if (!entries.length) return;
    try {
      await this.api.setCellHardvaluesBatchByAddr(v.cubeId, entries);
      this.markDirty();
      await this.api.recalc("dirty");
      await this.reloadOpenViews();
    } catch (e: any) { await alertDialog("Paste failed", e?.message || String(e)); }
  }

  async undo() { await this.stepHistory("undo"); }
  async redo() { await this.stepHistory("redo"); }

  /** Undo / redo one step, then reload what it may have touched. As in Qt (`_on_undo`), nothing is reloaded and the
   *  "unsaved" flag stays as it was when the runtime reports `changed: false` — e.g. another client on the same
   *  runtime already undid the step, so our `canUndo` is stale (undo_test.js, section 7). */
  private async stepHistory(kind: "undo" | "redo") {
    try {
      const r: any = await (kind === "undo" ? this.api.undo() : this.api.redo());
      if (r?.changed === false) { await this.refreshUndoState(); return; }
      this.markDirty();
      await this.refreshModel();
      await this.refreshUndoState();
      await this.reloadOpenViews();
      await this.refreshRules();
    } catch (e: any) { await alertDialog(kind === "undo" ? "Undo failed" : "Redo failed", e?.message || String(e)); }
  }

  /** After update_rule / delete_rule / set_rule_order from the Rules tab (Qt `rules_changed` → reload):
   *  the grid shows new values, the list the new rules. `scope: "all"` for delete and reorder: om-core
   *  does not mark dependents dirty after delete_rule (dirty_count 0, Profit keeps the deleted Rent; T-047). */
  async afterRuleChange(scope: "dirty" | "all" = "dirty") {
    this.markDirty();
    try {
      await this.api.recalc(scope);
      await this.reloadOpenViews();
    } catch (e: any) { await alertDialog("Recalc failed", e?.message || String(e)); }
    await this.refreshRules();
  }

  async recalc(scope = "all") {
    try { await this.api.recalc(scope); await this.reloadOpenViews(); } catch (e: any) { await alertDialog("Recalc failed", e?.message || String(e)); }
  }

  /** Commands that change rule coverage or values where a dirty-scope recalc may
   *  not reach every stale cell on older runtimes (T-047) — external events get
   *  a full recalc, matching `afterRuleChange("all")`. */
  private static readonly FULL_RECALC_COMMANDS = new Set([
    "set_rule", "update_rule", "update_rule_full", "delete_rule",
    "set_rule_order", "apply_rule_batch", "set_rule_anchored",
    "delete_rule_anchored", "undo", "redo",
    "load_workspace", "create_new_workspace", "restore_checkpoint",
  ]);

  /** Commands that only mutate UI/session state — selection, active view,
   *  persisted widths. Their succeeded events must NOT trigger model/rules
   *  refreshes or a recalc: cell/model data cannot change, and set_selection
   *  fires on every grid click (an echo → repaint → echo → repaint blink). */
  static readonly UI_ONLY_COMMANDS = new Set([
    "set_selection", "set_active_view", "set_view_col_width",
    "set_view_row_header_width", "cancel_operation",
    "clear_profiler_snapshot", "set_property", "set_engine",
    "set_multithread_recompute", "set_page_item_id", "save_workspace",
  ]);

  private externalRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private externalRefreshFull = false;
  private viewReloadTimer: ReturnType<typeof setTimeout> | null = null;

  /** Reload views after a calculation finished — ours or another client's.
   *  NO recalc here: `run_recalculation.succeeded`/`event.calculation.finished`
   *  are emitted BY a recalc, so scheduling another one loops forever. */
  scheduleViewReload() {
    if (this.viewReloadTimer !== null) return;
    this.viewReloadTimer = setTimeout(() => {
      this.viewReloadTimer = null;
      void this.reloadOpenViews();
    }, 200);
  }

  /** A `command.*.succeeded` bus event fired — possibly from another client
   *  (MCP `om_command`, REPL, a second GUI) or from this webview. Our own edits
   *  already reloaded synchronously, so the extra reload only repairs views an
   *  external mutation left stale. Debounced: a burst of commands (batch rule
   *  edits) collapses into one recalc + reload. */
  scheduleExternalRefresh(commandId?: string) {
    if (commandId && Store.FULL_RECALC_COMMANDS.has(commandId)) this.externalRefreshFull = true;
    if (this.externalRefreshTimer !== null) return;
    this.externalRefreshTimer = setTimeout(() => {
      this.externalRefreshTimer = null;
      const scope = this.externalRefreshFull ? "all" : "dirty";
      this.externalRefreshFull = false;
      void (async () => {
        try { await this.api.recalc(scope); } catch {}
        await this.reloadOpenViews();
      })();
    }, 200);
  }

  /** Every pane refreshes after model data changes, not only the focused one. */
  private async reloadOpenViews() {
    for (const g of this.state.viewGroups) if (g.activeTab) await this.loadView(g.activeTab);
  }

  /** File → New. Like Qt (`_on_new`), the runtime creates its demo workspace (dims A, B, cube C, view C). */
  async newWorkspace() {
    try { await this.api.createNewWorkspace(); } catch (e: any) { await alertDialog("New workspace failed", e?.message || String(e)); return; }
    await this.resetWorkspaceUi(null, false);
  }
  /** Returns true when saved. `filePath` becomes the path the runtime reports (absolute in VS Code and the bridge). */
  async saveWorkspace(path: string): Promise<boolean> {
    try {
      const r: any = await this.api.saveWorkspace(path);
      this.state.filePath = (r && typeof r.path === "string" && r.path) || path;
      this.markDirty(false);
      if (r?.downloaded) await alertDialog("Saved to Downloads",
        "Your browser doesn't support choosing a save location — the workspace was downloaded to your default Downloads folder.");
      return true;
    } catch (e: any) { await alertDialog("Save failed", e?.message || String(e)); return false; }
  }
  /** File → Open. On failure the runtime keeps the current workspace (cmd_load fails before replacing it),
   *  so the UI is left as it was. */
  async loadWorkspaceFile(path: string) {
    try { await this.api.loadWorkspace(path); } catch (e: any) { await alertDialog("Load failed", e?.message || String(e)); return; }
    await this.resetWorkspaceUi(path, true);
    if (/^om-example:/.test(path)) this.emitUiEvent("example-opened");
  }

  /** The host launched a new runtime since this page was last connected (Stop Runtime, then Start Runtime): what the page
   *  shows came from another model. Same reset as File → New, except that nothing is created in the runtime. A page
   *  that shows nothing yet (the GUI was just opened) only loads the model. */
  async onRuntimeReplaced() {
    const stale = this.state.openTabs.length > 0 || this.state.activeView !== null || this.state.filePath !== null || this.state.dirty;
    if (!stale) { await this.refreshModel(); return; }
    await this.resetWorkspaceUi(null, false);
  }

  /** After New / Open the runtime holds another workspace: tabs, the active view and cached dims and cubes
   *  refer to the old one. Drop them, reload, then open a view as Qt does (`_reload_active_view`): the saved
   *  default view, else the first one. On Open a workspace with cubes but no views gets one
   *  (Qt `_ensure_default_view`), so the main area is not empty. */
  private async resetWorkspaceUi(filePath: string | null, ensureView: boolean, autoOpen = true) {
    this.dimCache.clear();
    this.cubeCache.clear();
    Object.assign(this.state, {
      selectionStats: {}, filePath, dirty: false, pendingEditsWhileUntracked: 0,
      viewGroups: [{ id: "g0", tabs: [], activeTab: null, rulesOpen: true, rulesCollapsed: false }],
      viewStates: {}, focusedGroup: "g0", viewArea: { kind: "group", gid: "g0" } as AreaNode,
    });
    this.syncViewMirror();
    this.notify();
    try {
      await this.refreshModel();
      if (ensureView && await this.ensureDefaultView()) await this.refreshModel();
      await this.refreshRules();
      await this.refreshUndoState();
      if (autoOpen) {
        const views = this.visibleViews();
        const saved = this.state.workspaceSummary?.saved_default_view_id;
        const v = views.find((x) => x.id === saved) || views[0];
        if (v) await this.openView(v.id, v.name);
      }
    } catch (e: any) { await alertDialog("Reload failed", e?.message || String(e)); }
  }

  /** Qt `_ensure_default_view`: no views but a cube → a view of the first cube, rows = first dim,
   *  columns = second, the rest (and the `@` channel) on the page. Returns true when a view was created. */
  private async ensureDefaultView(): Promise<boolean> {
    if (this.visibleViews().length) return false;
    const cube = this.visibleCubes()[0];
    if (!cube) return false;
    const detail = await this.api.cubeDetail(cube.id);
    const dims: string[] = (detail?.dimension_ids || []).filter((d: string) => d !== "@");
    if (!dims.length) return false;
    await this.api.createView(`View of ${cube.name}`, cube.id, [dims[0]], dims[1] ? [dims[1]] : [], ["@", ...dims.slice(2)]);
    return true;
  }

  // ---- Session descriptors (*.omsession.json) ----

  /** Scroll offsets waiting for a session-restored view's first grid render — viewId → px.
   *  Consumed by MultilevelGrid at its scroll-restore points. */
  pendingScrollByView = new Map<string, { left: number; top: number }>();
  /** Set by the app shell: returns a mounted grid's scroll offsets, or null when the
   *  view is not any group's rendered tab (inactive tabs have no live scroll). */
  scrollProbe: ((viewId: string) => { left: number; top: number } | null) | null = null;

  takePendingScroll(viewId: string | null | undefined): { left: number; top: number } | null {
    if (!viewId) return null;
    const p = this.pendingScrollByView.get(viewId) ?? null;
    if (p) this.pendingScrollByView.delete(viewId);
    return p;
  }

  /** Resolve `session.model` to the `load_workspace` path arg: `om-example:` refs and
   *  http(s) URLs pass through; a relative path resolves against the session file's
   *  own directory (a bare filename — the web picker's shape — resolves site-relative). */
  private sessionModelTarget(session: SessionDescriptor, sessionPath: string | null): string {
    const kind = sessionModelKind(session.model);
    if (kind === "example") return session.model.ref!;
    if (kind === "url") return session.model.url!;
    if (kind === "bundle") {
      // The model is a zip member next to the session inside the .omz it came
      // from. On web the backend stashed the bundle bytes when it served the
      // session — the om-bundle: token reads the member from the stash and
      // never re-triggers the picked-file stash (that would reenter the apply).
      // Filesystem hosts get the .omz path; the host extracts the model member.
      if (this.api.supportsNativeExternalLinks) return `om-bundle:${session.model.bundle || "model.json"}`;
      return sessionPath!;
    }
    const p = session.model.path!;
    if (/^https?:\/\//.test(p) || /^([a-zA-Z]:[\\/]|[\\/]|~)/.test(p)) return p;
    const dir = sessionPath ? sessionPath.replace(/[\\/][^\\/]*$/, "") : "";
    if (dir) return `${dir.replace(/[\\/]+$/, "")}/${p}`;
    // Web: a picked session file arrives as a bare name — no directory to resolve
    // against. Resolve site-relative instead so the backend fetches it outright:
    // a bare name could otherwise lose to a stale pickedFile byte source.
    if (this.api.supportsNativeExternalLinks && typeof document !== "undefined")
      return new URL(p, document.baseURI).href;
    return p;
  }

  /** Load the descriptor's model then overlay pane/tab/subpane/chip/selection/scroll
   *  state. Never dirties the model; every unknown ID is skipped and reported. Returns
   *  the skip notes (empty = fully applied). Throws on fatal model-load failures —
   *  the caller shows the alert. `restoring` marks the whole duration (T-tips). */
  async applySession(session: SessionDescriptor, sessionPath: string | null): Promise<string[]> {
    this.restoring = true;
    try { return await this.applySessionBody(session, sessionPath); }
    finally { this.restoring = false; }
  }

  private async applySessionBody(session: SessionDescriptor, sessionPath: string | null): Promise<string[]> {
    const skips: string[] = [];
    const target = this.sessionModelTarget(session, sessionPath);
    // A URL reaches the engine only in the browser host (fetch → bytes); the
    // socket/embedded engines read local paths — fail fast with a clear message.
    if (/^https?:\/\//.test(target) && !this.api.supportsNativeExternalLinks)
      throw new Error("URL model sources are supported in the browser build only");
    try { await this.api.loadWorkspace(target); }
    catch (e: any) { throw new Error(`model could not be loaded: ${e?.message || e}`); }
    // autoOpen=false: the descriptor's own tabs open — the saved-default-view tail
    // would flash a stray tab and load a view the session may not even list.
    await this.resetWorkspaceUi(target, false, false);

    const views = this.visibleViews();
    const byId = new Map(views.map((v) => [v.id, v]));

    // Fresh live gids — descriptor gid labels never collide with live state.
    const gidMap = new Map<string, string>();
    const newGroups: ViewGroupState[] = [];
    for (const [dgid, dg] of Object.entries(session.groups ?? {})) {
      const live = `g${++Store.gidSeq}`;
      gidMap.set(dgid, live);
      const tabs: { viewId: string; viewName: string }[] = [];
      for (const vid of dg?.tabs ?? []) {
        const sum = byId.get(vid);
        if (sum) tabs.push({ viewId: vid, viewName: sum.name });
        else skips.push(`view not in model: ${vid}`);
      }
      newGroups.push({
        id: live, tabs,
        activeTab: dg?.activeTab && tabs.some((t) => t.viewId === dg.activeTab) ? dg.activeTab : tabs[0]?.viewId ?? null,
        rulesOpen: dg?.rulesOpen !== false,
        rulesCollapsed: dg?.rulesCollapsed === true,
        rulesH: typeof dg?.rulesH === "number" && dg.rulesH > 0 ? dg.rulesH : undefined,
        rulesTab: typeof dg?.rulesTab === "string" ? dg.rulesTab : undefined,
      });
    }
    if (!newGroups.length) newGroups.push({ id: `g${++Store.gidSeq}`, tabs: [], activeTab: null, rulesOpen: true, rulesCollapsed: false });

    const mapNode = (n: SessionAreaNode | undefined): AreaNode | null => {
      if (!n || typeof n !== "object") return null;
      if (n.kind === "group") {
        const live = typeof n.gid === "string" ? gidMap.get(n.gid) : undefined;
        return live ? { kind: "group", gid: live } : null;
      }
      if (n.kind === "split") {
        const children = (Array.isArray(n.children) ? n.children : []).map(mapNode).filter((c): c is AreaNode => !!c);
        if (!children.length) return null;
        const dir = n.dir === "y" ? "y" : "x";
        const raw = Array.isArray(n.sizes) ? n.sizes.filter((x): x is number => typeof x === "number" && x > 0) : [];
        const sizes = raw.length === children.length ? raw : children.map(() => 100 / children.length);
        return { kind: "split", dir, sizes, children };
      }
      return null;
    };
    const mapped = mapNode(session.viewArea);
    const usedGids = new Set<string>();
    const collect = (n: AreaNode): void => { if (n.kind === "group") usedGids.add(n.gid); else n.children.forEach(collect); };
    if (mapped) collect(mapped);
    const area = mapped ?? { kind: "group", gid: newGroups[0].id } as AreaNode;
    if (mapped) usedGids.size === 0 && usedGids.add(newGroups[0].id);
    const kept = newGroups.filter((g) => !mapped || usedGids.has(g.id));
    // Tabs of groups a partial viewArea dropped are merged into the first kept pane — never lost.
    const dropped = newGroups.filter((g) => mapped && !usedGids.has(g.id));
    if (dropped.length) {
      const host = kept[0];
      for (const g of dropped) {
        host.tabs.push(...g.tabs.filter((t) => !host.tabs.some((h) => h.viewId === t.viewId)));
        if (!host.activeTab && g.activeTab) host.activeTab = g.activeTab;
      }
      if (dropped.some((g) => g.tabs.length)) skips.push("some panes were merged — the saved layout did not reference them");
    }
    this.state.viewGroups = kept;
    this.state.viewArea = area;
    const firstGid = (n: AreaNode): string | null => n.kind === "group" ? n.gid : (n.children.map(firstGid).find(Boolean) ?? null);
    const wantFocus = typeof session.focusedGroup === "string" ? gidMap.get(session.focusedGroup) : undefined;
    this.state.focusedGroup = wantFocus && kept.some((g) => g.id === wantFocus) ? wantFocus : (firstGid(area) ?? kept[0].id);

    // Chips first (engine-side page selection), then one loadView per unique tab —
    // the first fetch already carries the session's selections.
    const pendingViews = session.views ?? {};
    const uniqueTabs = [...new Map(kept.flatMap((g) => g.tabs).map((t) => [t.viewId, t])).values()];
    for (const t of uniqueTabs) {
      const chips = pendingViews[t.viewId]?.chips;
      if (!chips) continue;
      for (const [dimId, itemId] of Object.entries(chips)) {
        if (typeof itemId !== "string") { skips.push(`bad chip on ${t.viewId}: ${dimId}`); continue; }
        try { await this.api.setPageItemId(t.viewId, dimId, itemId); }
        catch { skips.push(`chip not applied on ${t.viewId}: ${dimId} → ${itemId}`); }
      }
    }
    for (const t of uniqueTabs) {
      try { await this.loadView(t.viewId); }
      catch { skips.push(`view failed to load: ${t.viewId}`); }
    }
    const clamp = (x: unknown, hi: number) => typeof x === "number" && Number.isFinite(x) && x >= 0 ? Math.min(Math.floor(x), hi - 1) : 0;
    for (const t of uniqueTabs) {
      const sv: SessionViewState | undefined = pendingViews[t.viewId];
      const v = this.state.viewStates[t.viewId];
      if (!sv || !v || !v.cells) continue;
      const sel = sv.selection;
      if (sel && v.rowKeys.length && v.colKeys.length) {
        if (sel.mode === "cell" || sel.mode === "row" || sel.mode === "col" || sel.mode === "all") v.selMode = sel.mode;
        if (sel.row !== undefined) v.selectedRow = clamp(sel.row, v.rowKeys.length);
        if (sel.col !== undefined) v.selectedCol = clamp(sel.col, v.colKeys.length);
        if (sel.anchorRow !== undefined) v.anchorRow = clamp(sel.anchorRow, v.rowKeys.length);
        if (sel.anchorCol !== undefined) v.anchorCol = clamp(sel.anchorCol, v.colKeys.length);
        if (Array.isArray(sel.indices)) v.selIndices = new Set(sel.indices.filter((i): i is number => typeof i === "number"));
      }
      const sc = sv.scroll;
      if (sc && (typeof sc.left === "number" || typeof sc.top === "number"))
        this.pendingScrollByView.set(t.viewId, { left: Math.max(0, sc.left ?? 0), top: Math.max(0, sc.top ?? 0) });
    }

    // Dock zones mirror DockLayout; dockVisible derives from zone membership.
    const dock = session.dock;
    if (dock) {
      const valid = new Set<DockPanelId>(["browser", "info", "format", "perf", "timeline", "rules"]);
      const zones: DockZoneId[] = ["left", "right", "bottom"];
      const d = this.state.layout.dock;
      for (const z of zones) {
        const sz = dock[z];
        if (!sz) continue;
        d[z].panels = (sz.panels ?? []).filter((p): p is DockPanelId => valid.has(p as DockPanelId));
        d[z].active = d[z].panels.includes(sz.active as DockPanelId) ? sz.active as DockPanelId : d[z].panels[0] ?? null;
      }
      for (const [k, z] of Object.entries(dock.lastZone ?? {})) {
        if (valid.has(k as DockPanelId) && zones.includes(z as DockZoneId)) d.lastZone[k as DockPanelId] = z as DockZoneId;
      }
      for (const p of ["browser", "info", "format", "perf", "timeline"] as const)
        this.state.dockVisible[p] = zones.some((z) => d[z].panels.includes(p));
      const szs = dock.sizes ?? {};
      if (typeof szs.leftDockWidth === "number" && szs.leftDockWidth > 0) this.state.layout.leftDockWidth = szs.leftDockWidth;
      if (typeof szs.rightDockWidth === "number" && szs.rightDockWidth > 0) this.state.layout.rightDockWidth = szs.rightDockWidth;
      if (typeof szs.rulePanelHeight === "number" && szs.rulePanelHeight > 0) this.state.layout.rulePanelHeight = szs.rulePanelHeight;
      this.saveLayout();
    }
    const lower = session.lower;
    if (lower) {
      if (typeof lower.tab === "string") this.state.rulesTab = lower.tab;
      if (typeof lower.collapsed === "boolean") { this.state.layout.rulePanelCollapsed = lower.collapsed; this.saveLayout(); }
    }

    this.syncViewMirror();
    this.notify();
    return skips;
  }

  /** Live UI state → descriptor JSON. `model` points at the current file (`om-example:`
   *  refs and URLs keep their scheme); an unsaved workspace points at a suggested name —
   *  saving the model first gives a real path. */
  captureSession(theme?: "light" | "dark"): SessionDescriptor {
    const s = this.state;
    const groups: SessionDescriptor["groups"] = {};
    for (const g of s.viewGroups) {
      groups[g.id] = {
        tabs: g.tabs.map((t) => t.viewId),
        activeTab: g.activeTab,
        rulesOpen: g.rulesOpen,
        rulesCollapsed: g.rulesCollapsed,
        rulesH: g.rulesH,
        rulesTab: g.rulesTab,
      };
    }
    const views: SessionDescriptor["views"] = {};
    for (const v of Object.values(s.viewStates)) {
      if (v.loading || !v.cells) continue;
      const isActive = s.viewGroups.some((g) => g.activeTab === v.viewId);
      const scroll = isActive ? this.scrollProbe?.(v.viewId) : null;
      views[v.viewId] = {
        ...(Object.keys(v.pageSelections).length ? { chips: { ...v.pageSelections } } : {}),
        ...(v.selectedRow >= 0 ? {
          selection: {
            mode: v.selMode, row: v.selectedRow, col: v.selectedCol,
            anchorRow: v.anchorRow, anchorCol: v.anchorCol,
            indices: [...v.selIndices].filter((i): i is number => typeof i === "number"),
          },
        } : {}),
        ...(scroll ? { scroll } : {}),
      };
    }
    const fp = s.filePath;
    const model = fp?.startsWith("om-example:") ? { ref: fp } : /^https?:\/\//.test(fp ?? "") ? { url: fp! } : { path: fp ?? "model.json" };
    const dock = s.layout.dock;
    return {
      schema: SESSION_SCHEMA,
      model,
      ...(theme ? { theme } : {}),
      dock: {
        left: { panels: [...dock.left.panels], active: dock.left.active },
        right: { panels: [...dock.right.panels], active: dock.right.active },
        bottom: { panels: [...dock.bottom.panels], active: dock.bottom.active },
        lastZone: { ...dock.lastZone },
        sizes: {
          leftDockWidth: s.layout.leftDockWidth,
          rightDockWidth: s.layout.rightDockWidth,
          rulePanelHeight: s.layout.rulePanelHeight,
        },
      },
      viewArea: s.viewArea as SessionAreaNode,
      groups,
      focusedGroup: s.focusedGroup,
      views,
      lower: { tab: s.rulesTab, collapsed: s.layout.rulePanelCollapsed },
    };
  }

  toggleDock(name: keyof AppState["dockVisible"]) {
    this.state.dockVisible[name] = !this.state.dockVisible[name];
    this.notify();
    if (name === "rules" && this.state.dockVisible.rules) this.emitUiEvent("rules-opened");
  }

  // ---- Dock-zone layout (T-dock) ----
  // Presentation state only: these mutate state.layout.dock and persist, never notify()
  // (same convention as splitter sizes — the caller reconciles the zone DOM directly).

  /** Persist the whole layout blob (sizes + dock) to the host's UiState store. */
  saveLayout() {
    this.api.updateUiState({ layout: { ...this.state.layout } });
  }

  /** Zone a panel currently sits in, or null when it is not a member anywhere. */
  dockPanelZone(panel: DockPanelId): DockZoneId | null {
    const d = this.state.layout.dock;
    for (const z of ["left", "right", "bottom"] as DockZoneId[]) if (d[z].panels.includes(panel)) return z;
    return null;
  }

  /** Move a panel into a zone (appended as a tab, made active). No-op to the same zone. */
  moveDockPanel(panel: DockPanelId, zone: DockZoneId) {
    const d = this.state.layout.dock;
    const from = this.dockPanelZone(panel);
    if (from === zone) return;
    if (from) {
      const z = d[from];
      z.panels = z.panels.filter((p) => p !== panel);
      if (z.active === panel) z.active = z.panels[0] ?? null;
    }
    d[zone].panels.push(panel);
    d[zone].active = panel;
    d.lastZone[panel] = zone;
    this.saveLayout();
  }

  /** Show a zone member's tab. */
  activateDockTab(zone: DockZoneId, panel: DockPanelId) {
    if (!this.state.layout.dock[zone].panels.includes(panel)) return;
    this.state.layout.dock[zone].active = panel;
    this.saveLayout();
  }

  /** dockVisible flag → dock membership. Hide records the panel's zone in lastZone;
   *  show re-docks it there. Includes `"rules"` — the View menu can hide the Rule
   *  Panel like any other tool window.
   *  Returns true when membership changed — callers reconcile the zone DOM only then,
   *  so a notify() during a tab drag cannot rebuild the strip mid-gesture. */
  syncDockMembership(): boolean {
    const s = this.state;
    const d = s.layout.dock;
    let changed = false;
    for (const name of Object.keys(s.dockVisible) as (keyof AppState["dockVisible"])[]) {
      if (name === "rules") continue;   // rules is a subpane of each view group, not a dock-zone member
      const zone = this.dockPanelZone(name);
      if (s.dockVisible[name] && !zone) {
        const target = d.lastZone[name] ?? "left";
        d[target].panels.push(name);
        d[target].active = name;
        changed = true;
      } else if (!s.dockVisible[name] && zone) {
        const z = d[zone];
        d.lastZone[name] = zone;
        z.panels = z.panels.filter((p) => p !== name);
        if (z.active === name) z.active = z.panels[0] ?? null;
        changed = true;
      }
    }
    if (changed) this.saveLayout();
    return changed;
  }
}

/** What the rule bar shows for the active cell. Qt (lib_gui/app.py, _sync_rule_bar_from_current)
 *  shows `=expr` for any cell a rule computes (cube rules too, via the rule_detail query) and for
 *  error cells, otherwise the value. One deliberate difference: for an override Qt shows the rule
 *  hidden under it (`=3` while the cell holds 5); here the bar shows the value the cell holds. */
/** om-core `make_viewport_cell_key`: JSON keys joined by U+F8FF (private-use). */
export function makeViewportCellKey(rowKey: string[], colKey: string[]): string {
  return JSON.stringify(rowKey) + "\uf8ff" + JSON.stringify(colKey);
}

export function ruleBarText(cell: CellDTO | null | undefined): string {
  if (!cell) return "";
  const ex = cell.explain;
  if (ex && (ex.source === "rule" || ex.source === "error") && ex.rule_body != null) return `=${ex.rule_body}`;
  return cell.value == null ? "" : String(cell.value);
}

/** Hint shown wherever a value or rule is typed (Set Rule dialog). */
export const SET_RULE_PLACEHOLDER = "value, =expr for this cell, or Dim.Item = expr";

export type CellInput =
  | { kind: "cubeRule"; lhs: string; expr: string; anchored: boolean }
  | { kind: "cellRule"; expr: string }
  | { kind: "value"; value: string | number };

/** Classify typed text the way the Qt rule bar does (om-core lib_gui/app.py, _on_rule_bar_enter):
 *  - `=expr`               → rule for the target cell (set_rule_anchored);
 *  - `Dim.Item = expr`     → rule for the cube; `$` before the target makes it anchored (set_rule);
 *  - anything else         → value (hardvalue override); numeric text becomes a number.
 *  Surrounding double quotes are stripped. Returns null for empty input. */
export function parseCellInput(raw: string): CellInput | null {
  let text = raw.trim();
  if (text.length >= 2 && text.startsWith("\"") && text.endsWith("\"")) text = text.slice(1, -1).trim();
  if (!text) return null;
  if (text.startsWith("=")) {
    const expr = text.slice(1).trim();
    return expr ? { kind: "cellRule", expr } : null;
  }
  // Split on the first "=" only, so the expression may contain "=" itself.
  const m = /^(.*?)\s*=\s*([\s\S]+)$/.exec(text);
  if (m && m[1].trim()) {
    let lhs = m[1].trim();
    let anchored = false;
    if (lhs.startsWith("$")) { anchored = true; lhs = lhs.slice(1).trim(); }
    if (lhs === "*") lhs = "*.*";
    return { kind: "cubeRule", lhs, expr: m[2].trim(), anchored };
  }
  return { kind: "value", value: isNaN(Number(text)) ? text : Number(text) };
}
