import { Store } from "../state";
import { formDialog, confirmDialog, alertDialog, FormOption } from "./dialogs";

type Axis = "row" | "col" | "page";
const NEW_DIM = "__new__";
const TYPE_OPTIONS: FormOption[] = [{ value: "set", label: "Set (unordered)" }, { value: "seq", label: "Sequence (ordered)" }];

/** Create / delete model objects — one implementation for the Model menu, the Model Browser context menu
 *  and the pivot "+" buttons. Mirrors the Qt handlers in lib_gui/app.py: `_on_create_dimension`,
 *  `_on_create_dimension_item`, `_on_delete_dimension`, `_on_create_cube` (+ `_create_default_view_for_cube`),
 *  `_on_delete_cube`, `_on_add_view`, `_on_attach_dimension_to_cube`. Every failure is shown in a dialog. */
export class ModelActions {
  constructor(private store: Store) {}

  /** User dimensions, sorted by name as in Qt (no `@`, no `%…` system dims unless shown). */
  private userDims() {
    return this.store.visibleDims().filter((d) => d.name !== "@").sort((a, b) => a.name.localeCompare(b.name));
  }
  private dimOptions(dims = this.userDims()): FormOption[] { return dims.map((d) => ({ value: d.id, label: d.name })); }
  private itemsOf(dimId: string) { return this.store.state.dimensions.find((d) => d.id === dimId)?.item_list || []; }

  async newDimension() {
    const v = await formDialog("New Dimension", [
      { kind: "text", key: "name", label: "Name", placeholder: "Dimension name" },
      { kind: "select", key: "type", label: "Type", options: TYPE_OPTIONS },
    ], { validate: (v) => (v.name.trim() ? null : "Dimension name is required.") });
    if (!v) return;
    try { await this.store.api.createDimension(v.name.trim(), v.type); }
    catch (e: any) { await alertDialog("Create Dimension", e?.message || String(e)); return; }
    await this.store.afterStructureChange();
  }

  async newDimensionItem(dimId?: string) {
    const dims = this.userDims();
    if (!dims.length) { await alertDialog("Add Dimension Item", "No dimensions exist yet."); return; }
    const v = await formDialog("Add Dimension Item", [
      { kind: "select", key: "dim", label: "Dimension", options: this.dimOptions(dims), value: dimId },
      { kind: "text", key: "name", label: "Item name", placeholder: "Item name" },
      { kind: "check", key: "prepend", label: "Prepend (only for sequence dims)" },
    ], { validate: (v) => (v.name.trim() ? null : "Item name is required.") });
    if (!v) return;
    try { await this.store.api.createDimensionItem(v.dim, v.name.trim(), v.prepend ? "prepend" : "append"); }
    catch (e: any) { await alertDialog("Add Item", e?.message || String(e)); return; }
    await this.store.afterStructureChange();
  }

  async deleteDimension(dimId?: string) {
    const dims = this.userDims();
    if (!dims.length) { await alertDialog("Delete Dimension", "No dimensions exist yet."); return; }
    if (!dimId) {
      const v = await formDialog("Delete Dimension", [{ kind: "select", key: "dim", label: "Dimension", options: this.dimOptions(dims) }], { okLabel: "Next…" });
      if (!v) return;
      dimId = v.dim as string;
    }
    const dim = dims.find((d) => d.id === dimId);
    if (!dim) return;
    // Qt: warn with what goes away (cells with hard numbers, rules) when there is something
    let impact = "";
    try {
      const r = await this.store.api.dimensionDeletionImpact(dim.id, this.itemsOf(dim.id).map((i) => i.id));
      if (r && (r.total_data_cells > 0 || r.anchored_rules > 0 || r.rules > 0)) {
        impact = `\n\nThis will permanently delete:\n• ${r.total_data_cells} data cell(s) (hard numbers)\n• ${r.anchored_rules} anchored rule(s)\n• ${r.rules} rule(s)`;
      }
    } catch { /* impact is informational; the confirmation still follows */ }
    if (!(await confirmDialog("Confirm Delete Dimension", `Delete dimension '${dim.name}'?${impact}\n\nThis action cannot be undone.`, "Delete", true))) return;
    try { await this.store.api.deleteDimension(dim.id); }
    catch (e: any) { await alertDialog("Delete Dimension", e?.message || String(e)); }
    await this.store.afterStructureChange();
  }

  /** Qt `_on_create_cube`: name + dimensions, then a default view (rows = first dim, columns = second,
   *  `@` and the rest on the page), which is opened. */
  async newCube() {
    const dims = this.userDims();
    if (!dims.length) { await alertDialog("New Cube", "Create at least one dimension first."); return; }
    const v = await formDialog("New Cube", [
      { kind: "text", key: "name", label: "Name", placeholder: "Cube name" },
      { kind: "checks", key: "dims", label: "Dimensions", options: this.dimOptions(dims) },
    ], { validate: (v) => (v.name.trim() && v.dims.length ? null : "Please provide a name and select at least one dimension.") });
    if (!v) return;
    const name = v.name.trim(), dimIds: string[] = v.dims;
    let cubeId: string | undefined;
    try { cubeId = (await this.store.api.createCube(name, dimIds))?.id; }
    catch (e: any) { await alertDialog("New Cube", `Failed to create cube: ${e?.message || String(e)}`); return; }
    if (!cubeId) { await alertDialog("New Cube", "Cube creation returned no ID"); await this.store.afterStructureChange(); return; }
    const view = await this.createDefaultView(`View of ${name}`, cubeId, dimIds);
    await this.store.afterStructureChange(view);
  }

  /** Qt `_on_add_view`: name (unique, case-insensitive) + cube; axes like the default view. */
  async newView(cubeId?: string) {
    const cubes = this.store.visibleCubes();
    if (!cubes.length) { await alertDialog("New View", "No cubes in workspace yet."); return; }
    const taken = new Set(this.store.state.views.map((x) => x.name.toLowerCase()));
    const v = await formDialog("New View", [
      { kind: "text", key: "name", label: "Name", value: "New View" },
      { kind: "select", key: "cube", label: "Cube", options: cubes.map((c) => ({ value: c.id, label: c.name })), value: cubeId ?? this.store.state.activeView?.cubeId },
    ], { validate: (v) => { const n = v.name.trim() || "View"; return taken.has(n.toLowerCase()) ? `A view named '${n}' already exists. Please choose a different name.` : null; } });
    if (!v) return;
    let dimIds: string[] = [];
    try { dimIds = ((await this.store.api.cubeDetail(v.cube))?.dimension_ids || []).filter((d: string) => d !== "@"); }
    catch (e: any) { await alertDialog("New View", e?.message || String(e)); return; }
    if (!dimIds.length) { await alertDialog("New View", "Cube has no dimensions."); return; }
    const view = await this.createDefaultView(v.name.trim() || "View", v.cube, dimIds);
    if (view) await this.store.afterStructureChange(view);
  }

  private async createDefaultView(name: string, cubeId: string, dimIds: string[]): Promise<{ viewId: string; viewName: string } | undefined> {
    const user = dimIds.filter((d) => d !== "@");
    try {
      const r = await this.store.api.createView(name, cubeId, [user[0]], user[1] ? [user[1]] : [], ["@", ...user.slice(2)]);
      return r?.id ? { viewId: r.id, viewName: name } : undefined;
    } catch (e: any) { await alertDialog("Create View", e?.message || String(e)); return undefined; }
  }

  async deleteCube(cubeId?: string) {
    const cubes = this.store.visibleCubes();
    if (!cubes.length) { await alertDialog("Delete Cube", "No cubes to delete."); return; }
    if (!cubeId) {
      const v = await formDialog("Delete Cube", [{ kind: "select", key: "cube", label: "Cube", options: cubes.map((c) => ({ value: c.id, label: c.name })) }], { okLabel: "Next…" });
      if (!v) return;
      cubeId = v.cube as string;
    }
    const cube = cubes.find((c) => c.id === cubeId);
    if (!cube) return;
    if (!(await confirmDialog("Confirm Delete", `Delete cube '${cube.name}' and all its views?`, "Delete", true))) return;
    try { await this.store.api.deleteCube(cube.id); }
    catch (e: any) { await alertDialog("Delete Cube", e?.message || String(e)); }
    await this.store.afterStructureChange();
  }

  async deleteView(viewId: string) {
    const view = this.store.state.views.find((x) => x.id === viewId);
    if (!view) return;
    if (this.store.state.views.length <= 1) { await alertDialog("Cannot Delete", "Cannot delete the last view."); return; }
    if (!(await confirmDialog("Delete View", `Delete view '${view.name}'?`, "Delete", true))) return;
    try { await this.store.api.deleteView(view.id); }
    catch (e: any) { await alertDialog("Delete View", e?.message || String(e)); }
    await this.store.afterStructureChange();
  }

  /** Qt `_on_attach_dimension_to_cube` (Model → Attach Dimension…, pivot "+"): an existing dimension not in
   *  the active view's cube, with its default item, or a new one with items; then it is put on `axis`. */
  async attachDimension(axis: Axis = "row") {
    const av = this.store.state.activeView;
    const cube = av && this.store.state.cubes.find((c) => c.id === av.cubeId);
    if (!av || !cube) { await alertDialog("Add Dimension", "Open a view first."); return; }
    let inCube = new Set<string>();
    try { inCube = new Set(((await this.store.api.cubeDetail(cube.id))?.dimension_ids || []) as string[]); }
    catch (e: any) { await alertDialog("Add Dimension", e?.message || String(e)); return; }
    const available = this.userDims().filter((d) => !inCube.has(d.id));
    const isNew = (v: any) => v.dim === NEW_DIM;
    const v = await formDialog(`Add Dimension to ${cube.name}`, [
      { kind: "select", key: "dim", label: "Dimension", options: [{ value: NEW_DIM, label: "— create new dimension —" }, ...this.dimOptions(available)] },
      { kind: "text", key: "newName", label: "New name", placeholder: "Dimension name", visibleIf: isNew },
      { kind: "select", key: "newType", label: "Type", options: TYPE_OPTIONS, visibleIf: isNew },
      { kind: "text", key: "newItems", label: "Items", placeholder: "Item names, comma-separated (e.g. Jan,Feb,Mar)", visibleIf: isNew },
      { kind: "select", key: "defaultItem", label: "Default item", visibleIf: (v) => !isNew(v),
        options: (v) => { const items = isNew(v) ? [] : this.itemsOf(v.dim); return items.length ? items.map((i) => ({ value: i.id, label: i.name })) : [{ value: "", label: "— no items —" }]; } },
    ], { validate: (v) => {
      if (isNew(v)) return v.newName.trim() ? null : "Dimension name is required.";
      return v.defaultItem ? null : "The selected dimension has no items. Please add items to the dimension before attaching it to a cube.";
    } });
    if (!v) return;
    try {
      let dimId: string = v.dim, defaultItem: string = v.defaultItem;
      if (isNew(v)) {
        dimId = (await this.store.api.createDimension(v.newName.trim(), v.newType))?.id;
        if (!dimId) throw new Error("create_dimension returned no dimension id");
        const names = String(v.newItems).split(",").map((s) => s.trim()).filter(Boolean);
        for (const n of names.length ? names : ["Item 1"]) {
          const id = (await this.store.api.createDimensionItem(dimId, n))?.id;
          if (!defaultItem && id) defaultItem = id;
        }
        if (!defaultItem) throw new Error("No items were created");
      }
      await this.store.api.attachDimensionToCube(cube.id, dimId, defaultItem);
      await this.store.api.moveViewDimension(av.viewId, dimId, axis);
    } catch (e: any) { await alertDialog("Add Dimension", e?.message || String(e)); }
    await this.store.afterStructureChange();
  }
}
