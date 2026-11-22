import { Store } from "../state";
import { el, clear } from "../dom";
import { seqLinkIcon, kindIcon, kindIconSvg, materialIconSvg, KindIcon } from "../menuIcons";
import { BrowserNode } from "../api";
import { inputDialog, alertDialog, confirmDialog } from "./dialogs";
import { ModelActions } from "./modelActions";

/** ModelBrowser — left dock with tree: Dimensions, Cubes, Views.
 *  Mirrors lib_gui/model_browser.py with context menus and drag-to-view. */
export class ModelBrowser {
  private actions: ModelActions;
  /** Where the last right click happened; the context menu opens there (issue #4). */
  private menuPos = { x: 0, y: 0 };
  constructor(private store: Store) { this.actions = new ModelActions(store); }

  render(): HTMLElement {
    const panel = el("div", { class: "dock" });
    const header = el("div", { class: "dock-header" }, ["Model Browser"]);
    panel.appendChild(header);
    const content = el("div", { class: "dock-content" });
    const tree = el("div", { class: "tree" });
    content.appendChild(tree);
    panel.appendChild(content);

    // Flat/Tree layout toggle — only when the engine persists browser_tree.
    if (this.store.browserTreeSupported()) {
      const seg = el("span", { class: "bt-seg" });
      const flatBtn = el("button", { class: "bt-seg-btn", title: "Flat — sorted element list" }, ["Flat"]);
      const treeBtn = el("button", { class: "bt-seg-btn", title: "Tree — folders and custom order" }, ["Tree"]);
      flatBtn.addEventListener("click", () => this.setBrowserMode("flat"));
      treeBtn.addEventListener("click", () => this.setBrowserMode("tree"));
      seg.append(flatBtn, treeBtn);
      header.appendChild(seg);
      this.segBtns = { flat: flatBtn, tree: treeBtn };
    }

    // Right-click on empty space in Tree mode → root menu (rows stopPropagation).
    tree.addEventListener("contextmenu", (e) => {
      if (this.store.browserMode() !== "tree" || !this.store.browserTreeSupported()) return;
      e.preventDefault();
      this.menuPos = { x: e.clientX, y: e.clientY };
      this.treeRootMenu();
    });
    // Drop on empty space appends to the root list.
    tree.addEventListener("dragover", (e) => {
      if (!this.drag) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    });
    tree.addEventListener("drop", (e) => {
      const drag = this.drag;
      if (!drag) return;
      e.preventDefault();
      const root = this.treeArr();
      if (drag.parentArr === root && drag.index === root.length - 1) return;
      const moved = drag.node;
      drag.parentArr.splice(drag.index, 1);
      root.push(moved);
      this.dragging = false;
      this.drag = null;
      void this.store.pushBrowserTree({ mode: "tree", tree: root });
    });

    this.store.subscribe(() => { if (!this.dragging) this.refresh(tree); });
    this.refresh(tree);
    return panel;
  }

  /** Alphabetical within each group; `@` (technical channel dim) pinned first.
   *  numeric: "Col 2" < "Col 10"; base: case-insensitive. */
  private static byName = (a: { name: string }, b: { name: string }) =>
    a.name === "@" ? -1 : b.name === "@" ? 1 :
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });

  private segBtns?: { flat: HTMLElement; tree: HTMLElement };
  private dragging = false;
  private drag: { parentArr: BrowserNode[]; index: number; node: BrowserNode } | null = null;

  private refresh(tree: HTMLElement) {
    if (this.segBtns) {
      const m = this.store.browserMode();
      this.segBtns.flat.setAttribute("aria-pressed", String(m === "flat"));
      this.segBtns.tree.setAttribute("aria-pressed", String(m === "tree"));
    }
    clear(tree);
    if (this.store.browserMode() === "tree" && this.store.browserTreeSupported()) {
      this.renderTreeView(tree);
      return;
    }
    // Dimensions root
    const dimRoot = this.makeTreeNode("Dimensions", kindIcon("dimension"), true, () => this.dimRootMenu());
    const dimChildren = (dimRoot as any)._children as HTMLElement;
    for (const dim of [...this.store.visibleDims()].sort(ModelBrowser.byName)) {
      const node = this.makeTreeNode(`${dim.name} (${dim.items})`, kindIcon("dimension"), false, () => this.dimMenu(dim));
      // Sequential dimension: the same link mark as its pivot chip (issue #2; was "→").
      if (this.store.dimIsSeq(dim.id)) node.querySelector(".tree-label .tree-count")?.before(seqLinkIcon());
      dimChildren.appendChild(node);
    }
    tree.appendChild(dimRoot);

    // Cubes root
    const cubeRoot = this.makeTreeNode("Cubes", kindIcon("cube"), true, () => this.cubeRootMenu());
    const cubeChildren = (cubeRoot as any)._children as HTMLElement;
    for (const cube of [...this.store.visibleCubes()].sort(ModelBrowser.byName)) {
      cubeChildren.appendChild(this.makeTreeNode(`${cube.name} (${cube.dimensions})`, kindIcon("cube"), false, () => this.cubeMenu(cube)));
    }
    tree.appendChild(cubeRoot);

    // Views root
    const viewRoot = this.makeTreeNode("Views", kindIcon("view"), true, () => this.viewRootMenu());
    const viewChildren = (viewRoot as any)._children as HTMLElement;
    for (const view of [...this.store.visibleViews()].sort(ModelBrowser.byName)) {
      const viewNode = this.makeTreeNode(view.name, kindIcon("view"), false, () => this.viewMenu(view));
      // The view shown in the active tab gets a soft highlight (T-039 stage 3).
      if (this.store.state.activeView?.viewId === view.id) viewNode.querySelector(".tree-row")?.classList.add("active");
      viewNode.addEventListener("click", () => this.store.openView(view.id, view.name));
      viewChildren.appendChild(viewNode);
    }
    tree.appendChild(viewRoot);
  }

  private makeTreeNode(label: string, icon: string | HTMLElement, expandable: boolean, onContext?: () => void): HTMLElement {
    const node = el("div", { class: "tree-node" });
    const row = el("div", { class: "tree-row" });
    const toggle = expandable ? el("span", { class: "tree-twisty" }, ["▸"]) : el("span", { class: "tree-twisty" }, [""]);
    const iconEl = el("span", { class: "tree-icon" }, [icon]);
    const text = el("span", { class: "tree-label" }, [label]);
    // "Month (3)" → the count is its own muted, right-aligned element; the label's textContent stays "Month (3)".
    const counted = /^(.*\S) (\(\d+\))$/.exec(label);
    if (counted) { clear(text); text.append(counted[1], " ", el("span", { class: "tree-count" }, [counted[2]])); }
    row.appendChild(toggle);
    row.appendChild(iconEl);
    row.appendChild(text);
    node.appendChild(row);
    if (expandable) {
      const children = el("div", { class: "tree-children", style: { display: "block" } });
      node.appendChild(children);
      const toggleFn = () => {
        const expanded = (children as HTMLElement).style.display !== "none";
        (children as HTMLElement).style.display = expanded ? "none" : "block";
        toggle.textContent = expanded ? "▸" : "▾";
      };
      toggle.textContent = "▾";
      toggle.addEventListener("click", (e) => { e.stopPropagation(); toggleFn(); });
      text.addEventListener("click", () => toggleFn());
      (node as any)._children = children;
    }
    if (onContext) row.addEventListener("contextmenu", (e) => {
      e.preventDefault(); e.stopPropagation();
      this.menuPos = { x: e.clientX, y: e.clientY };
      onContext();
    });
    return node;
  }

  // ---- Context menus ----
  // Create / delete go through ModelActions (same dialogs as the Model menu); rename stays here.
  private async rename(title: string, current: string, run: (n: string) => Promise<unknown>) {
    const n = await inputDialog(title, current, "New name");
    if (!n || !n.trim() || n.trim() === current) return;
    try { await run(n.trim()); } catch (e: any) { await alertDialog(title, e?.message || String(e)); return; }
    await this.store.afterStructureChange();
  }

  private dimRootMenu() {
    this.popup([{ label: "New Dimension…", fn: () => this.actions.newDimension() }]);
  }

  private dimMenu(dim: any) {
    this.popup([
      { label: `Add item to '${dim.name}'…`, fn: () => this.actions.newDimensionItem(dim.id) },
      { label: `Rename dimension '${dim.name}'…`, fn: () => this.rename("Rename Dimension", dim.name, (n) => this.store.api.renameDimension(dim.id, n)) },
      { label: `Delete dimension '${dim.name}'…`, fn: () => this.actions.deleteDimension(dim.id) },
    ]);
  }

  private cubeRootMenu() {
    this.popup([{ label: "New Cube…", fn: () => this.actions.newCube() }]);
  }

  private cubeMenu(cube: any) {
    this.popup([
      { label: `New view of '${cube.name}'…`, fn: () => this.actions.newView(cube.id) },
      { label: `Rename cube '${cube.name}'…`, fn: () => this.rename("Rename Cube", cube.name, (n) => this.store.api.renameCube(cube.id, n)) },
      { label: `Delete cube '${cube.name}'…`, fn: () => this.actions.deleteCube(cube.id) },
    ]);
  }

  private viewRootMenu() {
    this.popup([{ label: "New View…", fn: () => this.actions.newView() }]);
  }

  private viewMenu(view: any) {
    this.popup([
      { label: `Rename view '${view.name}'…`, fn: () => this.rename("Rename View", view.name, (n) => this.store.api.renameView(view.id, n)) },
      { label: `Delete view '${view.name}'…`, fn: () => this.actions.deleteView(view.id) },
    ]);
  }

  private popup(items: { label: string; fn: () => void }[]) {
    const existing = document.querySelector(".ctx-menu");
    if (existing) existing.remove();
    const menu = el("div", { class: "ctx-menu" });
    for (const it of items) {
      const item = el("div", { class: "ctx-item" }, [it.label]);
      item.addEventListener("click", () => { menu.remove(); it.fn(); });
      menu.appendChild(item);
    }
    document.body.appendChild(menu);
    menu.style.left = this.menuPos.x + "px";
    menu.style.top = this.menuPos.y + "px";
    const close = (e: MouseEvent) => { if (!menu.contains(e.target as Node)) { menu.remove(); document.removeEventListener("click", close); } };
    setTimeout(() => document.addEventListener("click", close), 0);
  }

  // ---- Tree view (persisted layout) ----

  private treeArr(): BrowserNode[] {
    const bt = this.store.browserTree();
    return Array.isArray(bt?.tree) ? bt.tree : [];
  }

  private setBrowserMode(mode: "flat" | "tree") {
    const bt = this.store.browserTree();
    // First switch to Tree: seed a layout mirroring Flat's three sections.
    const tree = bt?.tree ?? this.defaultTree();
    void this.store.pushBrowserTree({ ...bt, mode, tree });
  }

  private defaultTree(): BrowserNode[] {
    const sort = <T extends { name: string }>(l: T[]) => [...l].sort(ModelBrowser.byName);
    return [
      { name: "Dimensions", children: sort(this.store.visibleDims()).map((d) => `dim:${d.id}`) },
      { name: "Cubes", children: sort(this.store.visibleCubes()).map((c) => `cube:${c.id}`) },
      { name: "Views", children: sort(this.store.visibleViews()).map((v) => `view:${v.id}`) },
    ];
  }

  /** `kind:id` → display info; null when the element no longer exists. */
  private leafOf(ref: string): { kind: KindIcon; id: string; label: string } | null {
    const i = ref.indexOf(":");
    const kind = ref.slice(0, i), id = ref.slice(i + 1);
    const st = this.store.state;
    if (kind === "dim") { const d = st.dimensions.find((x) => x.id === id); return d ? { kind: "dimension", id, label: `${d.name} (${d.items})` } : null; }
    if (kind === "cube") { const c = st.cubes.find((x) => x.id === id); return c ? { kind, id, label: `${c.name} (${c.dimensions})` } : null; }
    if (kind === "view") { const v = st.views.find((x) => x.id === id); return v ? { kind, id, label: v.name } : null; }
    return null;
  }

  private renderTreeView(tree: HTMLElement) {
    const render = (nodes: BrowserNode[], parentArr: BrowserNode[], container: HTMLElement) => {
      nodes.forEach((n, index) => {
        if (typeof n === "string") {
          const leaf = this.leafOf(n);
          if (!leaf) return;
          const node = this.makeTreeNode(leaf.label, kindIconSvg(leaf.kind), false,
            () => this.treeLeafMenu(n, leaf));
          if (leaf.kind === "view") {
            if (this.store.state.activeView?.viewId === leaf.id) node.querySelector(".tree-row")?.classList.add("active");
            node.addEventListener("click", () => this.store.openView(leaf.id, leaf.label));
          }
          this.wireDnd(node, parentArr, index);
          container.appendChild(node);
        } else {
          const node = this.makeFolderNode(n.name, () => this.folderMenu(n, parentArr, index));
          this.wireDnd(node, parentArr, index);
          container.appendChild(node);
          render(n.children ?? [], n.children ?? (n.children = []), (node as any)._children);
        }
      });
    };
    render(this.treeArr(), this.treeArr(), tree);
  }

  private makeFolderNode(name: string, onContext?: () => void): HTMLElement {
    const icon = el("span", { html: materialIconSvg("folder_open", 14) });
    return this.makeTreeNode(name, icon, true, onContext);
  }

  /** drag-and-drop: move leaves/folders between parents and reorder within them. */
  private wireDnd(node: HTMLElement, parentArr: BrowserNode[], index: number) {
    const row = node.querySelector(".tree-row") as HTMLElement;
    const dragged = parentArr[index];
    row.draggable = true;
    row.addEventListener("dragstart", (e) => {
      this.dragging = true;
      this.drag = { parentArr, index, node: dragged };
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    });
    row.addEventListener("dragend", () => {
      this.dragging = false;
      this.drag = null;
      row.parentElement?.parentElement?.querySelectorAll(".tree-row")
        .forEach((r) => r.classList.remove("drop-before", "drop-after", "drop-into"));
      this.store.notify();
    });
    row.addEventListener("dragover", (e) => {
      if (!this.drag) return;
      e.stopPropagation();
      const r = row.getBoundingClientRect();
      const isFolder = typeof dragged !== "string";
      const zone = isFolder
        ? e.clientY < r.top + r.height * 0.3 ? "before" : e.clientY > r.bottom - r.height * 0.3 ? "after" : "into"
        : e.clientY < r.top + r.height / 2 ? "before" : "after";
      // Can't drop a folder into/around its own subtree — the node carries
      // that array, so any target inside it would make a cycle. No
      // preventDefault here: drop stays disallowed at this row.
      const d = this.drag.node;
      if (typeof d !== "string" &&
          (zone === "into" ? this.nodeContains(d, dragged) : this.arrInNode(d, parentArr))) {
        row.classList.remove("drop-before", "drop-after", "drop-into");
        delete row.dataset.dropZone;
        return;
      }
      e.preventDefault();
      row.classList.remove("drop-before", "drop-after", "drop-into");
      row.classList.add(`drop-${zone}`);
      row.dataset.dropZone = zone;
    });
    row.addEventListener("dragleave", () => {
      row.classList.remove("drop-before", "drop-after", "drop-into");
      delete row.dataset.dropZone;
    });
    row.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      row.classList.remove("drop-before", "drop-after", "drop-into");
      const drag = this.drag;
      const zone = row.dataset.dropZone;
      delete row.dataset.dropZone;
      if (!drag || !zone) return;
      // Same-array reorder: removing shifts the target index down.
      let at = index + (zone === "after" ? 1 : 0);
      const sameArr = drag.parentArr === parentArr;
      const moved = drag.node;
      drag.parentArr.splice(drag.index, 1);
      if (sameArr && drag.index < at) at--;
      if (zone === "into" && typeof dragged !== "string") (dragged.children ??= []).push(moved);
      else parentArr.splice(at, 0, moved);
      this.dragging = false;
      this.drag = null;
      void this.store.pushBrowserTree({ mode: "tree", tree: this.treeArr() });
    });
  }

  private nodeContains(folder: { name: string; children: BrowserNode[] }, target: BrowserNode): boolean {
    if (target === folder) return true;
    for (const c of folder.children ?? [])
      if (typeof c !== "string" && this.nodeContains(c, target)) return true;
    return false;
  }

  /** Is `arr` the children array of `node` or of one of its descendant folders? */
  private arrInNode(node: BrowserNode, arr: BrowserNode[]): boolean {
    if (typeof node === "string") return false;
    if (node.children === arr) return true;
    for (const c of node.children ?? []) if (this.arrInNode(c, arr)) return true;
    return false;
  }

  // ---- Tree-view menus ----

  private treeRootMenu() {
    this.popup([
      { label: "New Folder…", fn: () => this.folderName("New Folder", (n) => {
        this.treeArr().push({ name: n, children: [] });
        void this.store.pushBrowserTree({ mode: "tree", tree: this.treeArr() });
      }) },
      { label: "Sort A–Z", fn: async () => {
        // Root sort = flatten: gather every leaf, alphabetical, folders gone (the reset).
        const ok = await confirmDialog("Sort A–Z", "Sort all elements alphabetically? This removes all folders.", "Sort", true);
        if (!ok) return;
        const leaves: BrowserNode[] = [];
        const walk = (nodes: BrowserNode[]) => { for (const n of nodes) typeof n === "string" ? leaves.push(n) : walk(n.children ?? []); };
        walk(this.treeArr());
        leaves.sort((a, b) => (this.leafOf(a as string)?.label ?? a as string).localeCompare(this.leafOf(b as string)?.label ?? b as string, undefined, { numeric: true, sensitivity: "base" }));
        void this.store.pushBrowserTree({ mode: "tree", tree: leaves });
      } },
    ]);
  }

  private folderMenu(folder: { name: string; children: BrowserNode[] }, parentArr: BrowserNode[], index: number) {
    this.popup([
      { label: `New Folder in '${folder.name}'…`, fn: () => this.folderName("New Folder", (n) => {
        (folder.children ??= []).push({ name: n, children: [] });
        void this.store.pushBrowserTree({ mode: "tree", tree: this.treeArr() });
      }) },
      { label: `Rename '${folder.name}'…`, fn: () => this.folderName("Rename Folder", (n) => {
        folder.name = n;
        void this.store.pushBrowserTree({ mode: "tree", tree: this.treeArr() });
      }) },
      { label: "Sort A–Z", fn: () => {
        folder.children?.sort((a, b) => this.nodeName(a).localeCompare(this.nodeName(b), undefined, { numeric: true, sensitivity: "base" }));
        void this.store.pushBrowserTree({ mode: "tree", tree: this.treeArr() });
      } },
      { label: `Delete '${folder.name}'`, fn: () => {
        // Children promote into the parent at the folder's slot.
        parentArr.splice(index, 1, ...(folder.children ?? []));
        void this.store.pushBrowserTree({ mode: "tree", tree: this.treeArr() });
      } },
    ]);
  }

  private nodeName(n: BrowserNode): string {
    return typeof n === "string" ? (this.leafOf(n)?.label ?? n) : n.name;
  }

  private treeLeafMenu(ref: string, leaf: { kind: KindIcon; id: string; label: string }) {
    if (leaf.kind === "dimension") {
      const dim = this.store.state.dimensions.find((d) => d.id === leaf.id);
      if (dim) this.dimMenu(dim);
    } else if (leaf.kind === "cube") {
      const cube = this.store.state.cubes.find((c) => c.id === leaf.id);
      if (cube) this.cubeMenu(cube);
    } else {
      const view = this.store.state.views.find((v) => v.id === leaf.id);
      if (view) this.viewMenu(view);
    }
  }

  private async folderName(title: string, fn: (name: string) => void) {
    const n = await inputDialog(title, "", "Folder name");
    if (!n || !n.trim()) return;
    fn(n.trim());
  }
}
