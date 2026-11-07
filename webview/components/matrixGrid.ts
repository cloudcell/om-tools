import { Store, SelMode, SET_RULE_PLACEHOLDER } from "../state";
import { el, clear } from "../dom";
import { CellDTO } from "../api";
import { PivotBar } from "./pivotBar";

/** MatrixGrid — center workspace with full keyboard navigation, selection modes,
 *  cell editing, copy/paste, and context menus. Mirrors lib_gui_elements/matrix_grid.py. */
export class MatrixGrid {
  constructor(private store: Store) {}
  root = el("div", { class: "center", tabindex: "0" }) as HTMLElement;
  private pivot = new PivotBar(this.store);
  private gridMount: HTMLElement | null = null;
  private tableEl: HTMLTableElement | null = null;

  render(): HTMLElement {
    this.store.subscribe(() => this.refresh());
    this.refresh();
    // keyboard handler on the root
    this.root.addEventListener("keydown", (e) => this.onKeyDown(e));
    return this.root;
  }

  // Public methods for external access (toolbar, menus)
  copyToClipboard() { this.doCopy(); }
  pasteFromClipboard() { this.doPaste(); }

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
    this.tableEl = this.buildTable();
    gridMount.appendChild(this.tableEl);
  }

  private buildTable(): HTMLTableElement {
    const v = this.store.state.activeView!;
    const table = el("table", { class: "matrix" }) as HTMLTableElement;
    const thead = table.createTHead();
    const hrow = thead.insertRow();
    const corner = el("th", { class: "corner" }, [v.rowHeaders.length ? (v.rowHeaders.join(" / ") || "Rows") : "Rows"]) as HTMLTableCellElement;
    corner.addEventListener("click", (e) => { e.preventDefault(); this.selectAll(); });
    hrow.appendChild(corner);
    for (let c = 0; c < v.colKeys.length; c++) {
      const th = el("th", { class: "colhdr" + (this.isColSelected(c) ? " selected" : "") }, [v.colHeaders[c] || `col${c}`]) as HTMLTableCellElement;
      th.addEventListener("click", (e) => { e.preventDefault(); this.selectCol(c, e.shiftKey, e.ctrlKey || e.metaKey); });
      th.addEventListener("contextmenu", (e) => { e.preventDefault(); this.showContextMenu(e, "col"); });
      th.addEventListener("dblclick", (e) => { e.preventDefault(); this.editHeader("col", c); });
      hrow.appendChild(th);
    }
    const tbody = table.createTBody();
    for (let r = 0; r < v.rowKeys.length; r++) {
      const tr = tbody.insertRow();
      if (r % 2 === 1) tr.classList.add("alt");
      const rh = el("th", { class: "rowhdr" + (this.isRowSelected(r) ? " selected" : "") }, [v.rowHeaders[r] || `row${r}`]) as HTMLTableCellElement;
      rh.addEventListener("click", (e) => { e.preventDefault(); this.selectRow(r, e.shiftKey, e.ctrlKey || e.metaKey); });
      rh.addEventListener("contextmenu", (e) => { e.preventDefault(); this.showContextMenu(e, "row"); });
      rh.addEventListener("dblclick", (e) => { e.preventDefault(); this.editHeader("row", r); });
      tr.appendChild(rh);
      for (let c = 0; c < v.colKeys.length; c++) tr.appendChild(this.cellTd(r, c));
    }
    return table;
  }

  private cellTd(r: number, c: number): HTMLElement {
    const v = this.store.state.activeView!;
    const cell = v.cells!.cells[r * v.colKeys.length + c];
    const kind = cell?.kind || "empty";
    const disp = cell?.display_value ?? "";
    const cls = ["cell", kind];
    if (kind === "text") cls.push("text");
    if (kind === "empty") cls.push("empty");
    if (kind === "error") cls.push("error");
    if (this.isCellSelected(r, c)) cls.push("selected");
    const td = el("td", { class: cls.join(" "), title: this.cellTitle(cell) }, [disp]);
    td.addEventListener("mousedown", (e) => { e.preventDefault(); this.selectCell(r, c, e.shiftKey, e.ctrlKey || e.metaKey); });
    td.addEventListener("dblclick", () => this.startEdit(r, c));
    td.addEventListener("contextmenu", (e) => { e.preventDefault(); this.showContextMenu(e, "cell"); });
    return td;
  }

  private cellTitle(cell: CellDTO | undefined): string {
    if (!cell) return "";
    const parts = [`addr: ${cell.addr.join("|")}`, `kind: ${cell.kind}`, `source: ${cell.explain?.source || "empty"}`];
    if (cell.explain?.rule_body) parts.push(`rule: ${cell.explain.rule_body}`);
    if (cell.explain?.error) parts.push(`error: ${cell.explain.error}`);
    return parts.join("\n");
  }

  // ---- Selection ----
  private isCellSelected(r: number, c: number): boolean {
    const v = this.store.state.activeView!;
    if (v.selMode === "all") return true;
    if (v.selMode === "row") return (v.selIndices as Set<number>).has(r);
    if (v.selMode === "col") return (v.selIndices as Set<number>).has(c);
    if ((v.selIndices as Set<[number, number]>).size > 0) return (v.selIndices as Set<[number, number]>).has([r, c]);
    return r === v.selectedRow && c === v.selectedCol;
  }
  private isRowSelected(r: number): boolean {
    const v = this.store.state.activeView!;
    if (v.selMode === "all") return true;
    if (v.selMode === "row") return (v.selIndices as Set<number>).has(r);
    return r === v.selectedRow;
  }
  private isColSelected(c: number): boolean {
    const v = this.store.state.activeView!;
    if (v.selMode === "all") return true;
    if (v.selMode === "col") return (v.selIndices as Set<number>).has(c);
    return c === v.selectedCol;
  }

  private selectCell(r: number, c: number, shift: boolean, ctrl: boolean) {
    const v = this.store.state.activeView!;
    if (shift) {
      const r0 = Math.min(v.anchorRow, r), r1 = Math.max(v.anchorRow, r);
      const c0 = Math.min(v.anchorCol, c), c1 = Math.max(v.anchorCol, c);
      const idx = new Set<[number, number]>();
      for (let ri = r0; ri <= r1; ri++) for (let ci = c0; ci <= c1; ci++) idx.add([ri, ci]);
      this.store.setSelectionFull(r, c, "cell", idx);
    } else if (ctrl) {
      const idx = v.selMode === "cell" ? new Set(v.selIndices as Set<[number, number]>) : new Set<[number, number]>();
      if (idx.has([r, c])) idx.delete([r, c]); else idx.add([r, c]);
      this.store.setSelectionFull(r, c, "cell", idx);
    } else {
      this.store.setSelectionFull(r, c, "cell", new Set<[number, number]>());
    }
  }

  private selectRow(r: number, shift: boolean, ctrl: boolean) {
    const v = this.store.state.activeView!;
    if (shift && v.selMode === "row") {
      const r0 = Math.min(v.anchorRow, r), r1 = Math.max(v.anchorRow, r);
      const idx = new Set<number>();
      for (let ri = r0; ri <= r1; ri++) idx.add(ri);
      this.store.setSelectionFull(r, v.selectedCol, "row", idx);
    } else if (ctrl && v.selMode === "row") {
      const idx = new Set(v.selIndices as Set<number>);
      if (idx.has(r)) idx.delete(r); else idx.add(r);
      this.store.setSelectionFull(r, v.selectedCol, "row", idx);
    } else {
      this.store.setSelectionFull(r, v.selectedCol, "row", new Set<number>([r]));
    }
  }

  private selectCol(c: number, shift: boolean, ctrl: boolean) {
    const v = this.store.state.activeView!;
    if (shift && v.selMode === "col") {
      const c0 = Math.min(v.anchorCol, c), c1 = Math.max(v.anchorCol, c);
      const idx = new Set<number>();
      for (let ci = c0; ci <= c1; ci++) idx.add(ci);
      this.store.setSelectionFull(v.selectedRow, c, "col", idx);
    } else if (ctrl && v.selMode === "col") {
      const idx = new Set(v.selIndices as Set<number>);
      if (idx.has(c)) idx.delete(c); else idx.add(c);
      this.store.setSelectionFull(v.selectedRow, c, "col", idx);
    } else {
      this.store.setSelectionFull(v.selectedRow, c, "col", new Set<number>([c]));
    }
  }

  private selectAll() {
    const v = this.store.state.activeView!;
    this.store.setSelectionFull(0, 0, "all", new Set());
  }

  // ---- Keyboard navigation ----
  private onKeyDown(e: KeyboardEvent) {
    const v = this.store.state.activeView;
    if (!v || !v.cells || v.loading) return;
    const key = e.key;
    const ctrl = e.ctrlKey || e.metaKey;
    const shift = e.shiftKey;

    // Escape: cancel edit
    if (key === "Escape") { this.cancelEdit(); return; }

    // Ignore lone modifiers
    if (["Control", "Shift", "Alt", "Meta"].includes(key)) return;

    // Ctrl+A: select all
    if (ctrl && key === "a") { e.preventDefault(); this.selectAll(); return; }

    // Shift+Space: select row
    if (shift && !ctrl && key === " ") { e.preventDefault(); this.selectRow(v.selectedRow, false, false); return; }
    // Ctrl+Space: select col
    if (ctrl && !shift && key === " ") { e.preventDefault(); this.selectCol(v.selectedCol, false, false); return; }

    // Copy
    if (ctrl && (key === "c" || key === "Insert")) { e.preventDefault(); this.doCopy(); return; }
    // Paste
    if ((ctrl && key === "v") || (shift && key === "Insert")) { e.preventDefault(); this.doPaste(); return; }
    // Delete: clear cells
    if (key === "Delete" || key === "Backspace") { e.preventDefault(); this.store.clearSelectedCells(); return; }

    // F2: start editing
    if (key === "F2") { e.preventDefault(); this.startEdit(v.selectedRow, v.selectedCol); return; }

    // Enter: start editing or commit
    if (key === "Enter" || key === "Return") {
      e.preventDefault();
      if (this.isEditing()) { this.commitEdit(); this.moveSel(1, 0); }
      else this.startEdit(v.selectedRow, v.selectedCol);
      return;
    }

    // Ctrl+Home/End: jump to top-left / bottom-right
    if (ctrl && (key === "Home" || key === "End")) {
      e.preventDefault();
      const nr = key === "Home" ? 0 : v.rowKeys.length - 1;
      const nc = key === "Home" ? 0 : v.colKeys.length - 1;
      this.store.setSelectionFull(nr, nc, "cell", new Set<[number, number]>());
      return;
    }

    // Arrow keys
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(key)) {
      e.preventDefault();
      let dr = 0, dc = 0;
      if (key === "ArrowLeft") dc = -1;
      else if (key === "ArrowRight") dc = 1;
      else if (key === "ArrowUp") dr = -1;
      else if (key === "ArrowDown") dr = 1;

      if (ctrl && shift) {
        // Ctrl+Shift+Arrow: jump to edge and extend
        const nr = dr < 0 ? 0 : dr > 0 ? v.rowKeys.length - 1 : v.selectedRow;
        const nc = dc < 0 ? 0 : dc > 0 ? v.colKeys.length - 1 : v.selectedCol;
        this.extendSelection(nr, nc);
      } else if (ctrl) {
        // Ctrl+Arrow: jump to edge
        const nr = dr < 0 ? 0 : dr > 0 ? v.rowKeys.length - 1 : v.selectedRow;
        const nc = dc < 0 ? 0 : dc > 0 ? v.colKeys.length - 1 : v.selectedCol;
        this.store.setSelectionFull(nr, nc, "cell", new Set<[number, number]>());
      } else if (shift) {
        // Shift+Arrow: extend selection
        this.extendSelection(v.selectedRow + dr, v.selectedCol + dc);
      } else {
        // Plain arrow: move selection
        this.moveSel(dr, dc);
      }
      return;
    }

    // Printable char: start editing with that char
    if (key.length === 1 && !ctrl && !shift && !e.altKey) {
      e.preventDefault();
      this.startEdit(v.selectedRow, v.selectedCol, key);
      return;
    }
  }

  private moveSel(dr: number, dc: number) {
    const v = this.store.state.activeView!;
    const nr = Math.max(0, Math.min(v.rowKeys.length - 1, v.selectedRow + dr));
    const nc = Math.max(0, Math.min(v.colKeys.length - 1, v.selectedCol + dc));
    this.store.setSelectionFull(nr, nc, "cell", new Set<[number, number]>());
  }

  private extendSelection(r: number, c: number) {
    const v = this.store.state.activeView!;
    const nr = Math.max(0, Math.min(v.rowKeys.length - 1, r));
    const nc = Math.max(0, Math.min(v.colKeys.length - 1, c));
    const r0 = Math.min(v.anchorRow, nr), r1 = Math.max(v.anchorRow, nr);
    const c0 = Math.min(v.anchorCol, nc), c1 = Math.max(v.anchorCol, nc);
    const idx = new Set<[number, number]>();
    for (let ri = r0; ri <= r1; ri++) for (let ci = c0; ci <= c1; ci++) idx.add([ri, ci]);
    this.store.setSelectionFull(nr, nc, "cell", idx);
  }

  // ---- Cell editing ----
  private editor: HTMLInputElement | null = null;

  private isEditing(): boolean { return this.editor !== null && this.editor !== undefined; }

  private startEdit(r: number, c: number, initialChar?: string) {
    if (this.editor) this.commitEdit();
    const v = this.store.state.activeView;
    if (!v || !v.cells || r < 0 || c < 0 || r >= v.rowKeys.length || c >= v.colKeys.length) return;
    const cell = v.cells.cells[r * v.colKeys.length + c];
    const curVal = cell?.display_value ?? (cell?.value != null ? String(cell.value) : "");
    const td = this.tableEl?.rows[r + 1]?.cells[c + 1] as HTMLTableCellElement;
    if (!td) return;
    const input = document.createElement("input") as HTMLInputElement;
    input.type = "text";
    input.value = initialChar !== undefined ? initialChar : curVal;
    input.className = "cell-editor";
    const rect = td.getBoundingClientRect();
    input.style.position = "fixed";
    input.style.left = rect.left + "px";
    input.style.top = rect.top + "px";
    input.style.width = rect.width + "px";
    input.style.height = rect.height + "px";
    input.style.zIndex = "1000";
    document.body.appendChild(input);
    input.focus();
    if (initialChar === undefined) input.select();
    else input.setSelectionRange(input.value.length, input.value.length);
    this.editor = input;
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === "Return") { e.preventDefault(); this.commitEdit(); this.moveSel(1, 0); }
      else if (e.key === "Escape") { e.preventDefault(); this.cancelEdit(); }
      else if (e.key === "Tab") { e.preventDefault(); this.commitEdit(); this.moveSel(0, e.shiftKey ? -1 : 1); }
      else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key) && !e.shiftKey && !e.ctrlKey) {
        // commit on arrow and navigate
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
    if (!this.editor) return;
    const input = this.editor;
    this.editor = null;
    const v = this.store.state.activeView;
    if (!v) { input.remove(); return; }
    const text = input.value;
    input.remove();
    if (text === "") return;
    this.store.applyInput(text, { row: v.selectedRow, col: v.selectedCol });
  }

  private cancelEdit() {
    if (this.editor) { this.editor.remove(); this.editor = null; }
  }

  // ---- Header editing ----
  private editHeader(axis: "row" | "col", index: number) {
    const v = this.store.state.activeView;
    if (!v) return;
    const dimIds = axis === "row" ? v.rowDimIds : v.colDimIds;
    if (dimIds.length !== 1) { alert("Header rename requires exactly one dimension on this axis."); return; }
    const dimId = dimIds[0];
    const items = this.store.dimItems(dimId);
    const key = axis === "row" ? v.rowKeys[index] : v.colKeys[index];
    const itemId = key[0];
    const item = items.find((it) => it.id === itemId);
    if (!item) return;
    const newName = prompt(`Rename ${axis} item:`, item.name);
    if (!newName || newName === item.name) return;
    this.store.api.renameDimensionItem(dimId, itemId, newName).then(() => {
      this.store.markDirty();
      this.store.loadView(v.viewId);
      this.store.refreshModel();
    }).catch((e) => alert("Rename failed: " + (e?.message || e)));
  }

  // ---- Copy/Paste ----
  private async doCopy() {
    const text = await this.store.copySelectionToClipboard();
    if (text) { try { await navigator.clipboard.writeText(text); } catch { const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove(); } }
  }

  private async doPaste() {
    let text = "";
    try { text = await navigator.clipboard.readText(); } catch { text = prompt("Paste TSV data:") || ""; }
    if (text) this.store.pasteFromClipboard(text);
  }

  // ---- Context menu ----
  private showContextMenu(e: MouseEvent, axis: "row" | "col" | "cell") {
    const existing = document.querySelector(".ctx-menu");
    if (existing) existing.remove();
    const menu = el("div", { class: "ctx-menu" });
    const v = this.store.state.activeView;
    if (!v) return;

    const addItem = (label: string, fn: () => void, enabled = true) => {
      const item = el("div", { class: "ctx-item" + (enabled ? "" : " disabled") }, [label]);
      if (enabled) item.addEventListener("click", () => { menu.remove(); fn(); });
      menu.appendChild(item);
    };
    const addSep = () => menu.appendChild(el("div", { class: "ctx-sep" }));

    if (axis === "cell") {
      addItem("Edit Cell", () => this.startEdit(v.selectedRow, v.selectedCol));
      addItem("Clear Override", () => this.store.clearSelectedCells());
      addItem("Set Rule…", () => {
        const text = prompt(`Set Value or Rule (${SET_RULE_PLACEHOLDER}):`);
        if (text) this.store.applyInput(text);
      });
      addSep();
      addItem("Copy", () => this.doCopy());
      addItem("Paste", () => this.doPaste());
      addSep();
      const subRow = el("div", { class: "ctx-item" }, ["Row ▸"]);
      const subCol = el("div", { class: "ctx-item" }, ["Column ▸"]);
      menu.appendChild(subRow);
      menu.appendChild(subCol);
    }

    if (axis === "row" || axis === "col") {
      const dimIds = axis === "row" ? v.rowDimIds : v.colDimIds;
      if (dimIds.length === 1) {
        const dimId = dimIds[0];
        addItem("Add Item…", () => {
          const name = prompt("New item name:");
          if (name) this.store.api.createDimensionItem(dimId, name).then(() => { this.store.markDirty(); this.store.loadView(v.viewId); this.store.refreshModel(); });
        });
        addItem("Rename Item…", () => {
          const sel = axis === "row" ? v.selectedRow : v.selectedCol;
          const key = axis === "row" ? v.rowKeys[sel] : v.colKeys[sel];
          const items = this.store.dimItems(dimId);
          const item = items.find((it) => it.id === key[0]);
          if (item) {
            const newName = prompt("New name:", item.name);
            if (newName) this.store.api.renameDimensionItem(dimId, item.id, newName).then(() => { this.store.markDirty(); this.store.loadView(v.viewId); this.store.refreshModel(); });
          }
        });
        addItem("Delete Item…", () => {
          const sel = axis === "row" ? v.selectedRow : v.selectedCol;
          const key = axis === "row" ? v.rowKeys[sel] : v.colKeys[sel];
          if (confirm("Delete this item?")) this.store.api.deleteDimensionItems(dimId, [key[0]]).then(() => { this.store.markDirty(); this.store.loadView(v.viewId); this.store.refreshModel(); });
        });
        addSep();
        addItem("Add Group…", () => {
          const name = prompt("Group name:");
          if (name) this.store.api.createGroup(dimId, name).then(() => { this.store.markDirty(); this.store.loadView(v.viewId); this.store.refreshModel(); });
        });
      }
    }

    menu.style.left = e.clientX + "px";
    menu.style.top = e.clientY + "px";
    document.body.appendChild(menu);
    const close = (ev: MouseEvent) => { if (!menu.contains(ev.target as Node)) { menu.remove(); document.removeEventListener("click", close); } };
    setTimeout(() => document.addEventListener("click", close), 0);
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
