import { Store, AppState, SET_RULE_PLACEHOLDER } from "../state";
import { el, clear, ICONS, NOT_IN_MVP_TITLE } from "../dom";
import { materialIconSvg as msym, type MaterialIcon } from "../menuIcons";
import { ModelBrowser } from "./modelBrowser";
import { MultilevelGrid } from "./multilevelGrid";
import { RulePanel } from "./rulePanel";
import { StatusBar } from "./statusBar";
import { InfoToolbox } from "./infoToolbox";
import { FormatToolbox } from "./formatToolbox";
import { PerformanceWatch } from "./performanceWatch";
import { inputDialog, confirmDialog, alertDialog, pickDialog } from "./dialogs";
import { Timeline } from "./timeline";

/** `icon` is inline SVG markup; a `checked` item shows a check mark in the icon column instead. */
type DockName = keyof AppState["dockVisible"];

interface MenuItem { label?: string; icon?: string; sep?: boolean; disabled?: boolean; fn?: () => void; submenu?: MenuItem[]; checked?: boolean; title?: string }

/** Menu items for features outside the MVP preview: greyed out, not hidden. */
const NOT_IN_MVP: Pick<MenuItem, "disabled" | "title"> = { disabled: true, title: NOT_IN_MVP_TITLE };

/** App shell — assembles the full OM Core GUI layout per om-gui.conf:
 *  menu bar + toolbar (top); left docks (Model Browser, Info, Format);
 *  center view workspace with rule bar; right docks (Performance, Timeline);
 *  bottom rule panel; status bar. Mirrors lib_gui/app.py MainWindow. */
export class AppShell {
  constructor(private store: Store) {}
  private perf = new PerformanceWatch(this.store);
  private matrixGrid = new MultilevelGrid(this.store);
  private ruleBarInput: HTMLInputElement | null = null;

  render(): HTMLElement {
    const app = el("div", { id: "app" });
    app.appendChild(this.menuBar());
    app.appendChild(this.toolbar());
    app.appendChild(this.ruleBar());
    const body = el("div", { class: "body" });

    const docks: Record<DockName, HTMLElement> = {
      browser: new ModelBrowser(this.store).render(),
      info: new InfoToolbox(this.store).render(),
      format: new FormatToolbox(this.store).render(),
      perf: this.perf.render(),
      timeline: new Timeline(this.store).render(),
    };

    const left = el("div", { class: "left-docks" });
    left.append(docks.browser, docks.info, docks.format);

    const center = el("div", { class: "center" });
    center.appendChild(this.matrixGrid.render());
    center.appendChild(new RulePanel(this.store).render());

    const right = el("div", { class: "right-docks" });
    right.append(docks.perf, docks.timeline);

    // View menu toggles flip store.state.dockVisible; show/hide panels to match.
    // A side column with no visible panels is hidden too, so the grid takes the space.
    const applyDockVisibility = () => {
      const vis = this.store.state.dockVisible;
      for (const name of Object.keys(docks) as DockName[]) docks[name].hidden = !vis[name];
      left.hidden = !(vis.browser || vis.info || vis.format);
      right.hidden = !(vis.perf || vis.timeline);
    };
    this.store.subscribe(applyDockVisibility);
    applyDockVisibility();

    body.appendChild(left);
    body.appendChild(center);
    body.appendChild(right);
    app.appendChild(body);
    app.appendChild(new StatusBar(this.store).render());

    this.store.subscribe(() => this.updateTitle());
    this.updateTitle();

    return app;
  }

  dispose() { this.perf.dispose(); }

  private updateTitle() {
    const s = this.store.state;
    const dirty = s.dirty ? "*" : "";
    const fname = s.filePath ? s.filePath.split("/").pop() : "New_Model.json";
    document.title = `OM Core: ${dirty}${fname}`;
  }

  // ---- Menu bar ----
  private menuBar(): HTMLElement {
    const mb = el("div", { class: "menubar" });
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
      const mi = el("div", { class: "menu-item" }, [label]);
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
    window.addEventListener("blur", () => this.closeAllMenus());
    mb.appendChild(el("div", { class: "spacer" }));
    const indicator = el("div", { class: "engine-indicator" }, [
      el("span", { class: "engine-dot" }, []),
      el("span", { class: "engine-text" }, ["disconnected"]),
    ]);
    this.store.subscribe(() => {
      const s = this.store.state;
      const dot = indicator.querySelector(".engine-dot") as HTMLElement;
      const txt = indicator.querySelector(".engine-text") as HTMLElement;
      dot.className = "engine-dot " + (s.connected ? "connected" : s.statusMessage.includes("connect") ? "connecting" : s.statusMessage.includes("error") ? "error" : "");
      txt.textContent = s.connected ? `engine: ${s.endpoint || "auto"}` : s.statusMessage;
    });
    mb.appendChild(indicator);
    return mb;
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
      { icon: msym("folder_open"), label: "Open…", fn: () => this.openFile() },
      { icon: msym("save"), label: "Save…", fn: () => this.saveFile() },
      { sep: true },
      { icon: msym("logout"), label: "Quit", fn: () => alertDialog("Quit", "Quit is handled by closing the browser tab or VS Code window.") },
    ];
  }

  private editMenuItems(): MenuItem[] {
    const s = this.store.state;
    return [
      { icon: msym("undo"), label: "Undo" + (s.undoDesc ? ` (${s.undoDesc})` : ""), fn: () => this.store.undo(), disabled: !s.canUndo },
      { icon: msym("redo"), label: "Redo" + (s.redoDesc ? ` (${s.redoDesc})` : ""), fn: () => this.store.redo(), disabled: !s.canRedo },
      { sep: true },
      { icon: msym("content_copy"), label: "Copy", fn: () => this.matrixGrid.copyToClipboard(), disabled: !s.activeView },
      { icon: msym("content_paste"), label: "Paste", fn: () => this.matrixGrid.pasteFromClipboard(), disabled: !s.activeView },
      { icon: msym("content_paste_go"), label: "Paste as New Cube…", fn: () => this.pasteAsNewCube(), ...NOT_IN_MVP },
      { sep: true },
      { icon: msym("label"), label: "Convert Selection to Dimension Labels…", fn: () => this.convertSelectionToDimLabels(), ...NOT_IN_MVP },
      { icon: msym("new_label"), label: "Assign Item Labels from Selection…", fn: () => this.assignItemLabels(), ...NOT_IN_MVP },
      { icon: msym("delete"), label: "Delete Selected Dimension Items…", fn: () => this.deleteSelectedDimItems(), ...NOT_IN_MVP },
      { sep: true },
      { icon: msym("format_clear"), label: "Clear Override", fn: () => this.store.clearSelectedCells(), disabled: !s.activeView },
      { sep: true },
      { icon: msym("function"), label: "Set Rule…", fn: async () => { const t = await inputDialog("Set Value or Rule", "", SET_RULE_PLACEHOLDER); if (t) this.store.applyInput(t); }, disabled: !s.activeView },
      { label: "Focus Rule Bar", fn: () => this.ruleBarInput?.focus() },
    ];
  }

  private modelMenuItems(): MenuItem[] {
    return [
      { icon: ICONS.dim, label: "New Dimension…", fn: () => this.createDimension() },
      { icon: msym("add"), label: "Create Dimension Item…", fn: () => this.createDimensionItem() },
      { icon: msym("delete"), label: "Delete Dimension…", fn: () => this.deleteDimension() },
      { sep: true },
      { icon: msym("table_rows"), label: "Add Group to Row Dim…", fn: () => this.addGroupToAxis("row"), ...NOT_IN_MVP },
      { icon: msym("view_column"), label: "Add Group to Col Dim…", fn: () => this.addGroupToAxis("col"), ...NOT_IN_MVP },
      { sep: true },
      { icon: ICONS.cube, label: "New Cube…", fn: () => this.createCube() },
      { icon: msym("delete"), label: "Delete Cube…", fn: () => this.deleteCube() },
      { sep: true },
      { icon: msym("link"), label: "Attach Dimension to Cube…", fn: () => this.attachDimension() },
      { sep: true },
      { icon: msym("pivot_table_chart"), label: "Edit View Axes…", fn: () => this.editViewAxes() },
      { sep: true },
      { icon: ICONS.view, label: "New View…", fn: () => this.createView() },
    ];
  }

  private viewMenuItems(): MenuItem[] {
    const s = this.store.state;
    return [
      { label: "Model Browser", checked: s.dockVisible.browser, fn: () => this.store.toggleDock("browser") },
      { label: "Info Toolbox", checked: s.dockVisible.info, fn: () => this.store.toggleDock("info") },
      { label: "Format Toolbox", checked: s.dockVisible.format, fn: () => this.store.toggleDock("format"), ...NOT_IN_MVP },
      { label: "Performance Watch", checked: s.dockVisible.perf, fn: () => this.store.toggleDock("perf"), ...NOT_IN_MVP },
      { label: "Timeline", checked: s.dockVisible.timeline, fn: () => this.store.toggleDock("timeline"), ...NOT_IN_MVP },
      { sep: true },
      { label: "Toggle System Elements", checked: s.showSystemElements, fn: () => { this.store.state.showSystemElements = !this.store.state.showSystemElements; this.store.notify(); this.store.refreshModel(); } },
      { sep: true },
      { icon: msym("refresh"), label: "Recalculate View (F9)", fn: () => this.store.recalc("dirty") },
      { icon: msym("sync"), label: "Recalculate Full Model (Shift+F9)", fn: () => this.store.recalc("all") },
    ];
  }

  private toolsMenuItems(): MenuItem[] {
    const s = this.store.state;
    return [
      { icon: msym("memory"), label: "Calculation Engine", submenu: [
        { label: "Python", checked: s.engineType === "python", fn: () => this.store.api.setEngine("python").then(() => { this.store.set({ engineType: "python", isRemote: false }); }) },
        { label: "Remote", checked: s.engineType === "remote", fn: () => this.store.api.setEngine("remote").then(() => { this.store.set({ engineType: "remote", isRemote: true }); }) },
      ], ...NOT_IN_MVP },
      { sep: true },
      { icon: msym("settings"), label: "Options…", fn: () => alertDialog("Options", "Options dialog — GUI configuration pending."), ...NOT_IN_MVP },
    ];
  }

  private windowMenuItems(): MenuItem[] {
    return [
      { icon: msym("open_in_new"), label: "New Window", fn: () => window.open(window.location.href), ...NOT_IN_MVP },
      { icon: msym("close"), label: "Close Window", fn: () => window.close() },
    ];
  }

  private devMenuItems(): MenuItem[] {
    return [
      { icon: msym("bug_report"), label: "GUI Debug Tooltips", fn: () => alertDialog("Debug Tooltips", "Debug tooltips toggle pending."), ...NOT_IN_MVP },
    ];
  }

  private helpMenuItems(): MenuItem[] {
    return [
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
    const copyBtn = ibtn("content_copy", () => this.matrixGrid.copyToClipboard(), "Copy");
    const pasteBtn = ibtn("content_paste", () => this.matrixGrid.pasteFromClipboard(), "Paste");
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
    const offLabel = (text: string) => el("span", { class: "tb-label disabled" }, [text]);

    // Format buttons
    const boldBtn = el("button", { class: "tb-btn", ...off("Bold"), style: { fontWeight: "700" } }, ["B"]);
    boldBtn.addEventListener("click", () => this.store.api.formatBold("selection", true).catch(() => {}));
    tb.appendChild(boldBtn);
    const italicBtn = el("button", { class: "tb-btn", ...off("Italic"), style: { fontStyle: "italic" } }, ["I"]);
    italicBtn.addEventListener("click", () => this.store.api.formatItalic("selection", true).catch(() => {}));
    tb.appendChild(italicBtn);
    const underlineBtn = el("button", { class: "tb-btn", ...off("Underline"), style: { textDecoration: "underline" } }, ["U"]);
    underlineBtn.addEventListener("click", () => this.store.api.formatUnderline("selection", true).catch(() => {}));
    tb.appendChild(underlineBtn);
    tb.appendChild(el("span", { class: "tb-sep" }));

    // Fill color
    const fillInput = el("input", { class: "tb-color", type: "color", value: "#ffffff", ...off("Fill color") }) as HTMLInputElement;
    fillInput.addEventListener("change", () => this.store.api.formatBgColor("selection", fillInput.value).catch(() => {}));
    tb.appendChild(offLabel("Fill"));
    tb.appendChild(fillInput);

    // Font color
    const fontInput = el("input", { class: "tb-color", type: "color", value: "#000000", ...off("Font color") }) as HTMLInputElement;
    fontInput.addEventListener("change", () => this.store.api.formatColor("selection", fontInput.value).catch(() => {}));
    tb.appendChild(offLabel("Font"));
    tb.appendChild(fontInput);
    tb.appendChild(el("span", { class: "tb-sep" }));

    // Number format
    const fmt = el("select", { class: "tb-select", ...off("Number format") }) as HTMLSelectElement;
    [["general", "General"], ["number", "Number"], ["currency", "Currency"], ["percent", "Percent"], ["scientific", "Scientific"]].forEach(([v, l]) => fmt.appendChild(el("option", { value: v }, [l])));
    fmt.addEventListener("change", () => this.store.api.formatNumberFormat("selection", fmt.value).catch(() => {}));
    tb.appendChild(offLabel("Format"));
    tb.appendChild(fmt);

    return tb;
  }

  // ---- Rule bar ----
  private ruleBar(): HTMLElement {
    const bar = el("div", { class: "rule-bar" });
    const nameBox = el("div", { class: "name-box" }, ["—"]);
    const input = el("input", { type: "text", placeholder: "Rule: Dim.Item = expr  •  Cell: =expr or value" }) as HTMLInputElement;
    this.ruleBarInput = input;
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const text = input.value.trim();
        if (!text) return;
        this.store.applyInput(text);
        input.value = "";
      } else if (e.key === "Escape") { input.blur(); }
    });
    bar.appendChild(nameBox);
    bar.appendChild(input);
    this.store.subscribe(() => {
      const v = this.store.state.activeView;
      if (v && v.selectedRow >= 0 && v.selectedCol >= 0 && v.cells) {
        const cell = v.cells.cells[v.selectedRow * v.colKeys.length + v.selectedCol];
        nameBox.textContent = cell ? `${v.rowHeaders[v.selectedRow] || ""} / ${v.colHeaders[v.selectedCol] || ""}` : "—";
      } else nameBox.textContent = "—";
    });
    return bar;
  }

  // ---- Menu action implementations ----
  private async confirmDirty(fn: () => void) {
    if (this.store.state.dirty && !(await confirmDialog("Unsaved Changes", "You have unsaved changes. Discard and continue?", "Discard", true))) return;
    fn();
  }

  private async openFile() {
    this.confirmDirty(async () => {
      const path = await inputDialog("Open Workspace", "", "File path");
      if (path) this.store.loadWorkspaceFile(path);
    });
  }

  private async saveFile() {
    const path = await inputDialog("Save Workspace", this.store.state.filePath || "", "File path");
    if (path) this.store.saveWorkspace(path);
  }

  private async createDimension() {
    const name = await inputDialog("Create Dimension", "", "Dimension name");
    if (!name || !name.trim()) return;
    const isSeq = await confirmDialog("Dimension Type", "Sequential (ordered) dimension?", "Sequential", false);
    const type = isSeq ? "seq" : "set";
    try { await this.store.api.createDimension(name.trim(), type); this.store.markDirty(); this.store.refreshModel(); }
    catch (e: any) { await alertDialog("Failed", e?.message || String(e)); }
  }

  private async createDimensionItem() {
    const dims = this.store.visibleDims().filter((d) => d.name !== "@");
    if (!dims.length) { await alertDialog("No Dimensions", "No dimensions available."); return; }
    const dimName = await pickDialog("Dimension", dims.map((d) => d.name));
    if (!dimName) return;
    const dim = dims.find((d) => d.name === dimName.trim());
    if (!dim) { await alertDialog("Not Found", "Dimension not found."); return; }
    const name = await inputDialog("Create Item", "", "Item name");
    if (!name || !name.trim()) return;
    try {
      await this.store.api.createDimensionItem(dim.id, name.trim());
      this.store.markDirty(); this.store.invalidateDimCache(dim.id); this.store.refreshModel();
      if (this.store.state.activeView) this.store.loadView(this.store.state.activeView.viewId);
    } catch (e: any) { await alertDialog("Failed", e?.message || String(e)); }
  }

  private async deleteDimension() {
    const dims = this.store.visibleDims().filter((d) => d.name !== "@");
    if (!dims.length) { await alertDialog("No Dimensions", "No dimensions available."); return; }
    const dimName = await pickDialog("Delete Dimension", dims.map((d) => d.name));
    if (!dimName) return;
    const dim = dims.find((d) => d.name === dimName.trim());
    if (!dim) { await alertDialog("Not Found", "Dimension not found."); return; }
    if (!(await confirmDialog("Delete Dimension", `Delete dimension "${dim.name}"? This will detach it from all cubes.`, "Delete", true))) return;
    try { await this.store.api.deleteDimension(dim.id); this.store.markDirty(); this.store.invalidateDimCache(dim.id); this.store.refreshModel(); }
    catch (e: any) { await alertDialog("Failed", e?.message || String(e)); }
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

  private async createCube() {
    const name = await inputDialog("Create Cube", "", "Cube name");
    if (!name || !name.trim()) return;
    const dims = this.store.visibleDims().filter((d) => d.name !== "@");
    if (!dims.length) { await alertDialog("No Dimensions", "No dimensions available to attach."); return; }
    const dimNames = dims.map((d) => d.name);
    // Multi-select via comma-separated input
    const selected = await inputDialog("Attach Dimensions", dimNames.join(", "), "Comma-separated dimension names");
    if (!selected) return;
    const ids = selected.split(",").map((s) => s.trim()).map((n) => dims.find((d) => d.name === n)?.id).filter(Boolean) as string[];
    if (!ids.length) { await alertDialog("No Valid Dimensions", "No valid dimensions selected."); return; }
    try { await this.store.api.createCube(name.trim(), ids); this.store.markDirty(); this.store.refreshModel(); }
    catch (e: any) { await alertDialog("Failed", e?.message || String(e)); }
  }

  private async deleteCube() {
    const cubes = this.store.visibleCubes();
    if (!cubes.length) { await alertDialog("No Cubes", "No cubes available."); return; }
    const cubeName = await pickDialog("Delete Cube", cubes.map((c) => c.name));
    if (!cubeName) return;
    const cube = cubes.find((c) => c.name === cubeName.trim());
    if (!cube) { await alertDialog("Not Found", "Cube not found."); return; }
    if (!(await confirmDialog("Delete Cube", `Delete cube "${cube.name}"? This will also delete all views for this cube.`, "Delete", true))) return;
    try { await this.store.api.deleteCube(cube.id); this.store.markDirty(); this.store.refreshModel(); }
    catch (e: any) { await alertDialog("Failed", e?.message || String(e)); }
  }

  private async attachDimension() {
    const cubes = this.store.visibleCubes();
    const dims = this.store.visibleDims().filter((d) => d.name !== "@");
    if (!cubes.length || !dims.length) { await alertDialog("Missing Data", "Need at least one cube and one dimension."); return; }
    const cubeName = await pickDialog("Cube", cubes.map((c) => c.name));
    if (!cubeName) return;
    const cube = cubes.find((c) => c.name === cubeName.trim());
    if (!cube) return;
    const dimName = await pickDialog("Dimension to Attach", dims.map((d) => d.name));
    if (!dimName) return;
    const dim = dims.find((d) => d.name === dimName.trim());
    if (!dim) return;
    try { await this.store.api.attachDimensionToCube(cube.id, dim.id); this.store.markDirty(); this.store.refreshModel(); }
    catch (e: any) { await alertDialog("Failed", e?.message || String(e)); }
  }

  private async editViewAxes() {
    const v = this.store.state.activeView;
    if (!v) { await alertDialog("No Active View", "Open a view first."); return; }
    const dims = this.store.visibleDims().filter((d) => d.name !== "@");
    if (!dims.length) { await alertDialog("No Dimensions", "No dimensions available."); return; }
    const dimNames = dims.map((d) => d.name);
    const rowName = await pickDialog("Row Dimension", dimNames);
    if (!rowName) return;
    const rowDim = dims.find((d) => d.name === rowName.trim());
    if (!rowDim) return;
    const colName = await pickDialog("Column Dimension", dimNames);
    if (!colName) return;
    const colDim = dims.find((d) => d.name === colName.trim());
    if (!colDim) return;
    try { await this.store.api.setViewAxes(v.viewId, rowDim.id, colDim.id); this.store.markDirty(); this.store.loadView(v.viewId); }
    catch (e: any) { await alertDialog("Failed", e?.message || String(e)); }
  }

  private async createView() {
    const cubes = this.store.visibleCubes();
    if (!cubes.length) { await alertDialog("No Cubes", "No cubes available."); return; }
    const cubeName = await pickDialog("Cube", cubes.map((c) => c.name));
    if (!cubeName) return;
    const cube = cubes.find((c) => c.name === cubeName.trim());
    if (!cube) return;
    const name = await inputDialog("View Name", "", "View name");
    if (!name || !name.trim()) return;
    const dims = this.store.visibleDims().filter((d) => d.name !== "@");
    if (!dims.length) { await alertDialog("No Dimensions", "No dimensions available."); return; }
    const dimNames = dims.map((d) => d.name);
    const rowName = await inputDialog("Row Dimensions", dimNames.join(", "), "Comma-separated dimension names");
    const colName = await inputDialog("Column Dimensions", dimNames.join(", "), "Comma-separated dimension names");
    const rowDims = rowName?.split(",").map((s) => dims.find((d) => d.name === s.trim())?.id).filter(Boolean) as string[] || [];
    const colDims = colName?.split(",").map((s) => dims.find((d) => d.name === s.trim())?.id).filter(Boolean) as string[] || [];
    try { await this.store.api.createView(name.trim(), cube.id, rowDims, colDims); this.store.markDirty(); this.store.refreshModel(); }
    catch (e: any) { await alertDialog("Failed", e?.message || String(e)); }
  }

  private async pasteAsNewCube() { await alertDialog("Paste as New Cube", "Requires clipboard data with row/col dimension structure."); }
  private async convertSelectionToDimLabels() { await alertDialog("Convert Selection", "Select cells first, then use this."); }
  private async assignItemLabels() { await alertDialog("Assign Item Labels", "Select rows/columns first."); }
  private async deleteSelectedDimItems() { await alertDialog("Delete Items", "Select items in the Model Browser."); }
}
