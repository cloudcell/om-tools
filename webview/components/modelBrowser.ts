import { Store } from "../state";
import { el, clear } from "../dom";
import { seqLinkIcon, kindIcon } from "../menuIcons";
import { inputDialog, alertDialog, confirmDialog } from "./dialogs";
import { ModelActions } from "./modelActions";

/** ModelBrowser — left dock with tree: Dimensions, Cubes, Views.
 *  Mirrors lib_gui/model_browser.py with context menus and drag-to-view. */
export class ModelBrowser {
  private actions: ModelActions;
  /** Cubes whose `cube_detail` is loading for the dim children (fetched once per cube). */
  private loadingCubeDims = new Set<string>();
  /** Cube expansion survives refresh() rebuilds — collapsed is the default. */
  private expandedCubes = new Set<string>();
  /** Where the last right click happened; the context menu opens there (issue #4). */
  private menuPos = { x: 0, y: 0 };
  constructor(private store: Store) { this.actions = new ModelActions(store); }

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

  /** Alphabetical within each group; `@` (technical channel dim) pinned first.
   *  numeric: "Col 2" < "Col 10"; base: case-insensitive. */
  private static byName = (a: { name: string }, b: { name: string }) =>
    a.name === "@" ? -1 : b.name === "@" ? 1 :
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });

  private refresh(tree: HTMLElement) {
    clear(tree);
    // Dimensions root — data-tour anchors the guided tour's concept step.
    const dimRoot = this.makeTreeNode("Dimensions", kindIcon("dimension"), true, () => this.dimRootMenu());
    (dimRoot.querySelector(".tree-row") as HTMLElement).dataset.tour = "dims";
    const dimChildren = (dimRoot as any)._children as HTMLElement;
    for (const dim of [...this.store.visibleDims()].sort(ModelBrowser.byName)) {
      const node = this.makeTreeNode(`${dim.name} (${dim.items})`, kindIcon("dimension"), false, () => this.dimMenu(dim));
      // Sequential dimension: the same link mark as its pivot chip (issue #2; was "→").
      if (this.store.dimIsSeq(dim.id)) node.querySelector(".tree-label .tree-count")?.before(seqLinkIcon());
      // data-tour anchors the guided tour's set-vs-sequence steps; "@" is covered by its own.
      if (dim.name !== "@") (node.querySelector(".tree-row") as HTMLElement).dataset.tour =
        this.store.dimIsSeq(dim.id) ? "dim-seq" : "dim-set";
      dimChildren.appendChild(node);
    }
    tree.appendChild(dimRoot);

    // Cubes root
    const cubeRoot = this.makeTreeNode("Cubes", kindIcon("cube"), true, () => this.cubeRootMenu());
    (cubeRoot.querySelector(".tree-row") as HTMLElement).dataset.tour = "cubes";
    const cubeChildren = (cubeRoot as any)._children as HTMLElement;
    for (const cube of [...this.store.visibleCubes()].sort(ModelBrowser.byName)) {
      // Qt model_browser: cube nodes expand to their dimensions (cube_dim rows, in cube order).
      const cubeNode = this.makeTreeNode(`${cube.name} (${cube.dimensions})`, kindIcon("cube"), true, () => this.cubeMenu(cube));
      const cubeNodeChildren = (cubeNode as any)._children as HTMLElement;
      // Collapsed by default; expansion is remembered across refresh() rebuilds.
      const cubeTwisty = cubeNode.querySelector(":scope > .tree-row .tree-twisty") as HTMLElement;
      const applyExpanded = (on: boolean) => {
        cubeNodeChildren.style.display = on ? "block" : "none";
        cubeTwisty.textContent = on ? "▾" : "▸";
      };
      applyExpanded(this.expandedCubes.has(cube.id));
      const syncExpanded = () => {
        if (cubeNodeChildren.style.display !== "none") this.expandedCubes.add(cube.id);
        else this.expandedCubes.delete(cube.id);
      };
      cubeTwisty.addEventListener("click", syncExpanded);
      (cubeNode.querySelector(":scope > .tree-row .tree-label") as HTMLElement).addEventListener("click", syncExpanded);
      const dimIds = this.store.cubeDimensionIds(cube.id);
      if (dimIds) {
        for (const dimId of dimIds) {
          const dim = this.store.state.dimensions.find((d) => d.id === dimId);
          cubeNodeChildren.appendChild(this.makeTreeNode(
            dim ? dim.name : this.store.dimName(dimId), kindIcon("dimension"), false,
            dim ? () => this.cubeDimMenu(cube, dim) : undefined));
        }
      } else if (!this.loadingCubeDims.has(cube.id)) {
        // cube_detail loads once per cube; refresh re-renders the children when it lands.
        this.loadingCubeDims.add(cube.id);
        this.store.ensureCubeDetail(cube.id).then(() => {
          this.loadingCubeDims.delete(cube.id);
          if (tree.isConnected) this.refresh(tree);
        });
      }
      cubeChildren.appendChild(cubeNode);
    }
    tree.appendChild(cubeRoot);

    // Views root
    const viewRoot = this.makeTreeNode("Views", kindIcon("view"), true, () => this.viewRootMenu());
    (viewRoot.querySelector(".tree-row") as HTMLElement).dataset.tour = "views";
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

  private cubeDimMenu(cube: any, dim: any) {
    this.popup([{ label: `Detach '${dim.name}' from '${cube.name}'…`, fn: () => this.detachDimFromCube(cube, dim) }]);
  }

  // Qt parity (model_browser.py cube_dim branch): query the blast radius first;
  // zero-impact detaches immediately, otherwise a warning lists the casualties.
  private async detachDimFromCube(cube: any, dim: any) {
    try {
      const impact = (await this.store.api.cubeDetachImpact(cube.id, dim.id)) ?? {};
      const cells = impact.data_cells ?? 0, anchored = impact.anchored_rules ?? 0, rules = impact.rules ?? 0;
      if (cells > 0 || anchored > 0 || rules > 0) {
        const msg =
          `Detach dimension '${dim.name}' from cube '${cube.name}'?\n\n` +
          `This will permanently delete:\n` +
          `• ${cells} data cell(s) (hard numbers)\n` +
          `• ${anchored} anchored rule(s)\n` +
          `• ${rules} rule(s)\n\n` +
          `This action cannot be undone.`;
        if (!(await confirmDialog("Confirm Detach Dimension", msg, "Detach", true))) return;
      }
      await this.store.api.detachDimensionFromCube(cube.id, dim.id);
    } catch (e: any) {
      await alertDialog("Detach Dimension", e?.message || String(e));
      return;
    }
    await this.store.afterStructureChange();
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
}
