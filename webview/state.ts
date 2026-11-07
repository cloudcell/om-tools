import { OmApi, DimSummary, DimDetail, CubeSummary, ViewSummary, ViewDetail, CellRangeDTO, RuleDTO, WorkspaceSummary, CellDTO } from "./api";
import { alertDialog } from "./components/dialogs";

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
  loading: boolean;
}

export interface AppState {
  connected: boolean;
  statusMessage: string;
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
  canUndo: boolean;
  canRedo: boolean;
  undoDesc: string;
  redoDesc: string;
  engineType: string;
  depTrackingEnabled: boolean;
  mtEnabled: boolean;
  isRemote: boolean;
  dockVisible: { browser: boolean; info: boolean; format: boolean; perf: boolean; timeline: boolean };
}

type Listener = () => void;

export class Store {
  state: AppState = {
    connected: false,
    statusMessage: "disconnected",
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
    canUndo: false,
    canRedo: false,
    undoDesc: "",
    redoDesc: "",
    engineType: "python",
    depTrackingEnabled: true,
    mtEnabled: false,
    isRemote: false,
    // perf/timeline are outside the MVP (their View menu items are disabled), so start hidden.
    dockVisible: { browser: true, info: false, format: false, perf: false, timeline: false },
  };
  api: OmApi;
  private listeners = new Set<Listener>();
  dimCache = new Map<string, DimDetail>();
  cubeCache = new Map<string, any>();

  constructor(api: OmApi) { this.api = api; }

  subscribe(fn: Listener): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  notify() { for (const l of this.listeners) l(); }

  set(partial: Partial<AppState>) { Object.assign(this.state, partial); this.notify(); }

  setStatus(connected: boolean, message: string) {
    this.state.connected = connected;
    this.state.statusMessage = message;
    this.notify();
  }

  markDirty(d = true) { this.state.dirty = d; this.notify(); }

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
    else this.dimCache.clear();
  }

  async refreshModel() {
    const [dims, cubes, views, ws] = await Promise.all([
      this.api.dimensionList(),
      this.api.cubeList(),
      this.api.viewList(),
      this.api.workspaceSummary(),
    ]);
    this.set({ dimensions: dims.dimensions, cubes: cubes.cubes, views: views.views, workspaceSummary: ws });
  }

  async refreshUndoState() {
    try {
      const s = await this.api.undoState();
      this.set({ canUndo: s.can_undo, canRedo: s.can_redo, undoDesc: s.undo_description || "", redoDesc: s.redo_description || "" });
    } catch {}
  }

  async openView(viewId: string, viewName: string) {
    if (!this.state.openTabs.find((t) => t.viewId === viewId)) {
      this.state.openTabs.push({ viewId, viewName });
    }
    this.state.activeTab = viewId;
    this.notify();
    await this.loadView(viewId);
  }

  async loadView(viewId: string) {
    if (!this.state.activeView || this.state.activeView.viewId !== viewId) {
      this.state.activeView = { viewId, viewName: "", cubeId: "", rowDimIds: [], colDimIds: [], pageDimIds: [], pageSelections: {}, rowKeys: [], colKeys: [], rowHeaders: [], colHeaders: [], cells: null, selectedRow: -1, selectedCol: -1, selMode: "cell", selIndices: new Set(), anchorRow: 0, anchorCol: 0, loading: true };
    } else {
      this.state.activeView.loading = true;
    }
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
      const prev = this.state.activeView;
      this.state.activeView = {
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
        loading: false,
      };
      this.state.focusPath = `OM Core View: ${detail.name}`;
      this.notify();
      await this.refreshRules();
      await this.updateSelectionStats();
      await this.refreshUndoState();
    } catch (e: any) {
      this.state.activeView = { ...this.state.activeView!, loading: false };
      this.notify();
      console.error("loadView failed", e);
    }
  }

  async moveDimension(dimId: string, dest: "row" | "col" | "page", index?: number) {
    const v = this.state.activeView;
    if (!v) return;
    try {
      await this.api.moveViewDimension(v.viewId, dimId, dest, index);
      this.markDirty();
      await this.loadView(v.viewId);
    } catch (e: any) { console.error("moveDimension failed", e); await alertDialog("Move dimension failed", e?.message || String(e)); }
  }

  async setPageItem(dimId: string, itemId: string) {
    const v = this.state.activeView;
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

  *iterSelectedCells(): Generator<[number, number]> {
    const v = this.state.activeView;
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

  setSelection(row: number, col: number) {
    if (!this.state.activeView) return;
    this.state.activeView.selectedRow = row;
    this.state.activeView.selectedCol = col;
    this.notify();
    this.updateSelectionStats();
  }

  setSelectionFull(row: number, col: number, mode: SelMode, indices: Set<any>, anchorRow?: number, anchorCol?: number) {
    if (!this.state.activeView) return;
    const v = this.state.activeView;
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
  async applyInput(raw: string, at?: { row: number; col: number }) {
    const v = this.state.activeView;
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
        if (!at && this.hasMultiCellSelection()) {
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

  private hasMultiCellSelection(): boolean {
    let n = 0;
    for (const _ of this.iterSelectedCells()) if (++n > 1) return true;
    return false;
  }

  async clearSelectedCells() {
    const v = this.state.activeView;
    if (!v || !v.cells) return;
    const cells = [...this.iterSelectedCells()];
    if (!cells.length) return;
    try {
      for (const [r, c] of cells) {
        const cell = v.cells.cells[r * v.colKeys.length + c];
        if (cell?.addr) await this.api.clearCellHardvalue(v.viewId, { kind: "ids", row_key: cell.row_key, col_key: cell.col_key });
      }
      this.markDirty();
      await this.api.recalc("dirty");
      await this.loadView(v.viewId);
    } catch (e: any) { console.error("clearSelectedCells", e); }
  }

  async copySelectionToClipboard(): Promise<string> {
    const v = this.state.activeView;
    if (!v || !v.cells) return "";
    const cells = [...this.iterSelectedCells()];
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

  async pasteFromClipboard(text: string) {
    const v = this.state.activeView;
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

  async undo() {
    try { await this.api.undo(); this.markDirty(); await this.refreshModel(); await this.refreshUndoState(); if (this.state.activeView) await this.loadView(this.state.activeView.viewId); await this.refreshRules(); } catch (e: any) { await alertDialog("Undo failed", e?.message || String(e)); }
  }
  async redo() {
    try { await this.api.redo(); this.markDirty(); await this.refreshModel(); await this.refreshUndoState(); if (this.state.activeView) await this.loadView(this.state.activeView.viewId); await this.refreshRules(); } catch (e: any) { await alertDialog("Redo failed", e?.message || String(e)); }
  }

  async recalc(scope = "all") {
    try { await this.api.recalc(scope); if (this.state.activeView) await this.loadView(this.state.activeView.viewId); } catch (e: any) { await alertDialog("Recalc failed", e?.message || String(e)); }
  }

  async newWorkspace() {
    try { await this.api.createNewWorkspace(); this.state.filePath = null; this.markDirty(false); await this.refreshModel(); await this.refreshRules(); await this.refreshUndoState(); } catch (e: any) { await alertDialog("New workspace failed", e?.message || String(e)); }
  }
  async saveWorkspace(path?: string) {
    try { await this.api.saveWorkspace(path); this.state.filePath = path || null; this.markDirty(false); } catch (e: any) { await alertDialog("Save failed", e?.message || String(e)); }
  }
  async loadWorkspaceFile(path: string) {
    try { await this.api.loadWorkspace(path); this.state.filePath = path; this.markDirty(false); await this.refreshModel(); await this.refreshRules(); await this.refreshUndoState(); } catch (e: any) { await alertDialog("Load failed", e?.message || String(e)); }
  }

  toggleDock(name: keyof AppState["dockVisible"]) {
    this.state.dockVisible[name] = !this.state.dockVisible[name];
    this.notify();
  }
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
