import { Store, SelMode } from "../state";
import { el, clear } from "../dom";
import { CellDTO, DimDetail } from "../api";
import { PivotBar } from "./pivotBar";
import { inputDialog, confirmDialog, alertDialog, pickDialog } from "./dialogs";

// ---- Types ----
interface AxisEntry {
  is_leaf: boolean;
  item_id: string | null;
  key?: string[];            // the axis key tuple this entry maps to (e.g. [itemId], multi-dim tuple, or [] for empty axis)
  labels: string[];           // [group1, group2, ..., leafLabel]
  label_paths: (number[] | null)[];  // outline path per label level
  label_dims?: (number | null)[];    // dim index per label level (stacked mode)
  path: number[];            // full outline path (in the entry's own dim for stacked axes)
  dim?: number;              // dim index on the axis (stacked mode)
  is_aggregate: boolean;
  node_id?: string | null;
}

interface Band {
  level: number;
  start: number;  // r0 or c0
  end: number;    // r1 or c1
  label: string;
  path: number[] | null;
  dim?: number;   // dim index on the axis (stacked mode)
  shaded: boolean;
  is_group: boolean;
}

type DropZone =
  | { mode: "reorder"; index: number; after: boolean; dim?: number }
  | { mode: "into"; groupPath: number[]; dim?: number }
  | { mode: "before"; groupPath: number[]; dim?: number }
  | { mode: "after"; groupPath: number[]; dim?: number };

interface GridMetrics {
  rowHeaderW: number;   // per-level width
  colHeaderH: number;   // per-level height
  rowH: number;
  colW: number;
}

const METRICS: GridMetrics = { rowHeaderW: 100, colHeaderH: 24, rowH: 22, colW: 90 };
const COLORS = {
  gridline: "#d0d0d0",
  headerBg: "#f2f4f8",
  headerFg: "#202020",
  selBg: "rgba(42, 118, 210, 0.55)",
  selFg: "#ffffff",
  relatedBg: "#d8deeb",
  groupShade: "#d0d0d0",
  hardnumberBg: "#ffff99",
  hardnumberTri: "#ff0000",
  groupOutline: "rgb(25, 118, 210)",
  currentCell: "rgb(80, 80, 80)",
  badgeBg: "rgb(220, 220, 220)",
  badgeBorder: "rgb(100, 100, 100)",
  badgeFg: "rgb(50, 50, 50)",
};

/** MultilevelGrid — custom-painted multilevel grid with band computation,
 *  outline groups, collapse/expand, aggregate items, and Quantrix-like grouping.
 *  Mirrors lib_gui_elements/matrix_grid.py paintEvent + banding.py. */
export class MultilevelGrid {
  constructor(private store: Store) {}
  root = el("div", { class: "center", tabindex: "0" }) as HTMLElement;
  private pivot = new PivotBar(this.store);
  private gridMount: HTMLElement | null = null;

  // Grid state
  private rows: AxisEntry[] = [];
  private cols: AxisEntry[] = [];
  private rowKeys: string[][] = [];
  private colKeys: string[][] = [];
  private cells: CellDTO[] = [];
  private cellRowMap: number[] = [];  // grid row index -> cell data row index (-1 = placeholder)
  private cellColMap: number[] = [];  // grid col index -> cell data col index (-1 = placeholder)
  private rowBands: Band[] = [];
  private colBands: Band[] = [];
  private rowHeaderLevels = 1;
  private colHeaderLevels = 1;
  private rowBandLevels = 0;
  private colBandLevels = 0;
  private rowCollapsed = new Set<string>();  // path keys
  private colCollapsed = new Set<string>();

  // User-resizable widths (native _col_widths / _row_header_widths)
  private colWidths: Record<number, number> = {};
  private rowLevelWidths: Record<number, number> = {};
  private colOffsets: number[] = [];      // colOffsets[c] = data-x of col c; [len] = total data width
  private rowLevelOffsets: number[] = []; // rowLevelOffsets[l] = x of header level l; [levels] = total row-header width
  private resizeState: { kind: "col" | "rowLevel"; index: number; startX: number; startW: number; moved: boolean } | null = null;
  private suppressClickOnce = false;

  private colW(c: number) { return this.colWidths[c] ?? METRICS.colW; }
  private rowLevelW(l: number) { return this.rowLevelWidths[l] ?? METRICS.rowHeaderW; }

  // Convert client coordinates to (r, c) cell coordinates (for drag-select)
  private cellAtPoint(clientX: number, clientY: number): { r: number; c: number } | null {
    const scroll = this.gridMount?.querySelector(".ml-grid-scroll") as HTMLElement;
    if (!scroll) return null;
    const rect = scroll.getBoundingClientRect();
    const viewX = clientX - rect.left + scroll.scrollLeft;
    const viewY = clientY - rect.top + scroll.scrollTop;
    const rowHeaderW = this.rowHeaderWTotal();
    const colHeaderH = METRICS.colHeaderH * this.colHeaderLevels;
    if (viewX < rowHeaderW || viewY < colHeaderH) return null;
    const x = viewX - rowHeaderW;
    const y = viewY - colHeaderH;
    let c = -1;
    for (let i = 0; i < this.cols.length; i++) {
      if (this.colOffsets[i] <= x && x < this.colOffsets[i + 1]) { c = i; break; }
    }
    if (c < 0) return null;
    const r = Math.floor(y / METRICS.rowH);
    if (r < 0 || r >= this.rows.length) return null;
    return { r, c };
  }
  private rebuildOffsets() {
    const co = new Array<number>(this.cols.length + 1);
    let x = 0;
    for (let c = 0; c < this.cols.length; c++) { co[c] = x; x += this.colW(c); }
    co[this.cols.length] = x;
    this.colOffsets = co;
    const ro = new Array<number>(this.rowHeaderLevels + 1);
    let rx = 0;
    for (let l = 0; l < this.rowHeaderLevels; l++) { ro[l] = rx; rx += this.rowLevelW(l); }
    ro[this.rowHeaderLevels] = rx;
    this.rowLevelOffsets = ro;
  }
  private rowHeaderWTotal() { return this.rowLevelOffsets[this.rowHeaderLevels] ?? this.rowHeaderLevels * METRICS.rowHeaderW; }
  private dataWTotal() { return this.colOffsets[this.cols.length] ?? this.cols.length * METRICS.colW; }

  // Drag state (mirrors native matrix_grid.py drag/drop)
  private dragPayload: {
    axis: "row" | "col";
    itemId: string | null;         // leaf item being dragged
    groupPath: number[] | null;    // group band outline path (if dragging a group)
    groupDim?: number;             // dim index of the dragged group (stacked mode)
    groupNodeId: string | null;    // group graph node id
    selectedItems: string[] | null; // multi-selection item ids
  } | null = null;
  private dropIndicator: HTMLElement | null = null;
  private dropHighlight: HTMLElement | null = null;

  // Cell drag-select (rubberband) state
  private cellDragActive = false;
  private cellDragCtrl = false;

  // Selection
  private selRow = -1;
  private selCol = -1;
  private selMode: SelMode = "cell";
  private selIndices: Set<any> = new Set();
  private anchorRow = 0;
  private anchorCol = 0;

  // Editor
  private editor: HTMLInputElement | null = null;
  // Cell the open editor belongs to — selection can move while it is open
  private editorCell: { r: number; c: number } | null = null;

  // Header label editor (native: inline QLineEdit over leaf header / group band)
  private headerEdit: {
    input: HTMLInputElement;
    type: "leaf" | "group";
    axis: "row" | "col";
    index?: number;        // leaf entry index
    groupPath?: number[];  // group band outline path
    dimIdx?: number;       // dim index of the group (stacked mode)
    itemId?: string;       // leaf item id
    dimId: string;
    origName: string;
    committing: boolean;
  } | null = null;

  render(): HTMLElement {
    this.store.subscribe(() => this.refresh());
    this.refresh();
    // Keydown is handled on the scroll element (inside renderGrid) to avoid
    // double-firing: root contains scroll, so a root-level listener would
    // fire alongside the scroll-level one, moving selection by 2.
    return this.root;
  }

  copyToClipboard() { this.doCopy(); }
  pasteFromClipboard() { this.doPaste(); }

  // ---- Refresh ----
  private refresh() {
    clear(this.root);

    // tab bar
    const tabbar = el("div", { class: "tabbar" });
    for (const tab of this.store.state.openTabs) {
      const t = el("div", { class: "tab" + (tab.viewId === this.store.state.activeTab ? " active" : "") }, [
        document.createTextNode(tab.viewName),
        el("span", { class: "tab-close", title: "Close", onclick: (e: Event) => { e.stopPropagation(); this.closeTab(tab.viewId); } }, ["×"]),
      ]);
      t.addEventListener("click", () => { this.store.state.activeTab = tab.viewId; this.store.loadView(tab.viewId); });
      tabbar.appendChild(t);
    }
    if (this.store.state.openTabs.length === 0) tabbar.appendChild(el("div", { class: "muted", style: { padding: "6px 10px" } }, ["No view open. Click a view in the Model Browser →"]));
    this.root.appendChild(tabbar);

    const v = this.store.state.activeView;
    if (!v) {
      this.root.appendChild(el("div", { class: "grid-empty", style: { flex: "1", display: "flex", alignItems: "center", justifyContent: "center" } }, ["Open a view from the Model Browser to begin."]));
      return;
    }

    // pivot canvas (3 zones + grid mount)
    const { container, gridMount } = this.pivot.render();
    this.gridMount = gridMount;
    this.root.appendChild(container);

    if (v.loading) { gridMount.appendChild(el("div", { class: "grid-loading" }, ["Loading view…"])); return; }
    if (!v.cells || v.rowKeys.length === 0 || v.colKeys.length === 0) {
      gridMount.appendChild(el("div", { class: "grid-empty" }, ["This view has no rows or columns for the current page selection."]));
      return;
    }

    // Build the multilevel grid
    this.buildGrid(v);
    this.renderGrid(gridMount);
  }

  // ---- Build grid entries from view data ----
  private widthsViewId: string | null = null;
  private buildGrid(v: any) {
    if (this.widthsViewId !== v.viewId) { this.widthsViewId = v.viewId; this.colWidths = {}; this.rowLevelWidths = {}; }
    this.rowKeys = v.rowKeys;
    this.colKeys = v.colKeys;
    this.cells = v.cells.cells;
    this.selRow = v.selectedRow;
    this.selCol = v.selectedCol;
    this.selMode = v.selMode;
    this.selIndices = v.selIndices;
    this.anchorRow = v.anchorRow;
    this.anchorCol = v.anchorCol;

    // Build row entries
    this.rows = this.buildAxisEntries(v.rowDimIds, v.rowKeys, v.rowHeaders, "row");
    this.cols = this.buildAxisEntries(v.colDimIds, v.colKeys, v.colHeaders, "col");

    // Header levels = max label depth (uniform for flat/outlined/stacked axes)
    const rowDepth = this.rows.reduce((mx, e) => Math.max(mx, e.labels.length), 1);
    this.rowBandLevels = Math.max(0, rowDepth - 1);
    this.rowHeaderLevels = Math.max(1, rowDepth);
    const colDepth = this.cols.reduce((mx, e) => Math.max(mx, e.labels.length), 1);
    this.colBandLevels = Math.max(0, colDepth - 1);
    this.colHeaderLevels = Math.max(1, colDepth);

    // Build cell index maps: grid row/col -> cell data row/col.
    // Empty group placeholders (is_leaf=false, item_id=null) have no cell data.
    const keyIndex = (keys: string[][], key: string[] | undefined) =>
      key ? keys.findIndex((k) => k.length === key.length && k.every((p, i) => p === key[i])) : -1;
    this.cellRowMap = this.rows.map((e) =>
      !e.is_leaf ? -1 : keyIndex(v.rowKeys, e.key ?? (e.item_id !== null ? [e.item_id] : [])));
    this.cellColMap = this.cols.map((e) =>
      !e.is_leaf ? -1 : keyIndex(v.colKeys, e.key ?? (e.item_id !== null ? [e.item_id] : [])));
    // console.log("[buildGrid] rowKeys:", v.rowKeys, "colKeys:", v.colKeys, "rows:", this.rows.length, "cols:", this.cols.length, "cellRowMap:", this.cellRowMap, "cellColMap:", this.cellColMap);

    // Compute bands
    this.rowBands = this.computeBands(this.rows, this.rowBandLevels, "row");
    this.colBands = this.computeBands(this.cols, this.colBandLevels, "col");
  }

  private buildAxisEntries(dimIds: string[], keys: string[][], headers: string[], axis: "row" | "col"): AxisEntry[] {
    if (!keys.length) return [];

    // Empty axis: all dims stacked on other axes → engine returns one empty key
    // [()]; native still renders a single column/row of real cells.
    if (!dimIds.length) {
      return [{ is_leaf: true, item_id: null, key: keys[0] ?? [], labels: [""], label_paths: [null], path: [0], is_aggregate: false }];
    }

    // Get dimension details from cache
    const dimDetails = dimIds.map((id) => this.store.dimCache.get(id)).filter(Boolean) as DimDetail[];

    // Check if we have outline data
    const hasOutline = dimDetails.some((d) => d?.outline && d.outline.length > 0);

    if (dimIds.length === 1 && hasOutline) {
      return this.buildOutlinedEntries(dimIds[0], dimDetails[0], keys, headers, axis);
    }

    if (dimIds.length === 1) {
      // Single dim, no outline: simple entries with 1 label level
      const dim = dimDetails[0];
      const nameMap = new Map<string, string>();
      if (dim) for (const it of dim.items) nameMap.set(it.id, it.name);
      return keys.map((k, i) => {
        const iid = k[0];
        const label = nameMap.get(iid) || headers[i] || iid.slice(0, 8);
        return { is_leaf: true, item_id: iid, key: k, labels: [label], label_paths: [null], path: [i], is_aggregate: false };
      });
    }

    // Stacked dimensions: each dim contributes (max group depth + leaf) label
    // levels — mirrors native _group_labels_by_item / dim_max_depths.
    const dimNameMaps = dimIds.map((id) => {
      const d = this.store.dimCache.get(id);
      const m = new Map<string, string>();
      if (d) for (const it of d.items) m.set(it.id, it.name);
      return m;
    });

    const collapsed = axis === "row" ? this.rowCollapsed : this.colCollapsed;

    // Per-dim outline walk: item_id -> ancestor group labels/paths + aggregate
    // flag + items hidden inside collapsed groups.
    const dimInfos = dimIds.map((id, d) => {
      const dim = this.store.dimCache.get(id);
      const info = new Map<string, { labels: string[]; paths: number[][]; ownPath: number[]; isAggregate: boolean }>();
      const hidden = new Set<string>();
      const hideSubtree = (n: any) => {
        if (typeof n.item_id === "string") { hidden.add(n.item_id); return; }
        for (const c of n.children || []) hideSubtree(c);
      };
      const walk = (nodes: any[], gLabels: string[], gPaths: number[][], prefix: number[]) => {
        for (let i = 0; i < nodes.length; i++) {
          const n = nodes[i];
          const p = [...prefix, i];
          const isGroup = n.item_id === null && typeof n.node_id === "string";
          if (isGroup) {
            const children = n.children || [];
            const labels2 = [...gLabels, n.label ?? ""];
            const paths2 = [...gPaths, p];
            const isCollapsed = collapsed.has(`${d}:${p.join(",")}`);
            if (isCollapsed && children.length) {
              const aggs = children.filter((c: any) => c.is_aggregate);
              if (aggs.length) {
                // Collapsed: only direct aggregates stay visible; rest hidden
                for (let ci = 0; ci < children.length; ci++) {
                  const c = children[ci];
                  if (c.is_aggregate && typeof c.item_id === "string") info.set(c.item_id, { labels: labels2, paths: paths2, ownPath: [...p, ci], isAggregate: true });
                }
                for (const c of children) if (!c.is_aggregate) hideSubtree(c);
              } else {
                walk(children, labels2, paths2, p);
              }
            } else {
              walk(children, labels2, paths2, p);
            }
            continue;
          }
          if (typeof n.item_id === "string") {
            info.set(n.item_id, { labels: gLabels, paths: gPaths, ownPath: p, isAggregate: !!n.is_aggregate });
          }
        }
      };
      walk(dim?.outline || [], [], [], []);
      return { info, hidden };
    });
    const dimMaxDepths = dimInfos.map((di) => Math.max(0, ...[...di.info.values()].map((x) => x.labels.length)));

    // Drop keys containing items hidden inside collapsed groups
    const visibleKeys = keys.filter((k) => !k.some((iid, d) => dimInfos[d].hidden.has(iid)));

    return visibleKeys.map((k, i) => {
      const labels: string[] = [];
      const labelPaths: (number[] | null)[] = [];
      const labelDims: (number | null)[] = [];
      for (let d = 0; d < dimIds.length; d++) {
        const iid = k[d];
        const g = dimInfos[d].info.get(iid);
        const gl = g?.labels ?? [], gp = g?.paths ?? [];
        for (let lvl = 0; lvl < dimMaxDepths[d]; lvl++) {
          if (lvl < gl.length) { labels.push(gl[lvl]); labelPaths.push(gp[lvl]); }
          else { labels.push(""); labelPaths.push(null); }
          labelDims.push(d);
        }
        labels.push(dimNameMaps[d].get(iid) || (typeof iid === "string" ? iid.slice(0, 8) : ""));
        labelPaths.push(null);  // leaf level is not a group
        labelDims.push(d);
      }
      const isAggregate = k.some((iid, d) => !!dimInfos[d].info.get(iid)?.isAggregate);
      const lastDim = dimIds.length - 1;
      const leafPath = dimInfos[lastDim].info.get(k[lastDim])?.ownPath ?? [i];
      return { is_leaf: true, item_id: k[k.length - 1], key: k, labels, label_paths: labelPaths, label_dims: labelDims, path: leafPath, dim: lastDim, is_aggregate: isAggregate };
    });
  }

  private buildOutlinedEntries(dimId: string, dim: DimDetail, keys: string[][], headers: string[], axis: "row" | "col"): AxisEntry[] {
    const outline = dim.outline || [];
    if (!outline.length) {
      const nameMap = new Map<string, string>();
      for (const it of dim.items) nameMap.set(it.id, it.name);
      return keys.map((k, i) => {
        const iid = k[0];
        const label = nameMap.get(iid) || headers[i] || iid.slice(0, 8);
        return { is_leaf: true, item_id: iid, key: k, labels: [label], label_paths: [null], path: [i], is_aggregate: false };
      });
    }

    const nameMap = new Map<string, string>();
    for (const it of dim.items) nameMap.set(it.id, it.name);
    const keyMap = new Map<string, string[]>();
    for (const k of keys) if (k.length === 1) keyMap.set(k[0], k);

    const entries: AxisEntry[] = [];
    const collapsed = axis === "row" ? this.rowCollapsed : this.colCollapsed;
    const hiddenItemIds = new Set<string>();

    // Collect item IDs inside collapsed groups so they aren't re-added as root items.
    // A group only truly collapses if it has aggregate children — otherwise it stays expanded.
    // Only the DIRECT aggregates of the collapsed group remain visible; everything else
    // (including nested group aggregates) is hidden.
    const collectHidden = (nodes: any[], prefixPath: number[], insideCollapsed: boolean) => {
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        const path = [...prefixPath, i];
        const isGroup = n.item_id === null && typeof n.node_id === "string";
        const isCollapsed = isGroup && collapsed.has(`0:${path.join(",")}`);
        const children = n.children || [];
        const hasAggregates = isGroup && children.some((c: any) => c.is_aggregate);
        const nowHidden = insideCollapsed || (isCollapsed && hasAggregates);
        if (nowHidden && n.item_id) hiddenItemIds.add(n.item_id);
        if (n.children) collectHidden(n.children, path, nowHidden);
      }
    };
    collectHidden(outline, [], false);

    const walk = (nodes: any[], prefixLabels: string[], prefixPaths: (number[] | null)[], prefixPath: number[], hidden: boolean) => {
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        const path = [...prefixPath, i];
        // A group is any node with item_id === null (has a node_id).
        // It may have children (items moved into it) or be empty.
        const isGroup = n.item_id === null && typeof n.node_id === "string";
        const pathKey = `0:${path.join(",")}`;
        const isCollapsed = collapsed.has(pathKey);
        const addLabel = isGroup && typeof n.label === "string" && n.label;
        const labels = addLabel ? [...prefixLabels, n.label] : [...prefixLabels];
        const labelPaths = addLabel ? [...prefixPaths, path] : [...prefixPaths];

        if (isGroup) {
          const children = n.children || [];
          if (isCollapsed && children.length > 0) {
            // Collapsed group: show only aggregate items (native behavior).
            // If no aggregates exist, don't collapse — show all children.
            const aggregates = children.filter((c: any) => c.is_aggregate);
            if (aggregates.length > 0) {
              walk(aggregates, labels, labelPaths, path, false);
            } else {
              walk(children, labels, labelPaths, path, hidden);
            }
          } else if (children.length > 0) {
            walk(children, labels, labelPaths, path, hidden || isCollapsed);
          }
          // Empty groups are invisible — they don't create grid rows.
          continue;
        }

        if (typeof n.item_id === "string" && keyMap.has(n.item_id)) {
          if (!hidden) {
            const leafLabel = nameMap.get(n.item_id) || n.item_id.slice(0, 8);
            const finalLabels = [...labels, leafLabel];
            const finalPaths = [...labelPaths, path];
            entries.push({
              is_leaf: true,
              item_id: n.item_id,
              key: keyMap.get(n.item_id),
              node_id: n.node_id,
              labels: finalLabels,
              label_paths: finalPaths,
              path,
              is_aggregate: !!n.is_aggregate,
            });
          }
        }
      }
    };

    walk(outline, [], [], [], false);

    // Append ungraphed items (skip items hidden inside collapsed groups)
    const addedIds = new Set(entries.map((e) => e.item_id));
    for (const it of dim.items) {
      if (keyMap.has(it.id) && !addedIds.has(it.id) && !hiddenItemIds.has(it.id)) {
        entries.push({
          is_leaf: true, item_id: it.id, key: keyMap.get(it.id), labels: [it.name], label_paths: [null],
          path: [entries.length], is_aggregate: false,
        });
      }
    }

    // Compute band levels from max label depth
    const maxDepth = entries.reduce((mx, e) => Math.max(mx, e.labels.length), 1);
    if (axis === "row") {
      this.rowBandLevels = Math.max(0, maxDepth - 1);
      this.rowHeaderLevels = Math.max(1, maxDepth);
    } else {
      this.colBandLevels = Math.max(0, maxDepth - 1);
      this.colHeaderLevels = Math.max(1, maxDepth);
    }

    return entries;
  }

  // ---- Band computation (mirrors banding.py) ----
  private computeBands(entries: AxisEntry[], bandLevels: number, axis: "row" | "col"): Band[] {
    const bands: Band[] = [];
    const isStacked = (axis === "row" ? (this.store.state.activeView?.rowDimIds || []) : (this.store.state.activeView?.colDimIds || [])).length > 1;

    for (let level = 0; level < bandLevels; level++) {
      let curLabel: string | null = null;
      let curStart = 0;
      let curPath: number[] | null = null;
      const levelBands: Band[] = [];

      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        const labels = e.labels || [];
        const lab = level < Math.max(0, labels.length - 1) ? (labels[level] || "") : "";
        const paths = e.label_paths || [];
        let path: number[] | null = null;
        if (lab && level >= 0 && level < paths.length) {
          const p = paths[level];
          path = Array.isArray(p) ? p : null;
        }

        if (curLabel === null) {
          curLabel = lab; curStart = i; curPath = path;
        } else if (lab !== curLabel || this.pathKey(path) !== this.pathKey(curPath)) {
          levelBands.push(this.makeBand(level, curStart, i - 1, curLabel, curPath, isStacked, entries[curStart].label_dims?.[level] ?? undefined));
          curLabel = lab; curStart = i; curPath = path;
        }
      }

      if (curLabel !== null && entries.length) {
        levelBands.push(this.makeBand(level, curStart, entries.length - 1, curLabel, curPath, isStacked, entries[curStart].label_dims?.[level] ?? undefined));
      }

      // Fill gaps with empty placeholders
      const filled: Band[] = [];
      let nextIdx = 0;
      for (const band of levelBands.sort((a, b) => a.start - b.start)) {
        if (band.start > nextIdx) {
          filled.push({ level, start: nextIdx, end: band.start - 1, label: "", path: null, shaded: false, is_group: false });
        }
        filled.push(band);
        nextIdx = band.end + 1;
      }
      if (nextIdx < entries.length) {
        filled.push({ level, start: nextIdx, end: entries.length - 1, label: "", path: null, shaded: false, is_group: false });
      }
      bands.push(...filled);
    }

    return bands;
  }

  private makeBand(level: number, start: number, end: number, label: string, path: number[] | null, isStacked: boolean, dim?: number): Band {
    const isEmpty = !label && path === null;
    const isGroup = !isEmpty && Array.isArray(path) && path.length >= 1;
    const shaded = isGroup;
    return { level, start, end, label, path, dim, shaded, is_group: isGroup };
  }

  private pathKey(p: number[] | null): string {
    return p ? p.join(",") : "";
  }

  // ---- Rendering ----
  private renderGrid(mount: HTMLElement) {
    const v = this.store.state.activeView!;
    this.rebuildOffsets();
    const rowHeaderW = this.rowHeaderWTotal();
    const colHeaderH = METRICS.colHeaderH * this.colHeaderLevels;
    const dataW = this.dataWTotal();
    const dataH = this.rows.length * METRICS.rowH;
    const contentW = rowHeaderW + dataW;
    const contentH = colHeaderH + dataH;

    // Scroll container
    const scroll = el("div", { class: "ml-grid-scroll", style: { position: "relative", width: "100%", height: "100%", overflow: "auto" } }) as HTMLElement;

    // Inner canvas (full content size — establishes scrollable area).
    // Elements draw only right+bottom borders; canvas supplies top+left so
    // adjacent elements share a single 1px line instead of doubling up.
    const canvas = el("div", { class: "ml-grid-canvas", style: { position: "relative", width: contentW + "px", height: contentH + "px", borderTop: `1px solid ${COLORS.gridline}`, borderLeft: `1px solid ${COLORS.gridline}` } }) as HTMLElement;

    // All layers are position:absolute relative to canvas.
    // Headers get CSS transforms on scroll to counteract scroll offset,
    // keeping them pinned to the viewport edge while data scrolls freely.

    // 1. Data cells (scrolls freely in both directions)
    const dataLayer = el("div", { class: "ml-data", style: {
      position: "absolute", left: rowHeaderW + "px", top: colHeaderH + "px",
      width: dataW + "px", height: dataH + "px", zIndex: "1",
    } }) as HTMLElement;
    this.renderDataCells(dataLayer);
    canvas.appendChild(dataLayer);

    // 2. Column headers (pinned to top, scrolls horizontally with data)
    const colHeaderLayer = el("div", { class: "ml-col-headers", style: {
      position: "absolute", left: rowHeaderW + "px", top: "0px",
      width: dataW + "px", height: colHeaderH + "px", zIndex: "5",
      background: COLORS.headerBg, overflow: "hidden",
    } }) as HTMLElement;
    this.renderColHeaders(colHeaderLayer, colHeaderH);
    canvas.appendChild(colHeaderLayer);

    // 3. Row headers (pinned to left, scrolls vertically with data)
    const rowHeaderLayer = el("div", { class: "ml-row-headers", style: {
      position: "absolute", left: "0px", top: colHeaderH + "px",
      width: rowHeaderW + "px", height: dataH + "px", zIndex: "4",
      background: COLORS.headerBg, overflow: "hidden",
    } }) as HTMLElement;
    this.renderRowHeaders(rowHeaderLayer, rowHeaderW, colHeaderH);
    canvas.appendChild(rowHeaderLayer);

    // 4. Corner (pinned to top-left, doesn't scroll)
    const corner = el("div", { class: "ml-corner", style: {
      position: "absolute", left: "0px", top: "0px", zIndex: "10",
      width: rowHeaderW + "px", height: colHeaderH + "px",
      background: COLORS.headerBg, borderRight: `1px solid ${COLORS.gridline}`, borderBottom: `1px solid ${COLORS.gridline}`,
      display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", fontSize: "11px", color: COLORS.headerFg,
      overflow: "hidden",
    } }, [this.rowDimNames()]) as HTMLElement;
    corner.addEventListener("click", () => this.selectAll());
    corner.addEventListener("mousedown", (e) => { e.preventDefault(); this.selectAll(); });
    canvas.appendChild(corner);

    // Scroll handler: counteract scroll offset for pinned layers
    const onScroll = () => {
      const sx = scroll.scrollLeft;
      const sy = scroll.scrollTop;
      // Col headers: counteract vertical scroll only (horizontal scrolls with data)
      colHeaderLayer.style.transform = `translateY(${sy}px)`;
      // Row headers: counteract horizontal scroll only (vertical scrolls with data)
      rowHeaderLayer.style.transform = `translateX(${sx}px)`;
      // Corner: counteract both
      corner.style.transform = `translate(${sx}px, ${sy}px)`;
    };
    scroll.addEventListener("scroll", onScroll);
    // Call once to set initial positions
    onScroll();

    scroll.appendChild(canvas);
    mount.appendChild(scroll);

    // Catch-all drop listener — logs drops that don't reach bands/leaf headers
    scroll.addEventListener("dragover", (e) => {
      if (this.dragPayload) { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = "move"; }
    });
    scroll.addEventListener("drop", (e) => {
      if (this.dragPayload) {
        console.log("[scrollDrop] drop on empty space, payload:", this.dragPayload, "target:", (e.target as HTMLElement)?.className);
        this.dragPayload = null;
        this.clearDropIndicator();
        this.clearDropHighlight();
      }
    });

    // Focus for keyboard — but never steal focus from an open editor
    scroll.tabIndex = 0;
    scroll.addEventListener("keydown", (e) => this.onKeyDown(e));
    if (!this.editor && !this.headerEdit) scroll.focus();

    // Cell drag-select (rubberband): mousemove extends range from anchor, mouseup ends
    scroll.addEventListener("mousemove", (e) => {
      if (!this.cellDragActive) return;
      const hit = this.cellAtPoint(e.clientX, e.clientY);
      if (hit) this.dragSelectCell(hit.r, hit.c, this.cellDragCtrl);
    });
    scroll.addEventListener("mouseup", () => { this.cellDragActive = false; });
    scroll.addEventListener("mouseleave", () => { this.cellDragActive = false; });

    this.attachResizeHandlers(scroll);
  }

  // ---- Column / row-header-level resize (native _get_resize_col / _get_resize_row_level) ----
  private resizeHit(scroll: HTMLElement, e: MouseEvent): { kind: "col" | "rowLevel"; index: number } | null {
    const r = scroll.getBoundingClientRect();
    const viewX = e.clientX - r.left;
    const viewY = e.clientY - r.top;
    const colHeaderH = METRICS.colHeaderH * this.colHeaderLevels;
    const rowHeaderW = this.rowHeaderWTotal();
    // Column edge: inside the col header strip (pinned vertically), right of row headers
    if (viewY < colHeaderH && viewX >= rowHeaderW) {
      const x = viewX + scroll.scrollLeft - rowHeaderW;
      for (let c = 0; c < this.cols.length; c++) {
        if (Math.abs(x - (this.colOffsets[c + 1] ?? 0)) <= 6) return { kind: "col", index: c };
      }
    }
    // Row-header level edge: inside the row header strip (pinned horizontally), below col headers
    if (viewY >= colHeaderH && viewX < rowHeaderW) {
      for (let l = 0; l < this.rowHeaderLevels; l++) {
        if (Math.abs(viewX - (this.rowLevelOffsets[l + 1] ?? 0)) <= 6) return { kind: "rowLevel", index: l };
      }
    }
    return null;
  }

  private attachResizeHandlers(scroll: HTMLElement) {
    // Hover cursor feedback (native SplitHCursor over resize edges)
    scroll.addEventListener("mousemove", (e) => {
      if (this.resizeState) return;
      scroll.classList.toggle("resize-hover", !!this.resizeHit(scroll, e));
    });
    scroll.addEventListener("mouseleave", () => scroll.classList.remove("resize-hover"));

    // Capture-phase mousedown so the edge grab beats cell select/drag handlers
    scroll.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      // Native mousePressEvent → _hide_editor(): a click on the grid discards an open
      // cell edit. Cell/header handlers preventDefault, so the editor never blurs on its own.
      // e.target === scroll is the scrollbar — leave the editor open.
      if (this.editor && e.target !== scroll) this.cancelEdit();
      const hit = this.resizeHit(scroll, e);
      if (!hit) return;
      e.preventDefault();
      e.stopPropagation();
      const startW = hit.kind === "col" ? this.colW(hit.index) : this.rowLevelW(hit.index);
      this.resizeState = { kind: hit.kind, index: hit.index, startX: e.clientX, startW, moved: false };
      scroll.classList.add("resizing");
      document.body.classList.add("ml-resizing");
      const move = (ev: MouseEvent) => this.onResizeMove(ev, scroll);
      const up = () => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        const st = this.resizeState;
        this.resizeState = null;
        scroll.classList.remove("resizing", "resize-hover");
        document.body.classList.remove("ml-resizing");
        if (st?.moved) this.suppressClickOnce = true;
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    }, true);

    // Swallow the click emitted after a resize drag so it doesn't select the header
    scroll.addEventListener("click", (e) => {
      if (this.suppressClickOnce) { this.suppressClickOnce = false; e.stopPropagation(); e.preventDefault(); }
    }, true);
  }

  private onResizeMove(e: MouseEvent, scroll: HTMLElement) {
    const st = this.resizeState;
    if (!st) return;
    const delta = e.clientX - st.startX;
    if (!st.moved && Math.abs(delta) < 2) return;
    st.moved = true;
    if (st.kind === "col") {
      const w = Math.max(20, st.startW + delta);
      // Native: resizing a selected column in a multi-column selection resizes all
      if (this.selMode === "col" && this.selIndices.has(st.index) && this.selIndices.size > 1) {
        for (const i of this.selIndices as Set<number>) this.colWidths[i] = w;
      } else {
        this.colWidths[st.index] = w;
      }
    } else {
      this.rowLevelWidths[st.index] = Math.max(40, st.startW + delta);
    }
    // Live re-render, preserving scroll position and any open header editor
    const sl = scroll.scrollLeft, stp = scroll.scrollTop;
    this.rerenderGrid();
    const ns = this.gridMount?.querySelector(".ml-grid-scroll") as HTMLElement;
    if (ns) { ns.scrollLeft = sl; ns.scrollTop = stp; }
    this.repositionHeaderEditor();
  }

  /** Re-anchor a visible header editor after geometry changes (native updates editor width during resize). */
  private repositionHeaderEditor() {
    const he = this.headerEdit;
    if (!he) return;
    let rect: { x: number; y: number; w: number; h: number } | null = null;
    if (he.type === "leaf" && he.index !== undefined) {
      rect = this.headerCellRect(he.axis, "leaf", he.index, 0, 0, 0);
    } else if (he.type === "group" && he.groupPath) {
      const bands = he.axis === "row" ? this.rowBands : this.colBands;
      const band = bands.find((b) => b.is_group && JSON.stringify(b.path) === JSON.stringify(he.groupPath) && (b.dim ?? 0) === (he.dimIdx ?? 0));
      if (band) rect = this.headerCellRect(he.axis, "band", 0, band.level, band.start, band.end);
    }
    if (!rect) return;
    he.input.style.left = rect.x + "px";
    he.input.style.top = rect.y + "px";
    he.input.style.width = rect.w + "px";
    he.input.style.height = rect.h + "px";
  }

  private rowDimNames(): string {
    const v = this.store.state.activeView!;
    return v.rowDimIds.map((id) => this.store.dimName(id)).join(" / ");
  }

  private colDimNames(): string {
    const v = this.store.state.activeView!;
    return v.colDimIds.map((id) => this.store.dimName(id)).join(" / ");
  }

  // ---- Column headers (bands + leaf) ----
  private renderColHeaders(layer: HTMLElement, colHeaderH: number) {
    const v = this.store.state.activeView!;

    // Render bands (including empty placeholders so grid lines stay continuous)
    for (const band of this.colBands) {
      const x = this.colOffsets[band.start] ?? 0;
      const w = (this.colOffsets[band.end + 1] ?? x) - x;
      const y = band.level * METRICS.colHeaderH;
      const cell = el("div", { class: "ml-band" + (band.shaded ? " shaded" : ""), style: {
        position: "absolute", left: x + "px", top: y + "px", width: w + "px", height: METRICS.colHeaderH + "px",
        backgroundColor: COLORS.headerBg, borderRight: `1px solid ${COLORS.gridline}`, borderBottom: `1px solid ${COLORS.gridline}`,
        display: "flex", alignItems: "center", padding: "0 4px", fontSize: "11px", color: COLORS.headerFg,
        overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis",
      } }, [band.label]) as HTMLElement;

      // Collapse toggle for group bands
      if (band.is_group) {
        const pathKey = `${band.dim ?? 0}:${band.path!.join(",")}`;
        const isCollapsed = this.colCollapsed.has(pathKey);
        const toggle = el("span", { class: "ml-collapse-toggle", style: {
          cursor: "pointer", marginRight: "4px", fontWeight: "bold", fontSize: "10px", flexShrink: "0",
        } }, [isCollapsed ? "▸" : "▼"]) as HTMLElement;
        toggle.addEventListener("click", (e) => {
          e.stopPropagation();
          this.toggleCollapse("col", pathKey);
        });
        cell.insertBefore(toggle, cell.firstChild);

        // Group selection
        cell.addEventListener("click", (e) => {
          e.preventDefault();
          if (this.headerDblClick("col", `group:${pathKey}`)) { this.startGroupHeaderEdit("col", band.path!, band.dim); return; }
          this.selectGroup("col", band.start, band.end, band.path!, e.ctrlKey || e.metaKey);
        });
        cell.addEventListener("dblclick", (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.startGroupHeaderEdit("col", band.path!, band.dim);
        });

        // Group band drag (native: drag group header moves the whole group)
        cell.draggable = true;
        cell.addEventListener("dragstart", (e) => {
          const node = this.getNodeAtPath(this.dimOutlineFor("col", band.dim ?? 0), band.path!);
          console.log("[dragstart] col group band:", band.label, "path:", band.path, "dim:", band.dim, "node:", node?.label, "node_id:", node?.node_id);
          this.dragPayload = {
            axis: "col",
            itemId: null,
            groupPath: band.path!,
            groupDim: band.dim ?? 0,
            groupNodeId: node?.node_id ?? null,
            selectedItems: null,
          };
          if (e.dataTransfer) { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", band.label); }
        });
        cell.addEventListener("dragend", () => { this.dragPayload = null; this.clearDropIndicator(); this.clearDropHighlight(); });
      }

      cell.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.showContextMenu(e, "col");
      });

      // Band drop zone (native: left/right quarter = reorder, center = into group)
      cell.addEventListener("dragover", (e) => {
        if (!this.dragPayload || this.dragPayload.axis !== "col") return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        this.showColBandDropZone(band, e);
      });
      cell.addEventListener("drop", (e) => {
        if (!this.dragPayload || this.dragPayload.axis !== "col") return;
        e.preventDefault();
        const zone = this.colBandDropZone(band, e);
        this.clearDropIndicator();
        this.clearDropHighlight();
        this.executeDrop("col", zone);
        this.dragPayload = null;
      });

      layer.appendChild(cell);
    }

    // Render leaf headers (bottom row)
    const yLeaf = this.colBandLevels * METRICS.colHeaderH;
    for (let c = 0; c < this.cols.length; c++) {
      const col = this.cols[c];
      const label = col.labels[col.labels.length - 1] || "";
      const x = this.colOffsets[c] ?? 0;
      const isSelected = this.isColSelected(c);
      const isCollapsedGroup = !col.is_leaf && col.item_id === null && col.node_id !== null && col.node_id !== undefined;
      const cell = el("div", { class: "ml-leaf-header" + (isSelected ? " selected" : ""), style: {
        position: "absolute", left: x + "px", top: yLeaf + "px", width: this.colW(c) + "px", height: METRICS.colHeaderH + "px",
        background: isSelected ? COLORS.selBg : COLORS.headerBg,
        borderRight: `1px solid ${COLORS.gridline}`, borderBottom: `1px solid ${COLORS.gridline}`,
        display: "flex", alignItems: "center", padding: "0 4px", fontSize: "11px",
        color: isSelected ? COLORS.selFg : COLORS.headerFg,
        overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis", cursor: "pointer",
      } }, [label]) as HTMLElement;

      // Collapse/expand arrow for collapsed groups
      if (isCollapsedGroup) {
        const pathKey = col.path.join(",");
        const toggle = el("span", { class: "ml-collapse-toggle", style: {
          cursor: "pointer", marginRight: "4px", fontWeight: "bold", fontSize: "10px", flexShrink: "0",
        } }, ["▸"]) as HTMLElement;
        toggle.addEventListener("click", (e) => {
          e.stopPropagation();
          this.toggleCollapse("col", pathKey);
        });
        cell.insertBefore(toggle, cell.firstChild);
      }

      if (col.is_aggregate) {
        const sigma = el("span", { style: { position: "absolute", top: "1px", right: "2px", fontSize: "9px", color: "#666" } }, ["Σ"]);
        cell.style.position = "absolute";
        cell.appendChild(sigma);
      }

      cell.addEventListener("click", (e) => {
        e.preventDefault();
        if (!e.shiftKey && !e.ctrlKey && !e.metaKey && this.headerDblClick("col", `leaf:${c}`)) {
          if (isCollapsedGroup && col.path.length) this.startGroupHeaderEdit("col", col.path);
          else this.startHeaderLeafEdit("col", c);
          return;
        }
        this.selectCol(c, e.shiftKey, e.ctrlKey || e.metaKey);
      });
      cell.addEventListener("dblclick", (e) => { e.preventDefault(); this.startHeaderLeafEdit("col", c); });
      cell.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        if (!(this.selMode === "col" && (this.selIndices as Set<number>).has(c))) this.selectCol(c, false, false);
        this.showContextMenu(e, "col");
      });

      // Drag-and-drop for col reordering (native: leaf drag carries item_id + selected_items)
      if (col.is_leaf && col.item_id) {
        cell.draggable = true;
        cell.addEventListener("dragstart", (e) => {
          // Only use multi-selection if the dragged item is part of it
          const selItems = (this.selMode === "col" && this.selIndices.size > 1 && this.selIndices.has(c))
            ? [...this.selIndices].map((i: number) => this.cols[i]?.item_id).filter(Boolean) as string[]
            : null;
          this.dragPayload = { axis: "col", itemId: col.item_id, groupPath: null, groupDim: col.dim, groupNodeId: null, selectedItems: selItems };
          e.dataTransfer?.setData("text/plain", col.item_id!);
          if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
        });
        cell.addEventListener("dragend", () => {
          this.dragPayload = null;
          this.clearDropIndicator();
          this.clearDropHighlight();
        });
        cell.addEventListener("dragover", (e) => {
          if (!this.dragPayload || this.dragPayload.axis !== "col") return;
          e.preventDefault();
          if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
          this.showColDropIndicator(c, e);
        });
        cell.addEventListener("drop", (e) => {
          e.preventDefault();
          if (!this.dragPayload || this.dragPayload.axis !== "col") return;
          const after = this.dropIsAfterCol(c, e);
          this.clearDropIndicator();
          this.clearDropHighlight();
          this.executeDrop("col", { mode: "reorder", index: c, after, dim: col.dim });
          this.dragPayload = null;
        });
      } else if (isCollapsedGroup && col.path.length) {
        // Collapsed group leaf: acts as "into" drop target (native behavior)
        cell.addEventListener("dragover", (e) => {
          if (!this.dragPayload || this.dragPayload.axis !== "col") return;
          e.preventDefault();
          if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
          cell.style.outline = "2px solid rgba(42,118,210,0.5)";
          cell.style.background = "rgba(42,118,210,0.15)";
        });
        cell.addEventListener("dragleave", () => {
          cell.style.outline = "";
          cell.style.background = isSelected ? COLORS.selBg : COLORS.headerBg;
        });
        cell.addEventListener("drop", (e) => {
          e.preventDefault();
          if (!this.dragPayload || this.dragPayload.axis !== "col") return;
          cell.style.outline = "";
          cell.style.background = isSelected ? COLORS.selBg : COLORS.headerBg;
          this.executeDrop("col", { mode: "into", groupPath: col.path, dim: col.dim });
          this.dragPayload = null;
        });
      }

      layer.appendChild(cell);
    }
  }

  // ---- Row headers (bands + leaf) ----
  private renderRowHeaders(layer: HTMLElement, rowHeaderW: number, colHeaderH: number) {
    const v = this.store.state.activeView!;

    // Render bands
    // Render bands (including empty placeholders so grid lines stay continuous)
    for (const band of this.rowBands) {
      const y = band.start * METRICS.rowH;
      const h = (band.end - band.start + 1) * METRICS.rowH;
      const x = this.rowLevelOffsets[band.level] ?? 0;
      const cell = el("div", { class: "ml-band" + (band.shaded ? " shaded" : ""), style: {
        position: "absolute", left: x + "px", top: y + "px", width: this.rowLevelW(band.level) + "px", height: h + "px",
        backgroundColor: COLORS.headerBg, borderRight: `1px solid ${COLORS.gridline}`, borderBottom: `1px solid ${COLORS.gridline}`,
        display: "flex", alignItems: "center", padding: "0 4px", fontSize: "11px", color: COLORS.headerFg,
        overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis",
      } }, [band.label]) as HTMLElement;

      if (band.is_group) {
        const pathKey = `${band.dim ?? 0}:${band.path!.join(",")}`;
        const isCollapsed = this.rowCollapsed.has(pathKey);
        const toggle = el("span", { class: "ml-collapse-toggle", style: {
          cursor: "pointer", marginRight: "4px", fontWeight: "bold", fontSize: "10px", flexShrink: "0",
        } }, [isCollapsed ? "▸" : "▼"]) as HTMLElement;
        toggle.addEventListener("click", (e) => {
          e.stopPropagation();
          this.toggleCollapse("row", pathKey);
        });
        cell.insertBefore(toggle, cell.firstChild);

        cell.addEventListener("click", (e) => {
          e.preventDefault();
          if (this.headerDblClick("row", `group:${pathKey}`)) { this.startGroupHeaderEdit("row", band.path!, band.dim); return; }
          this.selectGroup("row", band.start, band.end, band.path!, e.ctrlKey || e.metaKey);
        });
        cell.addEventListener("dblclick", (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.startGroupHeaderEdit("row", band.path!, band.dim);
        });

        // Group band drag (native: drag group header moves the whole group)
        cell.draggable = true;
        cell.addEventListener("dragstart", (e) => {
          console.log("[dragstart] row group:", band.label, "path:", band.path, "dim:", band.dim, "is_group:", band.is_group);
          const node = this.getNodeAtPath(this.dimOutlineFor("row", band.dim ?? 0), band.path!);
          this.dragPayload = {
            axis: "row",
            itemId: null,
            groupPath: band.path!,
            groupDim: band.dim ?? 0,
            groupNodeId: node?.node_id ?? null,
            selectedItems: null,
          };
          if (e.dataTransfer) { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", band.label); }
        });
        cell.addEventListener("dragend", () => { this.dragPayload = null; this.clearDropIndicator(); this.clearDropHighlight(); });
      }

      cell.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.showContextMenu(e, "row");
      });

      // Band drop zone (native: top/bottom quarter = reorder, center = into group)
      cell.addEventListener("dragover", (e) => {
        if (!this.dragPayload || this.dragPayload.axis !== "row") return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        this.showRowBandDropZone(band, e);
      });
      cell.addEventListener("drop", (e) => {
        console.log("[bandDrop] row band:", band.label, "path:", band.path, "is_group:", band.is_group, "payload:", this.dragPayload);
        if (!this.dragPayload || this.dragPayload.axis !== "row") return;
        e.preventDefault();
        const zone = this.rowBandDropZone(band, e);
        console.log("[bandDrop] zone:", zone);
        this.clearDropIndicator();
        this.clearDropHighlight();
        this.executeDrop("row", zone);
        this.dragPayload = null;
      });

      layer.appendChild(cell);
    }

    // Render leaf headers (rightmost column)
    const xLeaf = this.rowLevelOffsets[this.rowBandLevels] ?? this.rowBandLevels * METRICS.rowHeaderW;
    for (let r = 0; r < this.rows.length; r++) {
      const row = this.rows[r];
      const label = row.labels[row.labels.length - 1] || "";
      const y = r * METRICS.rowH;
      const isSelected = this.isRowSelected(r);
      const isCollapsedGroup = !row.is_leaf && row.item_id === null && row.node_id !== null && row.node_id !== undefined;
      const cell = el("div", { class: "ml-leaf-header" + (isSelected ? " selected" : ""), style: {
        position: "absolute", left: xLeaf + "px", top: y + "px", width: this.rowLevelW(this.rowBandLevels) + "px", height: METRICS.rowH + "px",
        background: isSelected ? COLORS.selBg : COLORS.headerBg,
        borderRight: `1px solid ${COLORS.gridline}`, borderBottom: `1px solid ${COLORS.gridline}`,
        display: "flex", alignItems: "center", padding: "0 4px", fontSize: "11px",
        color: isSelected ? COLORS.selFg : COLORS.headerFg,
        overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis", cursor: "pointer",
      } }, [label]) as HTMLElement;

      // Collapse/expand arrow for collapsed groups
      if (isCollapsedGroup) {
        const pathKey = row.path.join(",");
        const toggle = el("span", { class: "ml-collapse-toggle", style: {
          cursor: "pointer", marginRight: "4px", fontWeight: "bold", fontSize: "10px", flexShrink: "0",
        } }, ["▸"]) as HTMLElement;
        toggle.addEventListener("click", (e) => {
          e.stopPropagation();
          this.toggleCollapse("row", pathKey);
        });
        cell.insertBefore(toggle, cell.firstChild);
      }

      if (row.is_aggregate) {
        const sigma = el("span", { style: { position: "absolute", top: "1px", right: "2px", fontSize: "9px", color: "#666" } }, ["Σ"]);
        cell.style.position = "absolute";
        cell.appendChild(sigma);
      }

      cell.addEventListener("click", (e) => {
        e.preventDefault();
        if (!e.shiftKey && !e.ctrlKey && !e.metaKey && this.headerDblClick("row", `leaf:${r}`)) {
          if (isCollapsedGroup && row.path.length) this.startGroupHeaderEdit("row", row.path);
          else this.startHeaderLeafEdit("row", r);
          return;
        }
        this.selectRow(r, e.shiftKey, e.ctrlKey || e.metaKey);
      });
      cell.addEventListener("dblclick", (e) => { e.preventDefault(); this.startHeaderLeafEdit("row", r); });
      cell.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        if (!(this.selMode === "row" && (this.selIndices as Set<number>).has(r))) this.selectRow(r, false, false);
        this.showContextMenu(e, "row");
      });

      // Drag-and-drop for row reordering (native: leaf drag carries item_id + selected_items)
      if (row.is_leaf && row.item_id) {
        cell.draggable = true;
        cell.addEventListener("dragstart", (e) => {
          // Only use multi-selection if the dragged item is part of it
          const selItems = (this.selMode === "row" && this.selIndices.size > 1 && this.selIndices.has(r))
            ? [...this.selIndices].map((i: number) => this.rows[i]?.item_id).filter(Boolean) as string[]
            : null;
          this.dragPayload = { axis: "row", itemId: row.item_id, groupPath: null, groupDim: row.dim, groupNodeId: null, selectedItems: selItems };
          e.dataTransfer?.setData("text/plain", row.item_id!);
          if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
        });
        cell.addEventListener("dragend", () => {
          this.dragPayload = null;
          this.clearDropIndicator();
          this.clearDropHighlight();
        });
        cell.addEventListener("dragover", (e) => {
          if (!this.dragPayload || this.dragPayload.axis !== "row") return;
          e.preventDefault();
          if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
          this.showRowDropIndicator(r, e);
        });
        cell.addEventListener("drop", (e) => {
          e.preventDefault();
          console.log("[leafDrop] row leaf:", r, row.labels, "payload:", this.dragPayload);
          if (!this.dragPayload || this.dragPayload.axis !== "row") return;
          const after = this.dropIsAfter(r, e);
          this.clearDropIndicator();
          this.clearDropHighlight();
          this.executeDrop("row", { mode: "reorder", index: r, after, dim: row.dim });
          this.dragPayload = null;
        });
      } else if (isCollapsedGroup && row.path.length) {
        // Collapsed group leaf: acts as "into" drop target (native behavior)
        cell.addEventListener("dragover", (e) => {
          if (!this.dragPayload || this.dragPayload.axis !== "row") return;
          e.preventDefault();
          if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
          cell.style.outline = "2px solid rgba(42,118,210,0.5)";
          cell.style.background = "rgba(42,118,210,0.15)";
        });
        cell.addEventListener("dragleave", () => {
          cell.style.outline = "";
          cell.style.background = isSelected ? COLORS.selBg : COLORS.headerBg;
        });
        cell.addEventListener("drop", (e) => {
          e.preventDefault();
          if (!this.dragPayload || this.dragPayload.axis !== "row") return;
          cell.style.outline = "";
          cell.style.background = isSelected ? COLORS.selBg : COLORS.headerBg;
          this.executeDrop("row", { mode: "into", groupPath: row.path, dim: row.dim });
          this.dragPayload = null;
        });
      }

      layer.appendChild(cell);
    }
  }

  // ---- Data cells ----
  private renderDataCells(layer: HTMLElement) {
    const v = this.store.state.activeView!;
    if (!this.cells || !this.cells.length) {
      console.warn("[renderDataCells] no cells data", { cells: this.cells, cellRowMap: this.cellRowMap, cellColMap: this.cellColMap });
    }
    for (let r = 0; r < this.rows.length; r++) {
      const cellR = this.cellRowMap[r];
      const isPlaceholder = cellR < 0;
      for (let c = 0; c < this.cols.length; c++) {
        const cellC = this.cellColMap[c];
        const isColPlaceholder = cellC < 0;
        const x = this.colOffsets[c] ?? 0;
        const y = r * METRICS.rowH;

        // Empty cell for placeholder rows/cols (maintains grid alignment)
        if (isPlaceholder || isColPlaceholder) {
          const cellEl = el("div", { class: "ml-cell empty", style: {
            position: "absolute", left: x + "px", top: y + "px",
            width: this.colW(c) + "px", height: METRICS.rowH + "px",
            borderRight: `1px solid ${COLORS.gridline}`, borderBottom: `1px solid ${COLORS.gridline}`,
            background: COLORS.headerBg,
          } }, []) as HTMLElement;
          layer.appendChild(cellEl);
          continue;
        }

        const cell = this.cells[cellR * this.colKeys.length + cellC];
        if (!cell) {
          console.warn("[renderDataCells] no cell at", r, c, "cellR:", cellR, "cellC:", cellC, "total cells:", this.cells?.length);
          continue;
        }
        const isSel = this.isCellSelected(r, c);
        const kind = cell.kind || "empty";
        const disp = cell.display_value ?? "";

        const cls = ["ml-cell", kind];
        if (isSel) cls.push("selected");
        if (kind === "error") cls.push("error");
        if (cell.explain?.source === "override") cls.push("hardnumber");

        const cellEl = el("div", { class: cls.join(" "), style: {
          position: "absolute", left: x + "px", top: y + "px",
          width: this.colW(c) + "px", height: METRICS.rowH + "px",
          borderRight: `1px solid ${COLORS.gridline}`, borderBottom: `1px solid ${COLORS.gridline}`,
          display: "flex", alignItems: "center", padding: "0 4px", fontSize: "11px",
          background: isSel ? COLORS.selBg : (cell.explain?.source === "override" ? COLORS.hardnumberBg : "#fff"),
          color: isSel ? COLORS.selFg : (kind === "error" ? "#c00" : "#000"),
          overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis", cursor: "pointer",
          justifyContent: kind === "text" || kind === "error" ? "flex-start" : "flex-end",
        } }, [disp]) as HTMLElement;

        // Hardnumber triangle
        if (cell.explain?.source === "override") {
          const tri = el("div", { style: {
            position: "absolute", top: "0", right: "0", width: "0", height: "0",
            borderTop: `6px solid ${COLORS.hardnumberTri}`,
            borderLeft: "6px solid transparent",
          } }, []);
          cellEl.appendChild(tri);
        }

        cellEl.title = this.cellTitle(cell);
        cellEl.addEventListener("mousedown", (e) => {
          e.preventDefault();
          if (!e.shiftKey) {
            // Start drag-select (native mousePressEvent → mouseMoveEvent rubberband)
            this.cellDragActive = true;
            this.cellDragCtrl = e.ctrlKey || e.metaKey;
          }
          this.selectCell(r, c, e.shiftKey, e.ctrlKey || e.metaKey);
          // Double-click → edit (native mouseDoubleClickEvent). Detected via the click
          // count on mousedown: selectCell re-renders the grid, so this element is gone
          // before mouseup and the browser never fires click/dblclick on it.
          if (e.detail === 2 && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
            this.cellDragActive = false;
            this.startEdit(r, c);
          }
        });
        cellEl.addEventListener("contextmenu", (e) => { e.preventDefault(); this.showContextMenu(e, "cell"); });
        layer.appendChild(cellEl);
      }
    }

    // Current cell indicator (2px border)
    if (this.selRow >= 0 && this.selCol >= 0 && this.selMode === "cell") {
      const x = this.colOffsets[this.selCol] ?? 0;
      const y = this.selRow * METRICS.rowH;
      const indicator = el("div", { style: {
        position: "absolute", left: (x - 1) + "px", top: (y - 1) + "px",
        width: (this.colW(this.selCol) + 1) + "px", height: (METRICS.rowH + 1) + "px",
        border: `2px solid ${COLORS.currentCell}`, pointerEvents: "none", zIndex: "1",
      } }, []);
      layer.appendChild(indicator);
    }
  }

  private updateViewport(canvas: HTMLElement) {
    // Could implement virtual scrolling here for large grids
  }

  private cellTitle(cell: CellDTO | undefined): string {
    if (!cell) return "";
    const parts = [`addr: ${cell.addr.join("|")}`, `kind: ${cell.kind}`, `source: ${cell.explain?.source || "empty"}`];
    if (cell.explain?.rule_body) parts.push(`rule: ${cell.explain.rule_body}`);
    if (cell.explain?.error) parts.push(`error: ${cell.explain.error}`);
    return parts.join("\n");
  }

  // ---- Selection ----
  private cellKey(r: number, c: number): string { return `${r},${c}`; }
  private isCellSelected(r: number, c: number): boolean {
    if (this.selMode === "all") return true;
    if (this.selMode === "row") return (this.selIndices as Set<number>).has(r);
    if (this.selMode === "col") return (this.selIndices as Set<number>).has(c);
    if ((this.selIndices as Set<string>).size > 0) return (this.selIndices as Set<string>).has(this.cellKey(r, c));
    return r === this.selRow && c === this.selCol;
  }
  private isRowSelected(r: number): boolean {
    if (this.selMode === "all") return true;
    if (this.selMode === "row") return (this.selIndices as Set<number>).has(r);
    return r === this.selRow;
  }
  private isColSelected(c: number): boolean {
    if (this.selMode === "all") return true;
    if (this.selMode === "col") return (this.selIndices as Set<number>).has(c);
    return c === this.selCol;
  }

  private selectCell(r: number, c: number, shift: boolean, ctrl: boolean) {
    if (shift) {
      const r0 = Math.min(this.anchorRow, r), r1 = Math.max(this.anchorRow, r);
      const c0 = Math.min(this.anchorCol, c), c1 = Math.max(this.anchorCol, c);
      const idx = new Set<string>();
      for (let ri = r0; ri <= r1; ri++) for (let ci = c0; ci <= c1; ci++) idx.add(this.cellKey(ri, ci));
      this.setSelectionFull(r, c, "cell", idx);
    } else if (ctrl) {
      // Native: ctrl+click adds the clicked cell; also ensure prior active cell is in selection
      const idx = this.selMode === "cell" ? new Set(this.selIndices as Set<string>) : new Set<string>();
      idx.add(this.cellKey(r, c));
      if (0 <= this.selRow && 0 <= this.selCol) idx.add(this.cellKey(this.selRow, this.selCol));
      this.setSelectionFull(r, c, "cell", idx);
    } else {
      this.setSelectionFull(r, c, "cell", new Set<string>(), r, c);
    }
  }

  // Drag-select: extend rectangular range from anchor to current cell (native mouseMoveEvent)
  private dragSelectCell(r: number, c: number, ctrl: boolean) {
    const r0 = Math.min(this.anchorRow, r), r1 = Math.max(this.anchorRow, r);
    const c0 = Math.min(this.anchorCol, c), c1 = Math.max(this.anchorCol, c);
    const idx = ctrl && this.selMode === "cell" ? new Set(this.selIndices as Set<string>) : new Set<string>();
    for (let ri = r0; ri <= r1; ri++) for (let ci = c0; ci <= c1; ci++) idx.add(this.cellKey(ri, ci));
    // Preserve the original anchor — do NOT let setSelectionFull reset it to (r, c)
    this.setSelectionFull(r, c, "cell", idx, this.anchorRow, this.anchorCol);
  }

  private selectRow(r: number, shift: boolean, ctrl: boolean) {
    if (shift && this.selMode === "row") {
      // Native: extend from current selection bounds to clicked row
      const cur = [...(this.selIndices as Set<number>)];
      const r0 = cur.length ? Math.min(Math.min(...cur), r) : Math.min(this.anchorRow, r);
      const r1 = cur.length ? Math.max(Math.max(...cur), r) : Math.max(this.anchorRow, r);
      const idx = new Set<number>();
      for (let ri = r0; ri <= r1; ri++) idx.add(ri);
      this.setSelectionFull(r, this.selCol, "row", idx);
    } else if (ctrl) {
      if (this.selMode === "col") {
        // Cross-mode: convert col selection to cell selection at intersection with this row
        const idx = new Set<string>();
        for (const c of this.selIndices as Set<number>) idx.add(this.cellKey(r, c));
        this.setSelectionFull(r, 0, "cell", idx);
      } else if (this.selMode === "cell") {
        // Add all cells in this row to existing cell selection
        const idx = new Set(this.selIndices as Set<string>);
        for (let c = 0; c < this.cols.length; c++) if (this.cols[c].is_leaf) idx.add(this.cellKey(r, c));
        this.setSelectionFull(r, 0, "cell", idx);
      } else {
        // Same mode: toggle this row
        const idx = new Set(this.selIndices as Set<number>);
        if (idx.has(r)) idx.delete(r); else idx.add(r);
        this.setSelectionFull(r, this.selCol, "row", idx);
      }
    } else {
      // Native: if clicking on already-selected row in multi-selection, preserve for drag
      if (this.selMode === "row" && (this.selIndices as Set<number>).has(r) && (this.selIndices as Set<number>).size > 1) {
        this.setSelectionFull(r, this.selCol, "row", this.selIndices, this.anchorRow, this.anchorCol);
      } else {
        this.setSelectionFull(r, this.selCol, "row", new Set<number>([r]), r, this.selCol);
      }
    }
  }

  private selectCol(c: number, shift: boolean, ctrl: boolean) {
    if (shift && this.selMode === "col") {
      const cur = [...(this.selIndices as Set<number>)];
      const c0 = cur.length ? Math.min(Math.min(...cur), c) : Math.min(this.anchorCol, c);
      const c1 = cur.length ? Math.max(Math.max(...cur), c) : Math.max(this.anchorCol, c);
      const idx = new Set<number>();
      for (let ci = c0; ci <= c1; ci++) idx.add(ci);
      this.setSelectionFull(this.selRow, c, "col", idx);
    } else if (ctrl) {
      if (this.selMode === "row") {
        // Cross-mode: convert row selection to cell selection at intersection with this col
        const idx = new Set<string>();
        for (const r of this.selIndices as Set<number>) idx.add(this.cellKey(r, c));
        this.setSelectionFull(0, c, "cell", idx);
      } else if (this.selMode === "cell") {
        // Add all cells in this col to existing cell selection
        const idx = new Set(this.selIndices as Set<string>);
        for (let r = 0; r < this.rows.length; r++) if (this.rows[r].is_leaf) idx.add(this.cellKey(r, c));
        this.setSelectionFull(0, c, "cell", idx);
      } else {
        // Same mode: toggle this col
        const idx = new Set(this.selIndices as Set<number>);
        if (idx.has(c)) idx.delete(c); else idx.add(c);
        this.setSelectionFull(this.selRow, c, "col", idx);
      }
    } else {
      // Native: if clicking on already-selected col in multi-selection, preserve for drag
      if (this.selMode === "col" && (this.selIndices as Set<number>).has(c) && (this.selIndices as Set<number>).size > 1) {
        this.setSelectionFull(this.selRow, c, "col", this.selIndices, this.anchorRow, this.anchorCol);
      } else {
        this.setSelectionFull(this.selRow, c, "col", new Set<number>([c]), this.selRow, c);
      }
    }
  }

  private selectGroup(axis: "row" | "col", start: number, end: number, path: number[], ctrl = false) {
    const groupIndices = new Set<number>();
    for (let i = start; i <= end; i++) if ((axis === "row" ? this.rows : this.cols)[i].is_leaf) groupIndices.add(i);
    if (axis === "row") {
      if (ctrl && this.selMode === "row") {
        const idx = new Set(this.selIndices as Set<number>);
        let allIn = true;
        for (const gi of groupIndices) if (!idx.has(gi)) { allIn = false; break; }
        if (allIn) for (const gi of groupIndices) idx.delete(gi);
        else for (const gi of groupIndices) idx.add(gi);
        this.setSelectionFull(start, this.selCol, "row", idx);
      } else {
        this.setSelectionFull(start, this.selCol, "row", groupIndices, start, this.selCol);
      }
    } else {
      if (ctrl && this.selMode === "col") {
        const idx = new Set(this.selIndices as Set<number>);
        let allIn = true;
        for (const gi of groupIndices) if (!idx.has(gi)) { allIn = false; break; }
        if (allIn) for (const gi of groupIndices) idx.delete(gi);
        else for (const gi of groupIndices) idx.add(gi);
        this.setSelectionFull(this.selRow, start, "col", idx);
      } else {
        this.setSelectionFull(this.selRow, start, "col", groupIndices, this.selRow, start);
      }
    }
  }

  private selectAll() {
    this.setSelectionFull(0, 0, "all", new Set());
  }

  private setSelectionFull(row: number, col: number, mode: SelMode, indices: Set<any>, anchorRow?: number, anchorCol?: number) {
    this.selRow = row; this.selCol = col; this.selMode = mode; this.selIndices = indices;
    this.anchorRow = anchorRow ?? row; this.anchorCol = anchorCol ?? col;
    this.store.setSelectionFull(row, col, mode, indices, this.anchorRow, this.anchorCol);
    // Re-render just the grid
    this.rerenderGrid();
  }

  private rerenderGrid() {
    const mount = this.gridMount;
    if (!mount) return;
    clear(mount);
    const v = this.store.state.activeView;
    if (!v || !v.cells) return;
    this.buildGrid(v);
    this.renderGrid(mount);
  }

  // ---- Collapse/Expand ----
  private toggleCollapse(axis: "row" | "col", pathKey: string) {
    const set = axis === "row" ? this.rowCollapsed : this.colCollapsed;
    if (set.has(pathKey)) set.delete(pathKey); else set.add(pathKey);
    this.rerenderGrid();
  }

  // ---- Drag-and-drop helpers ----
  private dropIsAfter(idx: number, e: DragEvent): boolean {
    const target = e.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    return (e.clientY - rect.top) > rect.height / 2;
  }

  private dropIsAfterCol(idx: number, e: DragEvent): boolean {
    const target = e.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    return (e.clientX - rect.left) > rect.width / 2;
  }

  private showRowDropIndicator(idx: number, e: DragEvent) {
    this.clearDropIndicator();
    const after = this.dropIsAfter(idx, e);
    const y = (after ? (idx + 1) : idx) * METRICS.rowH;
    const layer = this.gridMount?.querySelector(".ml-row-headers") as HTMLElement;
    if (!layer) return;
    const ind = el("div", { class: "ml-drop-indicator", style: {
      position: "absolute", left: "0px", top: (y - 1) + "px",
      width: "100%", height: "2px", background: "#2a76d2",
      zIndex: "20", pointerEvents: "none",
    } }, []) as HTMLElement;
    layer.appendChild(ind);
    this.dropIndicator = ind;
  }

  private showColDropIndicator(idx: number, e: DragEvent) {
    this.clearDropIndicator();
    const after = this.dropIsAfterCol(idx, e);
    const x = this.colOffsets[after ? (idx + 1) : idx] ?? 0;
    const layer = this.gridMount?.querySelector(".ml-col-headers") as HTMLElement;
    if (!layer) return;
    const ind = el("div", { class: "ml-drop-indicator", style: {
      position: "absolute", left: (x - 1) + "px", top: "0px",
      width: "2px", height: "100%", background: "#2a76d2",
      zIndex: "20", pointerEvents: "none",
    } }, []) as HTMLElement;
    layer.appendChild(ind);
    this.dropIndicator = ind;
  }

  private clearDropIndicator() {
    if (this.dropIndicator) { this.dropIndicator.remove(); this.dropIndicator = null; }
  }

  private clearDropHighlight() {
    if (this.dropHighlight) { this.dropHighlight.remove(); this.dropHighlight = null; }
  }

  // ---- Drop zone classification (mirrors native group_drag.py) ----

  private rowBandDropZone(band: Band, e: DragEvent): DropZone {
    const target = e.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    const relY = (e.clientY - rect.top) / rect.height;
    if (band.is_group && band.path) {
      // Group band: top 25% = before, middle 50% = into, bottom 25% = after
      if (relY < 0.25) return { mode: "before", groupPath: band.path, dim: band.dim };
      if (relY > 0.75) return { mode: "after", groupPath: band.path, dim: band.dim };
      return { mode: "into", groupPath: band.path, dim: band.dim };
    }
    // Non-group band (stacked dim placeholder): top half = before first row, bottom half = after last row
    return { mode: "reorder", index: relY < 0.5 ? band.start : band.end, after: relY >= 0.5, dim: band.dim };
  }

  private colBandDropZone(band: Band, e: DragEvent): DropZone {
    const target = e.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    const relX = (e.clientX - rect.left) / rect.width;
    if (band.is_group && band.path) {
      // Group band: left 25% = before, middle 50% = into, right 25% = after
      if (relX < 0.25) return { mode: "before", groupPath: band.path, dim: band.dim };
      if (relX > 0.75) return { mode: "after", groupPath: band.path, dim: band.dim };
      return { mode: "into", groupPath: band.path, dim: band.dim };
    }
    // Non-group band
    return { mode: "reorder", index: relX < 0.5 ? band.start : band.end, after: relX >= 0.5, dim: band.dim };
  }

  private showRowBandDropZone(band: Band, e: DragEvent) {
    const zone = this.rowBandDropZone(band, e);
    this.clearDropIndicator();
    this.clearDropHighlight();
    const layer = this.gridMount?.querySelector(".ml-row-headers") as HTMLElement;
    if (!layer) return;
    if (zone.mode === "into" && band.is_group) {
      // Highlight the band for "into" drop
      const y = band.start * METRICS.rowH;
      const h = (band.end - band.start + 1) * METRICS.rowH;
      const x = this.rowLevelOffsets[band.level] ?? 0;
      const hl = el("div", { class: "ml-drop-highlight", style: {
        position: "absolute", left: x + "px", top: y + "px",
        width: this.rowLevelW(band.level) + "px", height: h + "px",
        background: "rgba(42,118,210,0.15)", outline: "2px solid rgba(42,118,210,0.5)",
        zIndex: "19", pointerEvents: "none",
      } }, []) as HTMLElement;
      layer.appendChild(hl);
      this.dropHighlight = hl;
    } else if (zone.mode === "before" && band.is_group) {
      const y = band.start * METRICS.rowH;
      const ind = el("div", { class: "ml-drop-indicator", style: {
        position: "absolute", left: "0px", top: (y - 1) + "px",
        width: "100%", height: "2px", background: "#2a76d2",
        zIndex: "20", pointerEvents: "none",
      } }, []) as HTMLElement;
      layer.appendChild(ind);
      this.dropIndicator = ind;
    } else if (zone.mode === "after" && band.is_group) {
      const y = (band.end + 1) * METRICS.rowH;
      const ind = el("div", { class: "ml-drop-indicator", style: {
        position: "absolute", left: "0px", top: (y - 1) + "px",
        width: "100%", height: "2px", background: "#2a76d2",
        zIndex: "20", pointerEvents: "none",
      } }, []) as HTMLElement;
      layer.appendChild(ind);
      this.dropIndicator = ind;
    } else {
      // reorder zone
      this.showRowDropIndicator((zone as any).index, e);
    }
  }

  private showColBandDropZone(band: Band, e: DragEvent) {
    const zone = this.colBandDropZone(band, e);
    this.clearDropIndicator();
    this.clearDropHighlight();
    const layer = this.gridMount?.querySelector(".ml-col-headers") as HTMLElement;
    if (!layer) return;
    if (zone.mode === "into" && band.is_group) {
      const x = this.colOffsets[band.start] ?? 0;
      const w = (this.colOffsets[band.end + 1] ?? x) - x;
      const y = band.level * METRICS.colHeaderH;
      const hl = el("div", { class: "ml-drop-highlight", style: {
        position: "absolute", left: x + "px", top: y + "px",
        width: w + "px", height: METRICS.colHeaderH + "px",
        background: "rgba(42,118,210,0.15)", outline: "2px solid rgba(42,118,210,0.5)",
        zIndex: "19", pointerEvents: "none",
      } }, []) as HTMLElement;
      layer.appendChild(hl);
      this.dropHighlight = hl;
    } else if (zone.mode === "before" && band.is_group) {
      const x = this.colOffsets[band.start] ?? 0;
      const ind = el("div", { class: "ml-drop-indicator", style: {
        position: "absolute", left: (x - 1) + "px", top: "0px",
        width: "2px", height: "100%", background: "#2a76d2",
        zIndex: "20", pointerEvents: "none",
      } }, []) as HTMLElement;
      layer.appendChild(ind);
      this.dropIndicator = ind;
    } else if (zone.mode === "after" && band.is_group) {
      const x = this.colOffsets[band.end + 1] ?? 0;
      const ind = el("div", { class: "ml-drop-indicator", style: {
        position: "absolute", left: (x - 1) + "px", top: "0px",
        width: "2px", height: "100%", background: "#2a76d2",
        zIndex: "20", pointerEvents: "none",
      } }, []) as HTMLElement;
      layer.appendChild(ind);
      this.dropIndicator = ind;
    } else {
      this.showColDropIndicator((zone as any).index, e);
    }
  }

  // ---- Outline helpers ----

  private dimOutlineFor(axis: "row" | "col", dimIdx = 0): any[] {
    const v = this.store.state.activeView;
    if (!v) return [];
    const dimIds = axis === "row" ? v.rowDimIds : v.colDimIds;
    if (!dimIds.length) return [];
    const dim = this.store.dimCache.get(dimIds[Math.min(dimIdx, dimIds.length - 1)]);
    return dim?.outline || [];
  }

  // Leaf items live on the LAST dim of a stacked axis; group bands carry band.dim.
  private dimIdFor(axis: "row" | "col", dimIdx?: number): string | null {
    const v = this.store.state.activeView;
    if (!v) return null;
    const dimIds = axis === "row" ? v.rowDimIds : v.colDimIds;
    if (!dimIds.length) return null;
    return dimIds[dimIdx ?? dimIds.length - 1] || null;
  }

  private entriesFor(axis: "row" | "col"): AxisEntry[] {
    return axis === "row" ? this.rows : this.cols;
  }

  // Find the outline node that contains an item_id
  private findItemNodeId(outline: any[], itemId: string): { nodeId: string | null; parentPath: number[]; indexInParent: number } {
    const result = { nodeId: null as string | null, parentPath: [] as number[], indexInParent: -1 };
    const search = (nodes: any[], path: number[]) => {
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if (n.item_id === itemId) {
          result.nodeId = n.node_id || null;
          result.parentPath = [...path];
          result.indexInParent = i;
          return;
        }
        if (n.children) search(n.children, [...path, i]);
      }
    };
    search(outline, []);
    return result;
  }

  // Get all descendant node_ids of a group node
  private getDescendantNodeIds(node: any): Set<string> {
    const ids = new Set<string>();
    const collect = (n: any) => {
      if (n.node_id) ids.add(n.node_id);
      if (n.children) for (const c of n.children) collect(c);
    };
    if (node.children) for (const c of node.children) collect(c);
    return ids;
  }

  // Check if groupPath is inside (or is) another groupPath
  private isDescendantPath(ancestorPath: number[], descendantPath: number[]): boolean {
    if (descendantPath.length < ancestorPath.length) return false;
    for (let i = 0; i < ancestorPath.length; i++) {
      if (ancestorPath[i] !== descendantPath[i]) return false;
    }
    return true;
  }

  // Parent path of a node path (drop last element)
  private parentPath(path: number[]): number[] {
    return path.slice(0, -1);
  }

  // Materialize an ungraphed leaf item into the outline graph at its displayed
  // position. Ungraphed items render as a root-level tail after all graphed
  // leaves, so the node is placed at root anchored on the nearest display
  // neighbour's root-level ancestor (recursively materializing ungraphed
  // siblings so tail order is preserved). Returns the new node_id or null.
  private async materializeUngraphedItem(dimId: string, outline: any[], entries: AxisEntry[], index: number): Promise<string | null> {
    const dst = entries[index];
    if (!dst?.item_id) return null;
    const extract = (res: any): string | null => {
      const ids = Array.isArray(res) ? res : (res?.node_ids ?? res?.data ?? null);
      return Array.isArray(ids) ? (ids[0] ?? null) : null;
    };
    const rootAncestorOf = (e: AxisEntry): any | null => {
      if (!e.item_id) return null;
      const info = this.findItemNodeId(outline, e.item_id);
      if (!info.nodeId) return null;
      const leafPath = [...info.parentPath, info.indexInParent];
      return outline[leafPath[0]] ?? null;
    };
    for (let i = index - 1; i >= 0; i--) {
      const e = entries[i];
      if (!e.item_id) continue;
      const root = rootAncestorOf(e);
      let anchorId = root?.node_id ?? null;
      if (!anchorId) anchorId = await this.materializeUngraphedItem(dimId, outline, entries, i);
      if (anchorId) {
        const res = await this.store.api.placeItemNodes(dimId, [dst.item_id], null, anchorId, "after");
        return extract(res);
      }
    }
    for (let i = index + 1; i < entries.length; i++) {
      const root = rootAncestorOf(entries[i]);
      if (root?.node_id) {
        const res = await this.store.api.placeItemNodes(dimId, [dst.item_id], null, root.node_id, "before");
        return extract(res);
      }
    }
    const res = await this.store.api.placeItemNodes(dimId, [dst.item_id], null, null, "last");
    return extract(res);
  }

  // ---- Drop execution ----

  private async executeDrop(axis: "row" | "col", zone: DropZone) {
    const p = this.dragPayload;
    if (!p) return;
    const v = this.store.state.activeView;
    if (!v) return;
    const dimIds = axis === "row" ? v.rowDimIds : v.colDimIds;
    const leafDim = Math.max(0, dimIds.length - 1);
    const zoneDim = ("dim" in zone && zone.dim !== undefined) ? zone.dim : leafDim;
    const payloadDim = p.groupDim ?? leafDim;
    // Cross-dim drops are invalid: a group only moves within its own dim, and
    // items (always on the last dim) can't join another dim's group.
    if (zoneDim !== payloadDim) { console.warn("[executeDrop] cross-dim drop rejected", { zoneDim, payloadDim }); return; }
    const dimId = this.dimIdFor(axis, zoneDim);
    if (!dimId) return;

    // Check sequential dim
    if (this.store.dimIsSeq(dimId)) {
      await alertDialog("Sequential Dimension", "Items in sequential dimensions cannot be reordered.");
      return;
    }

    const outline = this.dimOutlineFor(axis, zoneDim);
    const hasOutline = outline.length > 0;
    const entries = this.entriesFor(axis);
    console.log("[executeDrop]", { axis, zone, payload: p, hasOutline, dimId });

    // Save scroll position and selection
    const scrollEl = this.gridMount?.querySelector(".ml-grid-scroll") as HTMLElement;
    const savedScrollLeft = scrollEl?.scrollLeft ?? 0;
    const savedScrollTop = scrollEl?.scrollTop ?? 0;
    const savedSelection = this.saveSelection(axis);

    try {
      if (hasOutline) {
        await this.executeOutlineDrop(axis, dimId, zoneDim, outline, p, zone);
      } else {
        await this.executeFlatDrop(axis, dimId, entries, p, zone);
      }
    } catch (e: any) {
      await alertDialog("Move Failed", e?.message || String(e));
    }

    // Restore selection and scroll (loadView already triggered a render)
    this.store.invalidateDimCache(dimId);
    await this.store.loadView(v.viewId);
    this.restoreSelection(axis, savedSelection);
    this.refresh(); // re-render with restored selection
    // Restore scroll on the new DOM element
    const newScroll = this.gridMount?.querySelector(".ml-grid-scroll") as HTMLElement;
    if (newScroll) { newScroll.scrollLeft = savedScrollLeft; newScroll.scrollTop = savedScrollTop; }
  }

  private async executeOutlineDrop(axis: "row" | "col", dimId: string, dimIdx: number, outline: any[], payload: NonNullable<typeof this.dragPayload>, zone: DropZone) {
    const entries = this.entriesFor(axis);

    if (payload.groupPath) {
      // === Group drag ===
      const srcNode = this.getNodeAtPath(outline, payload.groupPath);
      console.log("[groupDrag] srcPath:", payload.groupPath, "srcNode:", srcNode?.label, "node_id:", srcNode?.node_id);
      if (!srcNode || !srcNode.node_id) { console.warn("[groupDrag] no srcNode or node_id"); return; }
      const srcNodeId = srcNode.node_id;
      const srcDescendants = this.getDescendantNodeIds(srcNode);
      console.log("[groupDrag] srcNodeId:", srcNodeId, "descendants:", [...srcDescendants]);

      switch (zone.mode) {
        case "reorder": {
          // Group dropped on a leaf header — native keeps group at same depth
          const dstEntry = entries[zone.index];
          console.log("[groupDrag] reorder: dstEntry:", dstEntry?.labels, "item_id:", dstEntry?.item_id, "path:", dstEntry?.path);
          if (!dstEntry?.item_id || !dstEntry.path) { console.warn("[groupDrag] no dstEntry item_id/path"); return; }

          // Check if the destination leaf is actually in the outline (graphed).
          // Ungraphed items have path=[displayIndex] which is not a valid outline path.
          const dstInOutline = this.findItemNodeId(outline, dstEntry.item_id).nodeId !== null;
          console.log("[groupDrag] reorder: dstInOutline:", dstInOutline);

          if (!dstInOutline) {
            // Destination is not in the outline graph — materialize it at its
            // displayed root position, then anchor the group before/after it
            // (native: the group inherits the destination's parent = root).
            const dstNodeId = await this.materializeUngraphedItem(dimId, outline, entries, zone.index);
            if (!dstNodeId) { console.warn("[groupDrag] cannot materialize dst item"); return; }
            if (srcNodeId === dstNodeId || srcDescendants.has(dstNodeId)) { console.warn("[groupDrag] self/descendant"); return; }
            const pos = zone.after ? "after" : "before";
            console.log("[groupDrag] reorder moveNodes (materialized dst):", { nodeIds: [srcNodeId], parentNodeId: null, anchorNodeId: dstNodeId, position: pos });
            const mvMatResult = await this.store.api.moveNodes(dimId, [srcNodeId], null, dstNodeId, pos);
            console.log("[groupDrag] reorder result:", mvMatResult);
            break;
          }

          // Native: truncate anchor path to source group depth so the group
          // stays at its level (does not nest into the leaf's parent)
          const srcDepth = payload.groupPath.length;
          let anchorPath = dstEntry.path;
          if (anchorPath.length > srcDepth) {
            anchorPath = anchorPath.slice(0, srcDepth);
          }
          const anchorNode = this.getNodeAtPath(outline, anchorPath);
          console.log("[groupDrag] reorder: anchorPath:", anchorPath, "anchorNode:", anchorNode?.label, "node_id:", anchorNode?.node_id);
          if (!anchorNode?.node_id) { console.warn("[groupDrag] no anchorNode"); return; }

          // Reject self/descendant
          if (srcNodeId === anchorNode.node_id || srcDescendants.has(anchorNode.node_id)) { console.warn("[groupDrag] self/descendant"); return; }

          const anchorParentPath = this.parentPath(anchorPath);
          const anchorParentNode = anchorParentPath.length ? this.getNodeAtPath(outline, anchorParentPath) : null;
          const dstParentId = anchorParentNode?.node_id || null;
          const position = zone.after ? "after" : "before";

          // No-op: source is already immediately before/after target
          const srcParentPath = this.parentPath(payload.groupPath);
          if (JSON.stringify(srcParentPath) === JSON.stringify(anchorParentPath)) {
            const srcIdx = payload.groupPath[payload.groupPath.length - 1];
            const dstIdx = anchorPath[anchorPath.length - 1];
            if (position === "after" && srcIdx === dstIdx + 1) { console.warn("[groupDrag] no-op: already after"); return; }
            if (position === "before" && srcIdx === dstIdx - 1) { console.warn("[groupDrag] no-op: already before"); return; }
          }

          console.log("[groupDrag] reorder moveNodes:", { nodeIds: [srcNodeId], parentNodeId: dstParentId, anchorNodeId: anchorNode.node_id, position, anchorPath });
          const mvReorderResult = await this.store.api.moveNodes(dimId, [srcNodeId], dstParentId, anchorNode.node_id, position);
          console.log("[groupDrag] reorder result:", mvReorderResult);
          break;
        }
        case "into": {
          // Group into another group
          const dstGroup = this.getNodeAtPath(outline, zone.groupPath);
          console.log("[groupDrag] into:", zone.groupPath, "dstGroup:", dstGroup?.label, "node_id:", dstGroup?.node_id);
          if (!dstGroup || !dstGroup.node_id) { console.warn("[groupDrag] no dstGroup or node_id"); return; }
          // Reject self/descendant
          if (srcNodeId === dstGroup.node_id || srcDescendants.has(dstGroup.node_id)) { console.warn("[groupDrag] self/descendant drop"); return; }
          // No-op: source is already a direct child of the target group
          const srcParentPath = this.parentPath(payload.groupPath);
          if (JSON.stringify(srcParentPath) === JSON.stringify(zone.groupPath)) { console.warn("[groupDrag] no-op: already child"); return; }
          console.log("[groupDrag] moveNodes:", { nodeIds: [srcNodeId], parentNodeId: dstGroup.node_id, position: "last" });
          const mvIntoResult = await this.store.api.moveNodes(dimId, [srcNodeId], dstGroup.node_id, null, "last", false);
          console.log("[groupDrag] moveNodes into result:", mvIntoResult);
          break;
        }
        case "before":
        case "after": {
          // Group before/after another group → same parent, anchored on target group
          const dstGroup = this.getNodeAtPath(outline, zone.groupPath);
          console.log("[groupDrag]", zone.mode, ":", zone.groupPath, "dstGroup:", dstGroup?.label, "node_id:", dstGroup?.node_id);
          if (!dstGroup || !dstGroup.node_id) { console.warn("[groupDrag] no dstGroup or node_id"); return; }
          if (srcNodeId === dstGroup.node_id || srcDescendants.has(dstGroup.node_id)) { console.warn("[groupDrag] self/descendant drop"); return; }
          const dstParentPath = this.parentPath(zone.groupPath);
          const dstParentNode = dstParentPath.length ? this.getNodeAtPath(outline, dstParentPath) : null;
          const dstParentId = dstParentNode?.node_id || null;
          // No-op check: source is already immediately before/after target
          const srcParentPath = this.parentPath(payload.groupPath);
          if (JSON.stringify(srcParentPath) === JSON.stringify(dstParentPath)) {
            const srcIdx = payload.groupPath[payload.groupPath.length - 1];
            const dstIdx = zone.groupPath[zone.groupPath.length - 1];
            if (zone.mode === "after" && srcIdx === dstIdx + 1) { console.warn("[groupDrag] no-op: already after"); return; }
            if (zone.mode === "before" && srcIdx === dstIdx - 1) { console.warn("[groupDrag] no-op: already before"); return; }
          }
          console.log("[groupDrag] moveNodes:", { nodeIds: [srcNodeId], parentNodeId: dstParentId, anchorNodeId: dstGroup.node_id, position: zone.mode });
          const mvResult = await this.store.api.moveNodes(dimId, [srcNodeId], dstParentId, dstGroup.node_id, zone.mode === "after" ? "after" : "before");
          console.log("[groupDrag] moveNodes result:", mvResult);
          break;
        }
      }
    } else if (payload.itemId) {
      // === Item drag ===
      const itemIds = payload.selectedItems || [payload.itemId];

      switch (zone.mode) {
        case "reorder": {
          // Item dropped on a leaf header → reorder before/after
          const dstEntry = entries[zone.index];
          if (!dstEntry?.item_id) return;
          if (itemIds.includes(dstEntry.item_id)) return; // self-drop

          let dstParentId: string | null;
          let anchorNodeId: string | null;
          let position: "before" | "after" = zone.after ? "after" : "before";

          const dstInfo = this.findItemNodeId(outline, dstEntry.item_id);
          if (dstInfo.nodeId) {
            // Boundary behavior (native): dropping before first child of a group
            // → outside the group, before the group node. Same for after last child.
            let effectiveParentPath = dstInfo.parentPath;
            anchorNodeId = dstInfo.nodeId;

            if (dstInfo.parentPath.length > 0) {
              const parentNode = this.getNodeAtPath(outline, dstInfo.parentPath);
              const siblings = parentNode?.children || [];
              const isFirst = dstInfo.indexInParent === 0;
              const isLast = dstInfo.indexInParent === siblings.length - 1;

              if (isFirst && !zone.after && parentNode?.node_id) {
                // Before first child → move outside, before the parent group
                effectiveParentPath = this.parentPath(dstInfo.parentPath);
                anchorNodeId = parentNode.node_id;
                position = "before";
              } else if (isLast && zone.after && parentNode?.node_id) {
                // After last child → move outside, after the parent group
                effectiveParentPath = this.parentPath(dstInfo.parentPath);
                anchorNodeId = parentNode.node_id;
                position = "after";
              }
            }

            const dstParentNode = effectiveParentPath.length ? this.getNodeAtPath(outline, effectiveParentPath) : null;
            dstParentId = dstParentNode?.node_id || null;
          } else {
            // Destination item is not in the outline graph — materialize it at
            // its displayed position, then use the new node as the anchor.
            anchorNodeId = await this.materializeUngraphedItem(dimId, outline, entries, zone.index);
            if (!anchorNodeId) return;
            dstParentId = null;
          }

          // placeItemNodes resolves item_ids → graph nodes (materializing
          // ungraphed sources), then moves them — same as native.
          await this.store.api.placeItemNodes(dimId, itemIds, dstParentId, anchorNodeId, position);
          break;
        }
        case "into": {
          // Item(s) into a group → move_items_to_group
          const dstGroup = this.getNodeAtPath(outline, zone.groupPath);
          if (!dstGroup || !dstGroup.node_id) return;
          // No-op: all items already inside this group
          const allInside = itemIds.every((id) => {
            const info = this.findItemNodeId(outline, id);
            return JSON.stringify(info.parentPath) === JSON.stringify(zone.groupPath);
          });
          if (allInside) return;
          await this.store.api.moveItemsToGroup(dimId, itemIds, dstGroup.node_id);
          break;
        }
        case "before":
        case "after": {
          // Item before/after a group → move to group's parent, anchored on the group node
          const dstGroup = this.getNodeAtPath(outline, zone.groupPath);
          if (!dstGroup || !dstGroup.node_id) return;
          const dstParentPath = this.parentPath(zone.groupPath);
          const dstParentNode = dstParentPath.length ? this.getNodeAtPath(outline, dstParentPath) : null;
          const dstParentId = dstParentNode?.node_id || null;
          await this.store.api.placeItemNodes(dimId, itemIds, dstParentId, dstGroup.node_id, zone.mode === "after" ? "after" : "before");
          break;
        }
      }
    }

    // Prune empty groups (native: delete groups with no children after reorder)
    this.store.markDirty();
    await this.pruneEmptyGroups(axis, dimId, dimIdx);
  }

  private async pruneEmptyGroups(axis: "row" | "col", dimId: string, dimIdx = 0) {
    // Re-fetch the outline (it may have changed after the move)
    this.store.invalidateDimCache(dimId);
    const v = this.store.state.activeView;
    if (!v) return;
    await this.store.ensureDimCache([dimId]);
    const outline = this.dimOutlineFor(axis, dimIdx);
    if (!outline.length) return;

    // Find all empty groups (no children, has node_id, item_id is null)
    const findEmpty = (nodes: any[]): string[] => {
      const ids: string[] = [];
      for (const n of nodes) {
        if (n.item_id === null && typeof n.node_id === "string" && (!n.children || n.children.length === 0)) {
          ids.push(n.node_id);
        }
        if (n.children) ids.push(...findEmpty(n.children));
      }
      return ids;
    };

    // Delete empty groups iteratively (deleting one may empty another)
    for (let round = 0; round < 10; round++) {
      const current = this.dimOutlineFor(axis, dimIdx);
      const empty = findEmpty(current);
      if (!empty.length) break;
      for (const gid of empty) {
        await this.store.api.deleteGroupNode(dimId, gid).catch(() => {});
      }
      this.store.invalidateDimCache(dimId);
      await this.store.ensureDimCache([dimId]);
    }
  }

  private async executeFlatDrop(axis: "row" | "col", dimId: string, entries: AxisEntry[], payload: NonNullable<typeof this.dragPayload>, zone: DropZone) {
    // No outline — flat reorder via set_dimension_item_order
    if (zone.mode !== "reorder") return; // groups don't exist in flat dims

    // Full item list of the target dim (not just displayed entries — stacked
    // mode entries mix dims and may omit items hidden inside collapsed groups)
    const itemIds = this.store.dimItems(dimId).map((it) => it.id);
    if (payload.groupPath) return; // can't drag groups without outline

    const srcIds = payload.selectedItems || (payload.itemId ? [payload.itemId] : []);
    const dstEntry = entries[zone.index];
    if (!dstEntry?.item_id) return;

    // Remove source IDs
    const remaining = itemIds.filter((id) => !srcIds.includes(id));
    // Find destination position
    let dstPos = remaining.indexOf(dstEntry.item_id);
    if (dstPos < 0) return;
    if (zone.after) dstPos++;
    // Insert all sources at destination
    remaining.splice(dstPos, 0, ...srcIds);

    await this.store.api.setDimensionItemOrder(dimId, remaining);
    this.store.markDirty();
  }

  private entryKey(e: AxisEntry): string {
    return JSON.stringify(e.key ?? (e.item_id ? [e.item_id] : null));
  }

  private saveSelection(axis: "row" | "col"): { keys: string[]; groupPaths: string[] } {
    const entries = this.entriesFor(axis);
    const keys: string[] = [];
    const groupPaths: string[] = [];
    if (this.selMode === axis && this.selIndices.size > 0) {
      for (const idx of this.selIndices) {
        const entry = entries[idx];
        if (entry?.item_id) keys.push(this.entryKey(entry));
        else if (entry?.path?.length) groupPaths.push(`${entry.dim ?? 0}:${entry.path.join(",")}`);
      }
    }
    return { keys, groupPaths };
  }

  private restoreSelection(axis: "row" | "col", saved: { keys: string[]; groupPaths: string[] }) {
    if (!saved.keys.length && !saved.groupPaths.length) return;
    const entries = this.entriesFor(axis);
    const newIndices = new Set<number>();
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.item_id && saved.keys.includes(this.entryKey(e))) newIndices.add(i);
      else if (e.path?.length && saved.groupPaths.includes(`${e.dim ?? 0}:${e.path.join(",")}`)) newIndices.add(i);
    }
    if (newIndices.size > 0) {
      this.selMode = axis;
      this.selIndices = newIndices;
    }
  }

  // ---- Keyboard navigation ----
  private onKeyDown(e: KeyboardEvent) {
    const v = this.store.state.activeView;
    if (!v || !v.cells || v.loading) return;
    const key = e.key;
    const ctrl = e.ctrlKey || e.metaKey;
    const shift = e.shiftKey;

    if (key === "Escape") { this.cancelEdit(); this.cancelHeaderEdit(); return; }
    if (["Control", "Shift", "Alt", "Meta"].includes(key)) return;

    if (ctrl && key === "a") { e.preventDefault(); this.selectAll(); return; }
    if (shift && !ctrl && key === " ") { e.preventDefault(); this.selectRow(this.selRow, false, false); return; }
    if (ctrl && !shift && key === " ") { e.preventDefault(); this.selectCol(this.selCol, false, false); return; }
    if (ctrl && (key === "c" || key === "Insert")) { e.preventDefault(); this.doCopy(); return; }
    if ((ctrl && key === "v") || (shift && key === "Insert")) { e.preventDefault(); this.doPaste(); return; }
    if (key === "Delete" || key === "Backspace") { e.preventDefault(); this.store.clearSelectedCells(); return; }
    if (key === "F2") {
      e.preventDefault();
      // Native: F2 on a row/col header selection edits the leaf label; else cell edit
      if (this.selMode === "row" && this.selIndices.size) {
        let idx = Math.min(...[...(this.selIndices as Set<number>)]);
        while (idx < this.rows.length && !this.rows[idx].is_leaf) idx++;
        if (idx < this.rows.length) { this.startHeaderLeafEdit("row", idx); return; }
      } else if (this.selMode === "col" && this.selIndices.size) {
        let idx = Math.min(...[...(this.selIndices as Set<number>)]);
        while (idx < this.cols.length && !this.cols[idx].is_leaf) idx++;
        if (idx < this.cols.length) { this.startHeaderLeafEdit("col", idx); return; }
      }
      this.startEdit(this.selRow, this.selCol);
      return;
    }

    if (key === "Enter" || key === "Return") {
      e.preventDefault();
      if (this.isEditing()) { this.commitEdit(); this.moveSel(1, 0); }
      else this.startEdit(this.selRow, this.selCol);
      return;
    }

    if (ctrl && (key === "Home" || key === "End")) {
      e.preventDefault();
      const nr = key === "Home" ? 0 : this.rows.length - 1;
      const nc = key === "Home" ? 0 : this.cols.length - 1;
      this.setSelectionFull(nr, nc, "cell", new Set<string>());
      return;
    }

    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(key)) {
      e.preventDefault();
      let dr = 0, dc = 0;
      if (key === "ArrowLeft") dc = -1;
      else if (key === "ArrowRight") dc = 1;
      else if (key === "ArrowUp") dr = -1;
      else if (key === "ArrowDown") dr = 1;

      if (ctrl && shift) {
        const nr = dr < 0 ? 0 : dr > 0 ? this.rows.length - 1 : this.selRow;
        const nc = dc < 0 ? 0 : dc > 0 ? this.cols.length - 1 : this.selCol;
        this.extendSelection(nr, nc);
      } else if (ctrl) {
        const nr = dr < 0 ? 0 : dr > 0 ? this.rows.length - 1 : this.selRow;
        const nc = dc < 0 ? 0 : dc > 0 ? this.cols.length - 1 : this.selCol;
        this.setSelectionFull(nr, nc, "cell", new Set<string>());
      } else if (shift) {
        this.extendSelection(this.selRow + dr, this.selCol + dc);
      } else {
        this.moveSel(dr, dc);
      }
      this.scrollToSelection();
      return;
    }

    if (key.length === 1 && !ctrl && !shift && !e.altKey) {
      e.preventDefault();
      this.startEdit(this.selRow, this.selCol, key);
      return;
    }
  }

  private moveSel(dr: number, dc: number) {
    const nr = Math.max(0, Math.min(this.rows.length - 1, this.selRow + dr));
    const nc = Math.max(0, Math.min(this.cols.length - 1, this.selCol + dc));
    this.setSelectionFull(nr, nc, "cell", new Set<string>());
  }

  private extendSelection(r: number, c: number) {
    const nr = Math.max(0, Math.min(this.rows.length - 1, r));
    const nc = Math.max(0, Math.min(this.cols.length - 1, c));
    const r0 = Math.min(this.anchorRow, nr), r1 = Math.max(this.anchorRow, nr);
    const c0 = Math.min(this.anchorCol, nc), c1 = Math.max(this.anchorCol, nc);
    const idx = new Set<string>();
    for (let ri = r0; ri <= r1; ri++) for (let ci = c0; ci <= c1; ci++) idx.add(this.cellKey(ri, ci));
    // Preserve the original anchor — do NOT let setSelectionFull reset it to (nr, nc)
    this.setSelectionFull(nr, nc, "cell", idx, this.anchorRow, this.anchorCol);
  }

  private scrollToSelection() {
    const scroll = this.gridMount?.querySelector(".ml-grid-scroll") as HTMLElement;
    if (!scroll) return;
    const rowHeaderW = this.rowHeaderWTotal();
    const colHeaderH = METRICS.colHeaderH * this.colHeaderLevels;
    const cellX = rowHeaderW + (this.colOffsets[this.selCol] ?? 0);
    const cellY = colHeaderH + this.selRow * METRICS.rowH;
    if (cellX < scroll.scrollLeft + rowHeaderW) scroll.scrollLeft = cellX - rowHeaderW;
    if (cellX + this.colW(this.selCol) > scroll.scrollLeft + scroll.clientWidth) scroll.scrollLeft = cellX + this.colW(this.selCol) - scroll.clientWidth;
    if (cellY < scroll.scrollTop + colHeaderH) scroll.scrollTop = cellY - colHeaderH;
    if (cellY + METRICS.rowH > scroll.scrollTop + scroll.clientHeight) scroll.scrollTop = cellY + METRICS.rowH - scroll.clientHeight;
  }

  // ---- Cell editing ----
  private isEditing(): boolean { return this.editor !== null; }

  private startEdit(r: number, c: number, initialChar?: string) {
    if (this.editor) this.commitEdit();
    const v = this.store.state.activeView;
    if (!v || !v.cells || r < 0 || c < 0 || r >= this.rows.length || c >= this.cols.length) return;
    const cellR = this.cellRowMap[r];
    const cellC = this.cellColMap[c];
    if (cellR < 0 || cellC < 0) return;
    const cell = this.cells[cellR * this.colKeys.length + cellC];
    const curVal = cell?.display_value ?? (cell?.value != null ? String(cell.value) : "");
    const scroll = this.gridMount?.querySelector(".ml-grid-scroll") as HTMLElement;
    if (!scroll) return;
    const rowHeaderW = this.rowHeaderWTotal();
    const colHeaderH = METRICS.colHeaderH * this.colHeaderLevels;
    const scrollRect = scroll.getBoundingClientRect();
    const x = rowHeaderW + (this.colOffsets[c] ?? 0) - scroll.scrollLeft + scrollRect.left;
    const y = colHeaderH + r * METRICS.rowH - scroll.scrollTop + scrollRect.top;

    const input = document.createElement("input") as HTMLInputElement;
    input.type = "text";
    input.value = initialChar !== undefined ? initialChar : curVal;
    input.className = "cell-editor";
    input.style.position = "fixed";
    input.style.left = x + "px";
    input.style.top = y + "px";
    input.style.width = this.colW(c) + "px";
    input.style.height = METRICS.rowH + "px";
    input.style.zIndex = "1000";
    document.body.appendChild(input);
    // Defer focus past the dblclick gesture so the browser's click-sequence
    // focus handling can't steal it back and trip the blur-commit.
    setTimeout(() => {
      if (!input.isConnected) return;
      input.focus();
      if (initialChar === undefined) input.select();
      else input.setSelectionRange(input.value.length, input.value.length);
    }, 0);
    this.editor = input;
    this.editorCell = { r, c };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === "Return") { e.preventDefault(); this.commitEdit(); this.moveSel(1, 0); }
      else if (e.key === "Escape") { e.preventDefault(); this.cancelEdit(); }
      else if (e.key === "Tab") { e.preventDefault(); this.commitEdit(); this.moveSel(0, e.shiftKey ? -1 : 1); }
      else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key) && !e.shiftKey && !e.ctrlKey) {
        this.commitEdit();
        let dr = 0, dc = 0;
        if (e.key === "ArrowLeft") dc = -1;
        else if (e.key === "ArrowRight") dc = 1;
        else if (e.key === "ArrowUp") dr = -1;
        else if (e.key === "ArrowDown") dr = 1;
        this.moveSel(dr, dc);
      }
    });
    input.addEventListener("blur", () => { if (this.editor === input) this.commitEdit(); });
  }

  private commitEdit() {
    if (!this.editor || !this.editorCell) return;
    const input = this.editor;
    const { r, c } = this.editorCell;
    this.editor = null;
    this.editorCell = null;
    const v = this.store.state.activeView;
    if (!v) { input.remove(); return; }
    const text = input.value;
    input.remove();
    if (text === "") return;
    const value = isNaN(Number(text)) ? text : Number(text);
    this.store.editCell(r, c, value);
  }

  private cancelEdit() {
    const input = this.editor;
    if (!input) return;
    // Clear state BEFORE remove(): removing a focused input fires 'blur'
    // synchronously, and the blur handler would otherwise commit the edit.
    this.editor = null;
    this.editorCell = null;
    input.remove();
    // Native _hide_editor(restore_grid_focus=True)
    (this.gridMount?.querySelector(".ml-grid-scroll") as HTMLElement | null)?.focus();
  }

  // ---- Header editing (native: inline QLineEdit over header) ----

  private isHeaderEditing(): boolean { return this.headerEdit !== null; }

  private sanitizeLabelText(text: string): string {
    if (!text) return "";
    const extras = new Set(" _-.,:/\\'\"()+[]{}<>!?@#$%^&*|`~");
    let cleaned = "";
    for (const ch of text) {
      if (/[\p{L}\p{N}]/u.test(ch)) cleaned += ch;
      else if (/\s/.test(ch)) cleaned += " ";
      else if (extras.has(ch)) cleaned += ch;
    }
    return cleaned.replace(/\s+/g, " ").trim();
  }

  // Viewport rect of a header element, accounting for the pinned header layers
  // (col headers pinned vertically via translateY(scrollTop); row headers
  // pinned horizontally via translateX(scrollLeft)).
  private headerCellRect(axis: "row" | "col", kind: "leaf" | "band", index: number, level: number, start: number, end: number): { x: number; y: number; w: number; h: number } | null {
    const scroll = this.gridMount?.querySelector(".ml-grid-scroll") as HTMLElement;
    if (!scroll) return null;
    const sr = scroll.getBoundingClientRect();
    const rowHeaderW = this.rowHeaderWTotal();
    const colHeaderH = this.colHeaderLevels * METRICS.colHeaderH;
    if (axis === "row") {
      const lvl = kind === "leaf" ? this.rowBandLevels : level;
      const x = this.rowLevelOffsets[lvl] ?? lvl * METRICS.rowHeaderW;
      const y0 = kind === "leaf" ? index : start;
      const h = kind === "leaf" ? METRICS.rowH : (end - start + 1) * METRICS.rowH;
      // Row header layer at canvas (0, colHeaderH), pinned horizontally
      return { x: sr.left + x, y: sr.top + colHeaderH + y0 * METRICS.rowH - scroll.scrollTop, w: this.rowLevelW(lvl), h };
    }
    const x0 = kind === "leaf" ? index : start;
    const w = kind === "leaf" ? this.colW(index) : (this.colOffsets[end + 1] ?? 0) - (this.colOffsets[start] ?? 0);
    const y = kind === "leaf" ? this.colBandLevels * METRICS.colHeaderH : level * METRICS.colHeaderH;
    // Col header layer at canvas (rowHeaderW, 0), pinned vertically
    return { x: sr.left + rowHeaderW + (this.colOffsets[x0] ?? 0) - scroll.scrollLeft, y: sr.top + y, w, h: METRICS.colHeaderH };
  }

  private headerEditInput(rect: { x: number; y: number; w: number; h: number }, value: string): HTMLInputElement {
    const input = document.createElement("input");
    input.type = "text";
    input.value = value;
    input.className = "cell-editor header-editor";
    input.style.position = "fixed";
    input.style.left = rect.x + 1 + "px";
    input.style.top = rect.y + 1 + "px";
    input.style.width = Math.max(20, rect.w - 2) + "px";
    input.style.height = Math.max(10, rect.h - 2) + "px";
    input.style.zIndex = "1000";
    document.body.appendChild(input);
    // Defer focus past the dblclick gesture — the browser's click-sequence
    // focus handling can otherwise steal it back and trip the blur-commit.
    setTimeout(() => { if (input.isConnected) { input.focus(); input.select(); } }, 0);
    return input;
  }

  private bindHeaderEditorKeys(input: HTMLInputElement) {
    input.addEventListener("keydown", (e) => {
      const key = e.key;
      const mod = e.ctrlKey || e.shiftKey || e.altKey || e.metaKey;
      if (key === "Enter" || key === "Return") {
        e.preventDefault(); e.stopPropagation();
        this.commitHeaderEdit(true, false);
      } else if (key === "Escape") {
        e.preventDefault(); e.stopPropagation();
        this.cancelHeaderEdit();
      } else if (key === "Tab") {
        e.preventDefault(); e.stopPropagation();
        this.commitHeaderEdit(!e.shiftKey, e.shiftKey);
      } else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(key) && !mod) {
        const he = this.headerEdit;
        if (!he) return;
        if (!this.shouldNavOnArrow(key, input)) return; // let text cursor move
        e.preventDefault(); e.stopPropagation();
        const axis = he.axis;
        if (axis === "row") {
          if (key === "ArrowUp") this.commitHeaderEdit(false, true);
          else if (key === "ArrowDown") this.commitHeaderEdit(true, false);
          else if (key === "ArrowLeft") this.headerNavTo("parent");
          else if (key === "ArrowRight") this.headerNavTo("child");
        } else {
          if (key === "ArrowLeft") this.commitHeaderEdit(false, true);
          else if (key === "ArrowRight") this.commitHeaderEdit(true, false);
          else if (key === "ArrowUp") this.headerNavTo("parent");
          else if (key === "ArrowDown") this.headerNavTo("child");
        }
      }
    });
    input.addEventListener("blur", () => {
      if (this.headerEdit?.input === input && !this.headerEdit.committing) this.commitHeaderEdit(false, false);
    });
  }

  // Native: arrows navigate only when Up/Down, all text selected, or cursor at edge
  private shouldNavOnArrow(key: string, input: HTMLInputElement): boolean {
    if (key === "ArrowUp" || key === "ArrowDown") return true;
    const text = input.value;
    const s = input.selectionStart ?? 0, en = input.selectionEnd ?? 0;
    if (s !== en && en - s === text.length) return true; // all selected
    if (s !== en) return false; // partial selection → editing
    if (key === "ArrowLeft" && s === 0) return true;
    if (key === "ArrowRight" && s >= text.length) return true;
    return false;
  }

  private startHeaderLeafEdit(axis: "row" | "col", index: number) {
    const v = this.store.state.activeView;
    if (!v) return;
    const dimIds = axis === "row" ? v.rowDimIds : v.colDimIds;
    const entries = axis === "row" ? this.rows : this.cols;
    const entry = entries[index];
    if (!entry?.is_leaf || !entry.item_id) return;
    // Already editing this leaf (e.g. real dblclick firing after manual detection)
    if (this.headerEdit?.type === "leaf" && this.headerEdit.axis === axis && this.headerEdit.index === index) return;

    // Stacked dims → popup dialog (native: inline editor disabled in stacked mode)
    if (dimIds.length !== 1) { this.editHeaderDialog(axis, index); return; }
    const dimId = dimIds[0];
    const curName = entry.labels[entry.labels.length - 1] || "";

    if (this.editor) this.commitEdit();
    this.cancelHeaderEdit();
    const rect = this.headerCellRect(axis, "leaf", index, 0, 0, 0);
    if (!rect) return;
    const input = this.headerEditInput(rect, curName);
    this.headerEdit = { input, type: "leaf", axis, index, itemId: entry.item_id, dimId, origName: curName, committing: false };
    this.bindHeaderEditorKeys(input);
  }

  private startGroupHeaderEdit(axis: "row" | "col", groupPath: number[], dimIdx = 0) {
    const v = this.store.state.activeView;
    if (!v) return;
    const dimIds = axis === "row" ? v.rowDimIds : v.colDimIds;
    const bands = axis === "row" ? this.rowBands : this.colBands;
    const band = bands.find((b) => b.is_group && JSON.stringify(b.path) === JSON.stringify(groupPath) && (b.dim ?? 0) === dimIdx);
    if (!band) return;
    if (this.headerEdit?.type === "group" && this.headerEdit.axis === axis && (this.headerEdit.dimIdx ?? 0) === dimIdx && JSON.stringify(this.headerEdit.groupPath) === JSON.stringify(groupPath)) return;

    // Stacked dims → popup dialog (native behavior)
    if (dimIds.length !== 1) { this.renameGroupDialog(axis, groupPath, dimIdx); return; }
    const dimId = dimIds[dimIdx];

    if (this.editor) this.commitEdit();
    this.cancelHeaderEdit();
    const rect = this.headerCellRect(axis, "band", 0, band.level, band.start, band.end);
    if (!rect) return;
    const input = this.headerEditInput(rect, band.label);
    this.headerEdit = { input, type: "group", axis, groupPath: [...groupPath], dimIdx, dimId, origName: band.label, committing: false };
    this.bindHeaderEditorKeys(input);
  }

  private async commitHeaderEdit(moveNext: boolean, movePrev: boolean) {
    const he = this.headerEdit;
    if (!he || he.committing) return;
    he.committing = true;
    const input = he.input;
    const newName = this.sanitizeLabelText(input.value);

    const close = () => { input.remove(); this.headerEdit = null; };

    if (!newName) { close(); return; }
    const renamed = newName !== he.origName;

    if (renamed) {
      try {
        if (he.type === "group") {
          const outline = this.dimOutlineFor(he.axis, he.dimIdx ?? 0);
          const node = he.groupPath ? this.getNodeAtPath(outline, he.groupPath) : null;
          if (node?.node_id) {
            await this.store.api.renameGroupNode(he.dimId, node.node_id, newName);
          } else { he.committing = false; close(); return; }
        } else if (he.itemId) {
          await this.store.api.renameDimensionItem(he.dimId, he.itemId, newName);
        } else { he.committing = false; close(); return; }
      } catch (e: any) {
        // Native: warning dialog, editor stays open with text selected
        he.committing = false;
        await alertDialog("Duplicate Name", `'${newName}' already exists in this ${he.axis} dimension.`);
        if (input.isConnected && this.headerEdit === he) { input.focus(); input.select(); }
        return;
      }
      this.store.invalidateDimCache(he.dimId);
      this.store.markDirty();
      this.store.refreshModel();
    }

    // Resolve navigation target before reload (paths/indices are stable under rename)
    let navTarget: { type: "leaf" | "group"; ref: number | number[]; dim?: number } | null = null;
    if (moveNext || movePrev) {
      if (he.type === "leaf" && he.index !== undefined) {
        const nextIdx = moveNext ? this.nextLeafIndex(he.axis, he.index) : this.prevLeafIndex(he.axis, he.index);
        if (nextIdx !== null) navTarget = { type: "leaf", ref: nextIdx };
      } else if (he.type === "group" && he.groupPath) {
        navTarget = this.groupSiblingTarget(he.axis, he.groupPath, moveNext ? 1 : -1, he.dimIdx ?? 0);
      }
    }

    close();
    if (renamed) {
      const v = this.store.state.activeView;
      if (v) await this.store.loadView(v.viewId);
    }

    if (navTarget) {
      if (navTarget.type === "leaf") this.startHeaderLeafEdit(he.axis, navTarget.ref as number);
      else this.startGroupHeaderEdit(he.axis, navTarget.ref as number[], navTarget.dim ?? 0);
    } else if (moveNext && he.type === "leaf" && he.index !== undefined) {
      // Native: Enter on the last leaf sibling enters cell edit mode there
      if (he.axis === "row") this.startEdit(he.index, Math.max(0, this.selCol));
      else this.startEdit(Math.max(0, this.selRow), he.index);
    }
  }

  private cancelHeaderEdit() {
    const he = this.headerEdit;
    if (!he) return;
    this.headerEdit = null;
    he.input.remove();
  }

  // Manual dblclick detection: selecting a header re-renders the grid, so the
  // second click lands on a rebuilt DOM node and a real 'dblclick' never fires.
  private lastHeaderClick: { axis: "row" | "col"; key: string; time: number } | null = null;
  private headerDblClick(axis: "row" | "col", key: string): boolean {
    const now = Date.now();
    const last = this.lastHeaderClick;
    this.lastHeaderClick = { axis, key, time: now };
    return !!(last && last.axis === axis && last.key === key && now - last.time < 500);
  }

  private nextLeafIndex(axis: "row" | "col", index: number): number | null {
    const entries = axis === "row" ? this.rows : this.cols;
    for (let i = index + 1; i < entries.length; i++) if (entries[i].is_leaf && entries[i].item_id) return i;
    return null;
  }

  private prevLeafIndex(axis: "row" | "col", index: number): number | null {
    const entries = axis === "row" ? this.rows : this.cols;
    for (let i = index - 1; i >= 0; i--) if (entries[i].is_leaf && entries[i].item_id) return i;
    return null;
  }

  // Native group sibling nav: prefer group siblings at same level, fall back to leaf
  private groupSiblingTarget(axis: "row" | "col", groupPath: number[], dir: 1 | -1, dimIdx = 0): { type: "leaf" | "group"; ref: number | number[]; dim?: number } | null {
    const outline = this.dimOutlineFor(axis, dimIdx);
    const parentPath = groupPath.slice(0, -1);
    const curIdx = groupPath[groupPath.length - 1];
    const parentNode = parentPath.length ? this.getNodeAtPath(outline, parentPath) : null;
    const siblings: any[] = parentPath.length ? (parentNode?.children || []) : outline;
    for (let i = curIdx + dir; i >= 0 && i < siblings.length; i += dir) {
      if (siblings[i].item_id === null) return { type: "group", ref: [...parentPath, i], dim: dimIdx };
    }
    const entries = axis === "row" ? this.rows : this.cols;
    for (let i = curIdx + dir; i >= 0 && i < siblings.length; i += dir) {
      if (siblings[i].item_id !== null) {
        const sibPath = [...parentPath, i];
        const leafIdx = entries.findIndex((e) => JSON.stringify(e.path) === JSON.stringify(sibPath));
        if (leafIdx >= 0) return { type: "leaf", ref: leafIdx };
      }
    }
    return null;
  }

  // Native arrow nav: row Left=parent / Right=child, col Up=parent / Down=child
  private headerNavTo(dir: "parent" | "child") {
    const he = this.headerEdit;
    if (!he) return;
    const outline = this.dimOutlineFor(he.axis, he.dimIdx ?? 0);
    let target: { type: "leaf" | "group"; ref: number | number[]; dim?: number } | null = null;

    if (dir === "parent") {
      const path = he.type === "group" ? he.groupPath : this.leafOutlinePath(he.axis, he.index!);
      if (path && path.length > 1) target = { type: "group", ref: path.slice(0, -1), dim: he.dimIdx ?? 0 };
    } else {
      // child: only groups have children
      if (he.type === "group" && he.groupPath) {
        const node = this.getNodeAtPath(outline, he.groupPath);
        const first = node?.children?.[0];
        if (first) {
          const childPath = [...he.groupPath, 0];
          if (first.item_id === null) target = { type: "group", ref: childPath, dim: he.dimIdx ?? 0 };
          else {
            const entries = he.axis === "row" ? this.rows : this.cols;
            const leafIdx = entries.findIndex((e) => JSON.stringify(e.path) === JSON.stringify(childPath));
            if (leafIdx >= 0) target = { type: "leaf", ref: leafIdx };
          }
        }
      }
    }
    if (!target) return;
    // Commit current edit, then open editor on target (native commit_and_navigate_to)
    const heRef = he;
    he.committing = true;
    const newName = this.sanitizeLabelText(he.input.value);
    const doRename = newName && newName !== he.origName;
    const finish = async () => {
      try {
        if (doRename) {
          if (heRef.type === "group") {
            const node = this.getNodeAtPath(outline, heRef.groupPath!);
            if (node?.node_id) await this.store.api.renameGroupNode(heRef.dimId, node.node_id, newName);
          } else if (heRef.itemId) {
            await this.store.api.renameDimensionItem(heRef.dimId, heRef.itemId, newName);
          }
          this.store.invalidateDimCache(heRef.dimId);
          this.store.markDirty();
          this.store.refreshModel();
          const v = this.store.state.activeView;
          if (v) await this.store.loadView(v.viewId);
        }
      } catch (e: any) {
        await alertDialog("Duplicate Name", `'${newName}' already exists in this ${heRef.axis} dimension.`);
        if (heRef.input.isConnected && this.headerEdit === heRef) { heRef.committing = false; heRef.input.focus(); heRef.input.select(); }
        return;
      }
      heRef.input.remove();
      if (this.headerEdit === heRef) this.headerEdit = null;
      if (target!.type === "leaf") this.startHeaderLeafEdit(heRef.axis, target!.ref as number);
      else this.startGroupHeaderEdit(heRef.axis, target!.ref as number[], target!.dim ?? 0);
    };
    finish();
  }

  private leafOutlinePath(axis: "row" | "col", index: number): number[] | null {
    const entries = axis === "row" ? this.rows : this.cols;
    const e = entries[index];
    if (!e?.item_id) return null;
    const info = this.findItemNodeId(this.dimOutlineFor(axis, e.dim ?? 0), e.item_id);
    if (!info.nodeId) return null;
    return [...info.parentPath, info.indexInParent];
  }

  // Stacked-mode fallback: popup rename dialog (native rename_header_hit)
  private async editHeaderDialog(axis: "row" | "col", index: number) {
    const v = this.store.state.activeView;
    if (!v) return;
    const dimIds = axis === "row" ? v.rowDimIds : v.colDimIds;
    const entries = axis === "row" ? this.rows : this.cols;
    const entry = entries[index];
    if (!entry?.item_id) return;
    // Find which dimension this item belongs to
    let dimId: string | null = null;
    let item: { id: string; name: string } | null = null;
    for (const id of dimIds) {
      const it = this.store.dimItems(id).find((x) => x.id === entry.item_id);
      if (it) { dimId = id; item = it; break; }
    }
    if (!dimId || !item) return;
    const newName = await inputDialog(axis === "row" ? "Rename Row" : "Rename Column", item.name, "Name");
    if (!newName || !newName.trim() || newName.trim() === item.name) return;
    try {
      await this.store.api.renameDimensionItem(dimId, item.id, newName.trim());
      this.store.invalidateDimCache(dimId);
      this.store.markDirty();
      this.store.loadView(v.viewId);
      this.store.refreshModel();
    } catch (e: any) { await alertDialog("Rename Failed", e?.message || String(e)); }
  }

  private async renameGroupDialog(axis: "row" | "col", groupPath: number[], dimIdx = 0) {
    const v = this.store.state.activeView;
    if (!v) return;
    const dimIds = axis === "row" ? v.rowDimIds : v.colDimIds;
    if (!dimIds.length) return;
    const outline = this.dimOutlineFor(axis, dimIdx);
    const node = this.getNodeAtPath(outline, groupPath);
    const cur = node?.label ?? "";
    const newName = await inputDialog(axis === "row" ? "Rename Row Group" : "Rename Column Group", cur, "Group name");
    if (!newName || !newName.trim() || newName.trim() === cur) return;
    if (!node?.node_id) return;
    try {
      await this.store.api.renameGroupNode(dimIds[dimIdx], node.node_id, newName.trim());
      this.store.invalidateDimCache(dimIds[dimIdx]);
      this.store.markDirty();
      this.store.loadView(v.viewId);
      this.store.refreshModel();
    } catch (e: any) { await alertDialog("Duplicate Group Label", e?.message || String(e)); }
  }

  // ---- Copy/Paste ----
  private async doCopy() {
    const text = await this.store.copySelectionToClipboard();
    if (text) { try { await navigator.clipboard.writeText(text); } catch { const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove(); } }
  }

  private async doPaste() {
    let text = "";
    try { text = await navigator.clipboard.readText(); } catch { text = (await inputDialog("Paste", "", "Paste TSV data")) || ""; }
    if (text) this.store.pasteFromClipboard(text);
  }

  // ---- Context menu (matches native matrix_grid.py contextMenuEvent) ----
  private showContextMenu(e: MouseEvent, axis: "row" | "col" | "cell") {
    const existing = document.querySelector(".ctx-menu");
    if (existing) existing.remove();
    const menu = el("div", { class: "ctx-menu" });
    const v = this.store.state.activeView;
    if (!v) { return; }

    const close = (ev: MouseEvent) => { if (!menu.contains(ev.target as Node)) { menu.remove(); document.removeEventListener("mousedown", close); } };

    const addItem = (label: string, fn: () => void, enabled = true) => {
      const item = el("div", { class: "ctx-item" + (enabled ? "" : " disabled") }, [label]);
      if (enabled) {
        item.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
        item.addEventListener("click", (ev) => {
          ev.preventDefault(); ev.stopPropagation();
          menu.remove();
          document.removeEventListener("mousedown", close);
          fn();
        });
      }
      menu.appendChild(item);
    };
    const addSep = () => menu.appendChild(el("div", { class: "ctx-sep" }));

    // Count selected items for label suffixes
    const selCount = this.selIndices.size || 1;
    const selSuffix = selCount > 1 ? ` (${selCount} items)` : "";

    // Check if right-clicking on a group band — native shows only these items
    const groupBand = this.findGroupBandAt(e.clientX, e.clientY);
    if (groupBand) {
      addItem("Add Aggregate Item…", () => this.addAggregateItem(groupBand.axis, groupBand.path));
      addItem("Ungroup This Group", () => this.ungroupGroup(groupBand.axis, groupBand.path));
      addSep();
    }

    // Axis-specific actions (native: row header → row actions, col header → col actions)
    const addAxisActions = (ax: "row" | "col") => {
      const dimIds = ax === "row" ? v.rowDimIds : v.colDimIds;
      if (!dimIds.length) return;

      addItem(`Add Group…${selSuffix}`, () => this.addGroupForAxis(ax));
      addItem(`Move Selection To Group…${selSuffix}`, () => this.moveToGroup(ax));
      addItem(`Ungroup Selection${selSuffix}`, () => this.ungroupItems(ax));
      addSep();
      addItem("Insert Before", () => this.insertRelative(ax, false));
      addItem("Insert After", () => this.insertRelative(ax, true));
    };

    if (axis === "row") {
      addAxisActions("row");
    } else if (axis === "col") {
      addAxisActions("col");
    } else {
      // Cell context: native shows Row / Column / Mode submenus
      const addSubmenu = (label: string, items: { label: string; fn: () => void; enabled?: boolean }[]) => {
        const sub = el("div", { class: "ctx-item ctx-submenu" }, [label + " ▸"]) as HTMLElement;
        const subMenu = el("div", { class: "ctx-menu", style: { display: "none", position: "absolute", left: "100%", top: "0" } });
        for (const it of items) {
          const mi = el("div", { class: "ctx-item" + (it.enabled === false ? " disabled" : "") }, [it.label]);
          if (it.enabled !== false) {
            mi.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
            mi.addEventListener("click", (ev) => {
              ev.preventDefault(); ev.stopPropagation();
              menu.remove();
              document.removeEventListener("mousedown", close);
              it.fn();
            });
          }
          subMenu.appendChild(mi);
        }
        sub.appendChild(subMenu);
        sub.addEventListener("mouseenter", () => { subMenu.style.display = "block"; });
        sub.addEventListener("mouseleave", () => { subMenu.style.display = "none"; });
        menu.appendChild(sub);
      };

      const rowDimIds = v.rowDimIds;
      const colDimIds = v.colDimIds;
      const hasRow = rowDimIds.length > 0;
      const hasCol = colDimIds.length > 0;

      if (hasRow) {
        addSubmenu("Row", [
          { label: `Add Group…${selSuffix}`, fn: () => this.addGroupForAxis("row") },
          { label: `Move Selection To Group…${selSuffix}`, fn: () => this.moveToGroup("row") },
          { label: `Ungroup Selection${selSuffix}`, fn: () => this.ungroupItems("row") },
          { label: "", fn: () => {}, enabled: false },
          { label: "Insert Before", fn: () => this.insertRelative("row", false) },
          { label: "Insert After", fn: () => this.insertRelative("row", true) },
        ]);
      }
      if (hasCol) {
        addSubmenu("Column", [
          { label: `Add Group…${selSuffix}`, fn: () => this.addGroupForAxis("col") },
          { label: `Move Selection To Group…${selSuffix}`, fn: () => this.moveToGroup("col") },
          { label: `Ungroup Selection${selSuffix}`, fn: () => this.ungroupItems("col") },
          { label: "", fn: () => {}, enabled: false },
          { label: "Insert Before", fn: () => this.insertRelative("col", false) },
          { label: "Insert After", fn: () => this.insertRelative("col", true) },
        ]);
      }
      if (hasRow || hasCol) addSep();
      addItem("Edit Cell", () => this.startEdit(this.selRow, this.selCol));
      addItem("Clear Override", () => this.store.clearSelectedCells());
      addItem("Set Rule…", async () => {
        const expr = await inputDialog("Set Rule", "", "LHS = RHS or =value");
        if (expr) this.store.setRuleForCell(expr, expr.startsWith("$"));
      });
      addSep();
      addItem("Copy", () => this.doCopy());
      addItem("Paste", () => this.doPaste());
    }

    menu.style.left = e.clientX + "px";
    menu.style.top = e.clientY + "px";
    document.body.appendChild(menu);
    setTimeout(() => document.addEventListener("mousedown", close), 0);
  }

  private findGroupBandAt(clientX: number, clientY: number): { axis: "row" | "col"; path: number[]; band: Band } | null {
    // Check if the click is within a group band element
    const target = document.elementFromPoint(clientX, clientY) as HTMLElement;
    if (!target) return null;
    // Walk up to find a band element
    let el: HTMLElement | null = target;
    while (el) {
      if (el.classList && el.classList.contains("ml-band")) {
        // Determine which axis by checking parent layer
        const parent = el.parentElement;
        if (parent?.classList.contains("ml-row-headers")) {
          // Find the matching row band
          for (const band of this.rowBands) {
            if (band.is_group && band.path && band.label === el.textContent?.replace(/[▼▶▸]/g, "").trim()) {
              return { axis: "row", path: band.path, band };
            }
          }
        } else if (parent?.classList.contains("ml-col-headers")) {
          for (const band of this.colBands) {
            if (band.is_group && band.path && band.label === el.textContent?.replace(/[▼▶▸]/g, "").trim()) {
              return { axis: "col", path: band.path, band };
            }
          }
        }
        return null;
      }
      el = el.parentElement;
    }
    return null;
  }

  private async addAggregateItem(axis: "row" | "col", groupPath: number[]) {
    const v = this.store.state.activeView!;
    const dimIds = axis === "row" ? v.rowDimIds : v.colDimIds;
    if (!dimIds.length) return;
    let dimId = dimIds[0];
    if (dimIds.length > 1) {
      const dimNames = dimIds.map((id) => this.store.dimName(id));
      const chosen = await pickDialog("Which dimension?", dimNames);
      if (!chosen) return;
      const dim = this.store.state.dimensions.find((d) => d.name === chosen.trim());
      if (!dim) { await alertDialog("Not Found", "Dimension not found."); return; }
      dimId = dim.id;
    }
    const dim = this.store.dimCache.get(dimId);
    if (!dim?.outline) { await alertDialog("No Outline", "No outline for this dimension."); return; }
    const groupNode = this.getNodeAtPath(dim.outline, groupPath);
    if (!groupNode || groupNode.item_id !== null) { await alertDialog("Not a Group", "The selected node is not a group."); return; }
    let groupNodeId = groupNode.node_id;
    if (!groupNodeId) {
      const children = (groupNode.children || []).map((c: any) => ({ label: c.label, item_id: c.item_id }));
      const r = await this.store.api.ensureGroupInGraph(dimId, groupNode.label, children);
      groupNodeId = r?.data?.group_node_id;
    }
    if (!groupNodeId) { await alertDialog("Error", "Could not resolve group node ID."); return; }
    const name = await inputDialog("Add Aggregate Item", "Total", "Aggregate item name");
    if (!name || !name.trim()) return;
    try {
      await this.store.api.createAggregateItem(dimId, groupNodeId, name.trim());
      this.store.markDirty();
      this.store.invalidateDimCache(dimId);
      this.store.loadView(v.viewId);
      this.store.refreshModel();
    } catch (e: any) { await alertDialog("Add Aggregate Failed", e?.message || String(e)); }
  }

  private async ungroupGroup(axis: "row" | "col", groupPath: number[]) {
    const v = this.store.state.activeView!;
    const dimIds = axis === "row" ? v.rowDimIds : v.colDimIds;
    if (!dimIds.length) return;
    let dimId = dimIds[0];
    if (dimIds.length > 1) {
      const dimNames = dimIds.map((id) => this.store.dimName(id));
      const chosen = await pickDialog("Which dimension?", dimNames);
      if (!chosen) return;
      const dim = this.store.state.dimensions.find((d) => d.name === chosen.trim());
      if (!dim) { await alertDialog("Not Found", "Dimension not found."); return; }
      dimId = dim.id;
    }
    const dim = this.store.dimCache.get(dimId);
    if (!dim?.outline) return;
    const groupNode = this.getNodeAtPath(dim.outline, groupPath);
    if (!groupNode || groupNode.item_id !== null) return;
    const itemIds: string[] = [];
    const collect = (nodes: any[]) => {
      for (const n of nodes) {
        if (n.item_id) itemIds.push(n.item_id);
        if (n.children) collect(n.children);
      }
    };
    collect(groupNode.children || []);
    if (!itemIds.length) { await alertDialog("Empty Group", "No items in this group."); return; }
    const ok = await confirmDialog("Ungroup", `Ungroup "${groupNode.label}"? This will move ${itemIds.length} item(s) to root.`, "Ungroup", true);
    if (!ok) return;
    try {
      await this.store.api.ungroupItems(dimId, itemIds);
      this.store.markDirty();
      this.store.invalidateDimCache(dimId);
      this.store.loadView(v.viewId);
      this.store.refreshModel();
    } catch (e: any) { await alertDialog("Ungroup Failed", e?.message || String(e)); }
  }

  private async deleteGroup(axis: "row" | "col", groupPath: number[]) {
    const v = this.store.state.activeView!;
    const dimIds = axis === "row" ? v.rowDimIds : v.colDimIds;
    if (!dimIds.length) return;
    let dimId = dimIds[0];
    if (dimIds.length > 1) {
      const dimNames = dimIds.map((id) => this.store.dimName(id));
      const chosen = await pickDialog("Which dimension?", dimNames);
      if (!chosen) return;
      const dim = this.store.state.dimensions.find((d) => d.name === chosen.trim());
      if (!dim) { await alertDialog("Not Found", "Dimension not found."); return; }
      dimId = dim.id;
    }
    const dim = this.store.dimCache.get(dimId);
    if (!dim?.outline) return;
    const groupNode = this.getNodeAtPath(dim.outline, groupPath);
    if (!groupNode || groupNode.item_id !== null || !groupNode.node_id) return;
    const ok = await confirmDialog("Delete Group", `Delete group "${groupNode.label}" and all its children?`, "Delete", true);
    if (!ok) return;
    try {
      await this.store.api.deleteGroup(dimId, groupNode.node_id);
      this.store.markDirty();
      this.store.invalidateDimCache(dimId);
      this.store.loadView(v.viewId);
      this.store.refreshModel();
    } catch (e: any) { await alertDialog("Delete Failed", e?.message || String(e)); }
  }

  // Contiguous leaf indices on an axis (native: sel_mode == axis, all leaf,
  // contiguous). Falls back to the current single row/col when the selection
  // mode does not match.
  private contiguousLeafIndices(axis: "row" | "col"): number[] | null {
    const entries = axis === "row" ? this.rows : this.cols;
    let indices: number[];
    if (this.selMode === axis && this.selIndices.size > 0) {
      indices = [...(this.selIndices as Set<number>)].sort((a, b) => a - b);
    } else {
      const cur = axis === "row" ? this.selRow : this.selCol;
      indices = cur >= 0 ? [cur] : [];
    }
    if (!indices.length) return null;
    for (const i of indices) {
      if (i < 0 || i >= entries.length || !entries[i].is_leaf) return null;
    }
    for (let i = 1; i < indices.length; i++) {
      if (indices[i] !== indices[i - 1] + 1) return null;
    }
    return indices;
  }

  private uniqueItemName(existing: Set<string>): string {
    const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
    while (true) {
      let name = "";
      for (let i = 0; i < 5; i++) name += alphabet[Math.floor(Math.random() * alphabet.length)];
      if (!existing.has(name)) return name;
    }
  }

  private async insertRelative(axis: "row" | "col", after: boolean) {
    const v = this.store.state.activeView!;
    const dimIds = axis === "row" ? v.rowDimIds : v.colDimIds;
    if (dimIds.length !== 1) { await alertDialog("Multiple Dimensions", "Insert requires exactly one dimension on this axis."); return; }
    const dimId = dimIds[0];
    const entries = axis === "row" ? this.rows : this.cols;

    // Native: one new item per selected contiguous leaf, no name prompt
    const indices = this.contiguousLeafIndices(axis);
    if (!indices) { await alertDialog("Insert", "Select contiguous leaf items first."); return; }
    const anchorIndex = after ? indices[indices.length - 1] : indices[0];
    const anchorEntry = entries[anchorIndex];
    if (!anchorEntry?.item_id) { await alertDialog("No Selection", "Select a leaf item first."); return; }

    try {
      const existingNames = new Set(this.store.dimItems(dimId).map((it) => it.name));
      const createdIds: string[] = [];
      for (let i = 0; i < indices.length; i++) {
        const name = this.uniqueItemName(existingNames);
        existingNames.add(name);
        const r: any = await this.store.api.createDimensionItem(dimId, name);
        const id = typeof r === "string" ? r : (r?.data?.id ?? r?.data?.item_id ?? r?.id ?? r?.item_id ?? (typeof r?.data === "string" ? r.data : null));
        if (id) createdIds.push(id);
      }
      if (!createdIds.length) { this.store.invalidateDimCache(dimId); this.store.loadView(v.viewId); return; }

      // Rebuild the flat item order: created items land right before/after the anchor
      this.store.invalidateDimCache(dimId);
      await this.store.ensureDimCache([dimId]);
      const items = this.store.dimItems(dimId);
      const remaining = items.filter((it) => !createdIds.includes(it.id));
      const anchorPos = remaining.findIndex((it) => it.id === anchorEntry.item_id);
      const insertPos = anchorPos >= 0 ? anchorPos + (after ? 1 : 0) : remaining.length;
      const newOrder = [...remaining.slice(0, insertPos).map((it) => it.id), ...createdIds, ...remaining.slice(insertPos).map((it) => it.id)];
      await this.store.api.setDimensionItemOrder(dimId, newOrder);

      // If the anchor is in the outline graph, place the new items there too
      const outline = this.dimOutlineFor(axis);
      const anchorInfo = this.findItemNodeId(outline, anchorEntry.item_id);
      if (anchorInfo.nodeId) {
        const inGroup = anchorInfo.parentPath.length > 0;
        const anchorNode = this.getNodeAtPath(outline, [...anchorInfo.parentPath, anchorInfo.indexInParent]);
        const parentNode = inGroup ? this.getNodeAtPath(outline, anchorInfo.parentPath) : null;
        const grandPath = this.parentPath(anchorInfo.parentPath);
        const grandNode = grandPath.length ? this.getNodeAtPath(outline, grandPath) : null;
        let parentNodeId: string | null;
        let anchorNodeId: string | null;
        let position: string;
        if (after && anchorNode?.is_aggregate && inGroup) {
          // After an aggregate inside a group → outside, after the group
          parentNodeId = grandNode?.node_id ?? null;
          anchorNodeId = parentNode?.node_id ?? null;
          position = "after";
        } else if (!after && inGroup && anchorInfo.indexInParent === 0) {
          // Before the first child of a group → outside, before the group
          parentNodeId = grandNode?.node_id ?? null;
          anchorNodeId = parentNode?.node_id ?? null;
          position = "before";
        } else {
          parentNodeId = parentNode?.node_id ?? null;
          anchorNodeId = anchorInfo.nodeId;
          position = after ? "after" : "before";
        }
        if (!anchorNodeId) position = "last"; // before/after require an anchor
        await this.store.api.placeItemNodes(dimId, createdIds, parentNodeId, anchorNodeId, position);
      }

      this.store.markDirty();
      this.store.invalidateDimCache(dimId);
      this.store.loadView(v.viewId);
      this.store.refreshModel();
    } catch (e: any) { await alertDialog("Insert Failed", e?.message || String(e)); }
  }

  private getNodeAtPath(nodes: any[], path: number[]): any {
    let current = nodes;
    for (const idx of path) {
      if (!current || idx >= current.length) return null;
      current = current[idx].children || [];
    }
    // Return the node at the path (not its children)
    let node = null;
    let children = nodes;
    for (const idx of path) {
      if (!children || idx >= children.length) return null;
      node = children[idx];
      children = node.children || [];
    }
    return node;
  }

  private async addGroupForAxis(axis: "row" | "col") {
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
    console.log("[addGroupForAxis] creating group", { dimId, label: label.trim() });
    try {
      const r = await this.store.api.createGroup(dimId, label.trim());
      console.log("[addGroupForAxis] group created:", r);
      const groupNodeId = typeof r === "string" ? r : (r?.data?.id || r?.data?.group_node_id || r?.id);
      this.store.invalidateDimCache(dimId);

      // If items are selected, move them into the new group so it appears in the grid.
      const sel = axis === "row" ? this.selRow : this.selCol;
      const entries = axis === "row" ? this.rows : this.cols;
      const selEntry = entries[sel];
      const itemIds: string[] = [];
      if (selEntry?.item_id) {
        if (this.selMode === "row" || this.selMode === "col") {
          // Multi-select: gather all selected items on this axis
          const idxs = this.selIndices.size ? [...this.selIndices] : [sel];
          for (const i of idxs) {
            const e = entries[i];
            if (e?.item_id) itemIds.push(e.item_id);
          }
        } else {
          itemIds.push(selEntry.item_id);
        }
      }
      if (itemIds.length && groupNodeId) {
        await this.store.api.moveItemsToGroup(dimId, itemIds, groupNodeId);
      }

      this.store.markDirty();
      this.store.invalidateDimCache(dimId);
      await this.store.loadView(v.viewId);
      this.store.refreshModel();
    } catch (e: any) {
      await alertDialog("Create Group Failed", e?.message || String(e));
    }
  }

  private async moveToGroup(axis: "row" | "col") {
    const v = this.store.state.activeView!;
    const dimIds = axis === "row" ? v.rowDimIds : v.colDimIds;
    if (!dimIds.length) { await alertDialog("No Dimensions", `No dimensions on the ${axis} axis.`); return; }
    let dimId = dimIds[0];
    if (dimIds.length > 1) {
      const dimNames = dimIds.map((id) => this.store.dimName(id));
      const chosen = await pickDialog("Which dimension?", dimNames);
      if (!chosen) return;
      const dim = this.store.state.dimensions.find((d) => d.name === chosen.trim());
      if (!dim) { await alertDialog("Not Found", "Dimension not found."); return; }
      dimId = dim.id;
    }
    const dim = this.store.dimCache.get(dimId);
    if (!dim?.outline) { await alertDialog("No Groups", "No groups defined. Create a group first."); return; }
    const groups = this.collectGroups(dim.outline);
    if (!groups.length) { await alertDialog("No Groups", "No groups available."); return; }
    const groupNames = groups.map((g) => g.label);
    const chosenName = await pickDialog("Move to Group", groupNames);
    if (!chosenName) return;
    const group = groups.find((g) => g.label === chosenName.trim());
    if (!group) return;
    const entries = axis === "row" ? this.rows : this.cols;
    const selectedItemIds: string[] = [];
    if (this.selMode === axis) {
      for (const idx of this.selIndices as Set<number>) {
        const entry = entries[idx];
        if (entry?.item_id) selectedItemIds.push(entry.item_id);
      }
    } else if (this.selMode === "cell") {
      const entry = entries[axis === "row" ? this.selRow : this.selCol];
      if (entry?.item_id) selectedItemIds.push(entry.item_id);
    }
    if (!selectedItemIds.length) { await alertDialog("No Selection", "No items selected."); return; }
    try {
      await this.store.api.moveItemsToGroup(dimId, selectedItemIds, group.node_id);
      this.store.markDirty();
      this.store.invalidateDimCache(dimId);
      this.store.loadView(v.viewId);
      this.store.refreshModel();
    } catch (e: any) { await alertDialog("Move Failed", e?.message || String(e)); }
  }

  private async ungroupItems(axis: "row" | "col") {
    const v = this.store.state.activeView!;
    const dimIds = axis === "row" ? v.rowDimIds : v.colDimIds;
    if (!dimIds.length) { await alertDialog("No Dimensions", `No dimensions on the ${axis} axis.`); return; }
    let dimId = dimIds[0];
    if (dimIds.length > 1) {
      const dimNames = dimIds.map((id) => this.store.dimName(id));
      const chosen = await pickDialog("Which dimension?", dimNames);
      if (!chosen) return;
      const dim = this.store.state.dimensions.find((d) => d.name === chosen.trim());
      if (!dim) { await alertDialog("Not Found", "Dimension not found."); return; }
      dimId = dim.id;
    }
    const entries = axis === "row" ? this.rows : this.cols;
    const selectedItemIds: string[] = [];
    if (this.selMode === axis) {
      for (const idx of this.selIndices as Set<number>) {
        const entry = entries[idx];
        if (entry?.item_id) selectedItemIds.push(entry.item_id);
      }
    } else if (this.selMode === "cell") {
      const entry = entries[axis === "row" ? this.selRow : this.selCol];
      if (entry?.item_id) selectedItemIds.push(entry.item_id);
    }
    if (!selectedItemIds.length) { await alertDialog("No Selection", "No items selected."); return; }
    try {
      await this.store.api.ungroupItems(dimId, selectedItemIds);
      this.store.markDirty();
      this.store.invalidateDimCache(dimId);
      this.store.loadView(v.viewId);
      this.store.refreshModel();
    } catch (e: any) { await alertDialog("Ungroup Failed", e?.message || String(e)); }
  }

  private collectGroups(nodes: any[]): { node_id: string; label: string }[] {
    const groups: { node_id: string; label: string }[] = [];
    const walk = (ns: any[]) => {
      for (const n of ns) {
        if (n.item_id === null && n.children && n.children.length > 0) {
          groups.push({ node_id: n.node_id, label: n.label });
          walk(n.children);
        }
      }
    };
    walk(nodes);
    return groups;
  }

  private closeTab(viewId: string) {
    const tabs = this.store.state.openTabs;
    const idx = tabs.findIndex((t) => t.viewId === viewId);
    if (idx < 0) return;
    tabs.splice(idx, 1);
    if (this.store.state.activeTab === viewId) {
      this.store.state.activeTab = tabs.length ? tabs[Math.max(0, idx - 1)].viewId : null;
      if (this.store.state.activeTab) this.store.loadView(this.store.state.activeTab);
      else { this.store.state.activeView = null; this.store.notify(); }
    } else { this.store.notify(); }
  }
}
