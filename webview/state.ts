import { OmApi, DimSummary, DimDetail, CubeSummary, ViewSummary, ViewDetail, CellRangeDTO, RuleDTO, WorkspaceSummary, CellDTO } from "./api";
import { formatCellValue } from "./formatting";
import { alertDialog } from "./components/dialogs";
import { DEFAULT_DOCK, DEFAULT_OPTIONS, type DockPanelId, type DockZoneId, type UiLayout, type UiOptions } from "../shared/messages";

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
  dirty: boolean;
  filePath: string | null;
  /** From the host config: native Open/Save dialogs (VS Code) or a text field (browser). */
  nativeFileDialogs: boolean;
  /** Host answers `fsList` (bridge): Open/Save use a server-side file-browser dialog. */
  serverFileBrowse: boolean;
  /** From the host config: absolute folder for default file paths in the text field. */
  defaultDir: string;
  canUndo: boolean;
  canRedo: boolean;
  undoDesc: string;
  redoDesc: string;
  engineType: string;
  depTrackingEnabled: boolean;
  mtEnabled: boolean;
  isRemote: boolean;
  dockVisible: { browser: boolean; info: boolean; format: boolean; perf: boolean; timeline: boolean; rules: boolean };
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
    dirty: false,
    filePath: null,
    nativeFileDialogs: false,
    serverFileBrowse: false,
    defaultDir: "",
    canUndo: false,
    canRedo: false,
    undoDesc: "",
    redoDesc: "",
    engineType: "python",
    depTrackingEnabled: true,
    mtEnabled: false,
    isRemote: false,
    // perf/timeline are outside the MVP (their View menu items are disabled), so start hidden.
    dockVisible: { browser: true, info: false, format: false, perf: false, timeline: false, rules: true },
    viewGroups: [{ id: "g0", tabs: [], activeTab: null, rulesOpen: true, rulesCollapsed: false }],
    viewStates: {},
    focusedGroup: "g0",
    viewArea: { kind: "group", gid: "g0" },
    layout: { ...DEFAULT_LAYOUT, dock: structuredClone(DEFAULT_DOCK) },
    options: { ...DEFAULT_OPTIONS },
  };
  api: OmApi;
  private listeners = new Set<Listener>();
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
  notify() {
    // A throwing subscriber must not starve the rest — or unwind into a caller
    // mid-gesture (a drag's update→set→apply→notify chain dies with it).
    for (const l of [...this.listeners]) {
      try { l(); } catch (e) { console.error("notify subscriber failed", e); }
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

  async refreshModel() {
    const [dims, cubes, views, ws] = await Promise.all([
      this.api.dimensionList(),
      this.api.cubeList(),
      this.api.viewList(),
      this.api.workspaceSummary(),
    ]);
    this.set({ dimensions: dims.dimensions, cubes: cubes.cubes, views: views.views, workspaceSummary: ws });
    this.syncTabsWithViews();
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
      this.state.viewStates[viewId] = {
        viewId, viewName: detail.name, cubeId: detail.cube_id,
        rowDimIds: detail.row_dim_ids, colDimIds: detail.col_dim_ids, pageDimIds: detail.page_dim_ids,
        pageSelections: pageSel,
        rowKeys: rk, colKeys: ck, rowHeaders, colHeaders,
        cells,
        selectedRow: prev && prev.viewId === viewId && prev.selectedRow >= 0 && prev.selectedRow < rk.length ? prev.selectedRow : (rk.length ? 0 : -1),
        selectedCol: prev && prev.viewId === viewId && prev.selectedCol >= 0 && prev.selectedCol < ck.length ? prev.selectedCol : (ck.length ? 0 : -1),
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
      await this.updateSelectionStats();
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
    this.notify();
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
      this.notify();
      await this.loadView(v.viewId);
    } catch (e: any) { console.error("setPageItem failed", e); }
  }

  async refreshRules() {
    try {
      const r = await this.api.workspaceRules();
      this.set({ rules: r.rules || [], ruleOrder: r.rule_order || [] });
    } catch {}
  }

  async updateSelectionStats() {
    const v = this.state.activeView;
    if (!v || !v.cells || v.selectedRow < 0 || v.selectedCol < 0) {
      this.state.selectionStats = {};
      this.notify();
      return;
    }
    try {
      const stats = await this.api.selectionStats({
        view_id: v.viewId,
        mode: v.selMode,
        page_selections: v.pageSelections,
        row: v.selectedRow,
        col: v.selectedCol,
      });
      this.state.selectionStats = stats;
      this.notify();
    } catch {
      // fallback: compute locally
      const nums: number[] = [];
      const cells = this.iterSelectedCells();
      for (const [r, c] of cells) {
        const cell = v.cells.cells[r * v.colKeys.length + c];
        if (cell && typeof cell.value === "number") nums.push(cell.value);
      }
      const sum = nums.reduce((a, b) => a + b, 0);
      this.state.selectionStats = { sum, avg: nums.length ? sum / nums.length : 0, count: nums.length, counta: nums.length };
      this.notify();
    }
  }

  *iterSelectedCells(gid?: string): Generator<[number, number]> {
    const v = this.viewOf(gid);
    if (!v || !v.cells) return;
    if (v.selMode === "all") {
      for (let r = 0; r < v.rowKeys.length; r++) for (let c = 0; c < v.colKeys.length; c++) yield [r, c];
    } else if (v.selMode === "row") {
      for (const idx of v.selIndices as Set<number>) for (let c = 0; c < v.colKeys.length; c++) yield [idx, c];
    } else if (v.selMode === "col") {
      for (const idx of v.selIndices as Set<number>) for (let r = 0; r < v.rowKeys.length; r++) yield [r, idx];
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
   *  Grammar is parseCellInput(). `at` is the target cell for the grid editor; without it the
   *  active cell is used and, as in Qt, a multi-cell selection is refused for cell entries. */
  async applyInput(raw: string, at?: { row: number; col: number }, gid?: string) {
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
        const row = at ? at.row : v.selectedRow;
        const col = at ? at.col : v.selectedCol;
        const cell = row >= 0 && col >= 0 ? v.cells.cells[row * v.colKeys.length + col] : undefined;
        if (!cell?.addr) { await alertDialog("No cell selected", "Select a cell and try again."); return; }
        if (input.kind === "cellRule") {
          await this.api.setRuleAnchored(v.viewId, { kind: "ids", row_key: cell.row_key, col_key: cell.col_key }, input.expr);
        } else {
          await this.api.setCellHardvalueByAddr(v.cubeId, cell.addr, input.value);
        }
      }
      this.markDirty();
      await this.api.recalc("dirty");
      await this.loadView(v.viewId);
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
      .map(([r, c]) => v.cells!.cells[r * v.colKeys.length + c])
      .filter((cell) => cell?.addr && !["rule", "empty"].includes(cell.explain?.source));
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
    return v.cells.cells[v.selectedRow * v.colKeys.length + v.selectedCol];
  }

  private async clearHardvalues(cells: CellDTO[], v: ViewState) {
    if (!v || !cells.length) return;
    try {
      for (const cell of cells) await this.api.clearCellHardvalue(v.viewId, { kind: "ids", row_key: cell.row_key, col_key: cell.col_key });
      this.markDirty();
      await this.api.recalc("dirty");
      await this.loadView(v.viewId);
    } catch (e: any) { await alertDialog("Clear failed", e?.message || String(e)); }
  }

  async copySelectionToClipboard(gid?: string): Promise<string> {
    const v = this.viewOf(gid);
    if (!v || !v.cells) return "";
    const cells = [...this.iterSelectedCells(gid)];
    if (!cells.length) return "";
    const rows = new Map<number, Map<number, string>>();
    for (const [r, c] of cells) {
      const cell = v.cells.cells[r * v.colKeys.length + c];
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
        if (r >= v.rowKeys.length || c >= v.colKeys.length) continue;
        const cell = v.cells.cells[r * v.colKeys.length + c];
        if (!cell?.addr) continue;
        const raw = grid[dr][dc];
        const val = raw === "" ? "" : (isNaN(Number(raw)) ? raw : Number(raw));
        entries.push({ addr: cell.addr, value: val });
      }
    }
    if (!entries.length) return;
    try {
      await this.api.setCellHardvaluesBatchByAddr(v.cubeId, entries);
      this.markDirty();
      await this.api.recalc("dirty");
      await this.loadView(v.viewId);
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
      return true;
    } catch (e: any) { await alertDialog("Save failed", e?.message || String(e)); return false; }
  }
  /** File → Open. On failure the runtime keeps the current workspace (cmd_load fails before replacing it),
   *  so the UI is left as it was. */
  async loadWorkspaceFile(path: string) {
    try { await this.api.loadWorkspace(path); } catch (e: any) { await alertDialog("Load failed", e?.message || String(e)); return; }
    await this.resetWorkspaceUi(path, true);
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
  private async resetWorkspaceUi(filePath: string | null, ensureView: boolean) {
    this.dimCache.clear();
    this.cubeCache.clear();
    Object.assign(this.state, {
      selectionStats: {}, filePath, dirty: false,
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
      const views = this.visibleViews();
      const saved = this.state.workspaceSummary?.saved_default_view_id;
      const v = views.find((x) => x.id === saved) || views[0];
      if (v) await this.openView(v.id, v.name);
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

  toggleDock(name: keyof AppState["dockVisible"]) {
    this.state.dockVisible[name] = !this.state.dockVisible[name];
    this.notify();
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
