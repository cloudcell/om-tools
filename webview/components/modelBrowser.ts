import { Store } from "../state";
import { el, clear } from "../dom";
import { inputDialog, confirmDialog, alertDialog, pickDialog } from "./dialogs";

/** ModelBrowser — left dock with tree: Dimensions, Cubes, Views.
 *  Mirrors lib_gui/model_browser.py with context menus and drag-to-view. */
export class ModelBrowser {
  constructor(private store: Store) {}

  render(): HTMLElement {
    const panel = el("div", { class: "dock" });
    panel.appendChild(el("div", { class: "dock-header" }, ["Model Browser"]));
    const content = el("div", { class: "dock-content" });
    const tree = el("div", { class: "tree" });
    content.appendChild(tree);
    panel.appendChild(content);

    this.store.subscribe(() => this.refresh(tree));
    this.refresh(tree);
    return panel;
  }

  private refresh(tree: HTMLElement) {
    clear(tree);
    // Dimensions root
    const dimRoot = this.makeTreeNode("Dimensions", "▦", true, () => this.dimRootMenu());
    const dimChildren = (dimRoot as any)._children as HTMLElement;
    for (const dim of this.store.visibleDims()) {
      const seqMark = this.store.dimIsSeq(dim.id) ? " →" : "";
      dimChildren.appendChild(this.makeTreeNode(`${dim.name}${seqMark} (${dim.items})`, "·", false, () => this.dimMenu(dim)));
    }
    tree.appendChild(dimRoot);

    // Cubes root
    const cubeRoot = this.makeTreeNode("Cubes", "◼", true, () => this.cubeRootMenu());
    const cubeChildren = (cubeRoot as any)._children as HTMLElement;
    for (const cube of this.store.visibleCubes()) {
      cubeChildren.appendChild(this.makeTreeNode(`${cube.name} (${cube.dimensions})`, "·", false, () => this.cubeMenu(cube)));
    }
    tree.appendChild(cubeRoot);

    // Views root
    const viewRoot = this.makeTreeNode("Views", "▲", true, () => this.viewRootMenu());
    const viewChildren = (viewRoot as any)._children as HTMLElement;
    for (const view of this.store.visibleViews()) {
      const viewNode = this.makeTreeNode(view.name, "·", false, () => this.viewMenu(view));
      viewNode.addEventListener("click", () => this.store.openView(view.id, view.name));
      viewChildren.appendChild(viewNode);
    }
    tree.appendChild(viewRoot);
  }

  private makeTreeNode(label: string, icon: string, expandable: boolean, onContext?: () => void): HTMLElement {
    const node = el("div", { class: "tree-node" });
    const row = el("div", { class: "tree-row" });
    const toggle = expandable ? el("span", { class: "tree-twisty" }, ["▸"]) : el("span", { class: "tree-twisty" }, [""]);
    const iconEl = el("span", { class: "tree-icon" }, [icon]);
    const text = el("span", { class: "tree-label" }, [label]);
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
    if (onContext) row.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); onContext(); });
    return node;
  }

  // ---- Context menus ----
  private dimRootMenu() {
    this.popup([
      { label: "New Dimension…", fn: async () => {
        const name = await inputDialog("New Dimension", "", "Dimension name");
        if (!name || !name.trim()) return;
        const isSeq = await confirmDialog("Dimension Type", "Sequential (ordered) dimension?", "Sequential", false);
        const type = isSeq ? "seq" : "set";
        this.store.api.createDimension(name.trim(), type).then(() => { this.store.markDirty(); this.store.refreshModel(); });
      }},
    ]);
  }

  private dimMenu(dim: any) {
    this.popup([
      { label: `Add item to '${dim.name}'…`, fn: async () => {
        const name = await inputDialog("Add Item", "", "Item name");
        if (name && name.trim()) this.store.api.createDimensionItem(dim.id, name.trim()).then(() => { this.store.markDirty(); this.store.invalidateDimCache(dim.id); this.store.refreshModel(); if (this.store.state.activeView) this.store.loadView(this.store.state.activeView.viewId); });
      }},
      { label: `Rename dimension '${dim.name}'…`, fn: async () => {
        const newName = await inputDialog("Rename Dimension", dim.name, "New name");
        if (newName && newName.trim()) this.store.api.renameDimension(dim.id, newName.trim()).then(() => { this.store.markDirty(); this.store.invalidateDimCache(dim.id); this.store.refreshModel(); if (this.store.state.activeView) this.store.loadView(this.store.state.activeView.viewId); });
      }},
      { label: `Delete dimension '${dim.name}'…`, fn: async () => {
        if (await confirmDialog("Delete Dimension", `Delete dimension "${dim.name}"?`, "Delete", true)) this.store.api.deleteDimension(dim.id).then(() => { this.store.markDirty(); this.store.invalidateDimCache(dim.id); this.store.refreshModel(); });
      }},
    ]);
  }

  private cubeRootMenu() {
    this.popup([
      { label: "New Cube…", fn: async () => {
        const name = await inputDialog("New Cube", "", "Cube name");
        if (!name || !name.trim()) return;
        const dims = this.store.visibleDims().filter((d) => d.name !== "@");
        const ids = dims.map((d) => d.id);
        this.store.api.createCube(name.trim(), ids).then(() => { this.store.markDirty(); this.store.refreshModel(); });
      }},
    ]);
  }

  private cubeMenu(cube: any) {
    this.popup([
      { label: `Rename cube '${cube.name}'…`, fn: async () => {
        const newName = await inputDialog("Rename Cube", cube.name, "New name");
        if (newName && newName.trim()) this.store.api.renameCube(cube.id, newName.trim()).then(() => { this.store.markDirty(); this.store.refreshModel(); });
      }},
      { label: `Delete cube '${cube.name}'…`, fn: async () => {
        if (await confirmDialog("Delete Cube", `Delete cube "${cube.name}"?`, "Delete", true)) this.store.api.deleteCube(cube.id).then(() => { this.store.markDirty(); this.store.refreshModel(); });
      }},
    ]);
  }

  private viewRootMenu() {
    this.popup([
      { label: "New View…", fn: async () => {
        const cubes = this.store.visibleCubes();
        if (!cubes.length) { await alertDialog("No Cubes", "No cubes available."); return; }
        const cubeName = await pickDialog("Cube", cubes.map((c) => c.name));
        if (!cubeName) return;
        const cube = cubes.find((c) => c.name === cubeName.trim());
        if (!cube) return;
        const name = await inputDialog("View Name", "", "View name");
        if (!name || !name.trim()) return;
        const dims = this.store.visibleDims().filter((d) => d.name !== "@");
        const dimNames = dims.map((d) => d.name);
        const rowName = await inputDialog("Row Dimensions", dimNames.join(", "), "Comma-separated dimension names");
        const colName = await inputDialog("Column Dimensions", dimNames.join(", "), "Comma-separated dimension names");
        const rowDims = rowName?.split(",").map((s) => dims.find((d) => d.name === s.trim())?.id).filter(Boolean) as string[] || [];
        const colDims = colName?.split(",").map((s) => dims.find((d) => d.name === s.trim())?.id).filter(Boolean) as string[] || [];
        this.store.api.createView(name.trim(), cube.id, rowDims, colDims).then(() => { this.store.markDirty(); this.store.refreshModel(); });
      }},
    ]);
  }

  private viewMenu(view: any) {
    this.popup([
      { label: `Rename view '${view.name}'…`, fn: async () => {
        const newName = await inputDialog("Rename View", view.name, "New name");
        if (newName && newName.trim()) this.store.api.renameView(view.id, newName.trim()).then(() => { this.store.markDirty(); this.store.refreshModel(); });
      }},
      { label: `Delete view '${view.name}'…`, fn: async () => {
        if (this.store.state.views.length <= 1) { await alertDialog("Cannot Delete", "Cannot delete the last view."); return; }
        if (await confirmDialog("Delete View", `Delete view "${view.name}"?`, "Delete", true)) this.store.api.deleteView(view.id).then(() => { this.store.markDirty(); this.store.refreshModel(); });
      }},
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
    menu.style.left = "20px";
    menu.style.top = "100px";
    const close = (e: MouseEvent) => { if (!menu.contains(e.target as Node)) { menu.remove(); document.removeEventListener("click", close); } };
    setTimeout(() => document.addEventListener("click", close), 0);
  }
}
