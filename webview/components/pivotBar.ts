import { Store } from "../state";
import { el, clear } from "../dom";
import { inputDialog, alertDialog, pickDialog } from "./dialogs";

/** PivotBar — 3-zone pivot-table layout with draggable dimension chips.
 *  Mirrors lib_gui/pivot_bar.py + lib_gui/_view_tab.py:
 *    top-left  = page dims (PageChip with item dropdown)
 *    top-right = col dims (HeaderChip, vertical stack)
 *    bottom    = row dims (AxisChip, horizontal)
 *  Chips drag between zones; drop calls move_view_dimension.
 *  Page chip dropdown calls set_page_item_id. */

type Zone = "row" | "col" | "page";

export class PivotBar {
  constructor(private store: Store) {}

  /** Render the full pivot canvas (3 zones + grid slot). Returns the container
   *  and a ref to the grid mount point so MatrixGrid can fill it. */
  render(): { container: HTMLElement; gridMount: HTMLElement } {
    const container = el("div", { class: "pivot-canvas" });
    const frame = el("div", { class: "pc-frame" });

    const topLeft = el("div", { class: "pc-topleft drop-zone", "data-zone": "page" });
    const gridMount = el("div", { class: "pc-grid" });
    const pageRight = el("div", { class: "pc-pageright drop-zone", "data-zone": "col" });
    const bottom = el("div", { class: "pc-bottom drop-zone", "data-zone": "row" });

    frame.appendChild(topLeft);
    frame.appendChild(gridMount);
    frame.appendChild(pageRight);
    frame.appendChild(bottom);
    container.appendChild(frame);

    this.setupDropZone(topLeft, "page");
    this.setupDropZone(pageRight, "col");
    this.setupDropZone(bottom, "row");

    this.store.subscribe(() => this.refresh(topLeft, pageRight, bottom));
    this.refresh(topLeft, pageRight, bottom);

    return { container, gridMount };
  }

  private refresh(topLeft: HTMLElement, pageRight: HTMLElement, bottom: HTMLElement) {
    const v = this.store.state.activeView;
    if (!v) { clear(topLeft); clear(pageRight); clear(bottom); return; }
    this.renderZone(topLeft, "page", v.pageDimIds);
    this.renderZone(pageRight, "col", v.colDimIds);
    this.renderZone(bottom, "row", v.rowDimIds);
  }

  private renderZone(zoneEl: HTMLElement, zone: Zone, dimIds: string[]) {
    clear(zoneEl);
    for (let i = 0; i < dimIds.length; i++) {
      zoneEl.appendChild(this.makeChip(dimIds[i], zone, i));
    }
    // + button
    const plus = el("button", { class: "dim-chip-plus", title: "Add dimension" }, ["+"]);
    plus.addEventListener("click", () => this.addDimPrompt(zone));
    zoneEl.appendChild(plus);
    // placeholder for empty page zone
    if (zone === "page" && dimIds.length === 0) {
      zoneEl.appendChild(el("span", { class: "drop-placeholder" }, ["drag dims here"]));
    }
  }

  private makeChip(dimId: string, zone: Zone, index: number): HTMLElement {
    const name = this.store.dimName(dimId);
    const isSeq = this.store.dimIsSeq(dimId);
    const grip = el("span", { class: "chip-grip" }, ["\u28FF"]); // braille grip
    const seqMark = isSeq ? el("span", { class: "chip-seq" }, [" \u{1F517}"]) : null;
    const cls = "dim-chip" + (zone === "page" ? " dim-chip-page" : "");

    if (zone === "page") {
      // PageChip: grip + "DimName: ItemName" + dropdown arrow
      const items = this.store.dimItems(dimId);
      const curId = this.store.state.activeView?.pageSelections[dimId];
      const curName = items.find((it) => it.id === curId)?.name || (items[0]?.name || "\u2014");
      const label = el("span", {}, [`${name}: ${curName}`]);
      const arrow = el("span", { class: "chip-arrow" });
      const chip = el("div", { class: cls, draggable: "true", title: `Drag to move; click to pick ${name} item` },
        [grip, label, seqMark, arrow].filter(Boolean) as HTMLElement[]);
      chip.addEventListener("click", (e) => { e.stopPropagation(); this.showPageDropdown(chip, dimId, items); });
      this.setupChipDrag(chip, dimId, zone);
      return chip;
    }

    // AxisChip / HeaderChip: grip + name
    const chip = el("div", { class: cls, draggable: "true", title: `Drag to move ${name}` },
      [grip, el("span", {}, [name]), seqMark].filter(Boolean) as HTMLElement[]);
    this.setupChipDrag(chip, dimId, zone);
    return chip;
  }

  private setupChipDrag(chip: HTMLElement, dimId: string, zone: Zone) {
    chip.addEventListener("dragstart", (e) => {
      e.dataTransfer!.setData("application/x-openm-dim", JSON.stringify({ dim_id: dimId, source_zone: zone }));
      e.dataTransfer!.effectAllowed = "move";
      chip.classList.add("dragging");
    });
    chip.addEventListener("dragend", () => chip.classList.remove("dragging"));
  }

  private setupDropZone(zoneEl: HTMLElement, zone: Zone) {
    zoneEl.addEventListener("dragover", (e) => {
      const data = e.dataTransfer!.types.includes("application/x-openm-dim");
      if (!data) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = "move";
      zoneEl.classList.add("drag-over");
    });
    zoneEl.addEventListener("dragleave", (e) => {
      if (e.target === zoneEl) zoneEl.classList.remove("drag-over");
    });
    zoneEl.addEventListener("drop", (e) => {
      e.preventDefault();
      zoneEl.classList.remove("drag-over");
      const raw = e.dataTransfer!.getData("application/x-openm-dim");
      if (!raw) return;
      try {
        const data = JSON.parse(raw);
        const dimId = data.dim_id;
        if (!dimId) return;
        const insertIndex = this.computeInsertIndex(zoneEl, e.clientX, e.clientY, zone);
        this.store.moveDimension(dimId, zone, insertIndex);
      } catch {}
    });
  }

  private computeInsertIndex(zoneEl: HTMLElement, x: number, y: number, zone: Zone): number {
    const chips = Array.from(zoneEl.querySelectorAll(".dim-chip")) as HTMLElement[];
    if (!chips.length) return 0;
    const vertical = zone === "col";
    for (let i = 0; i < chips.length; i++) {
      const r = chips[i].getBoundingClientRect();
      if (vertical) {
        if (y < r.top + r.height / 2) return i;
      } else {
        if (x < r.left + r.width / 2) return i;
      }
    }
    return chips.length;
  }

  private showPageDropdown(chip: HTMLElement, dimId: string, items: { id: string; name: string }[]) {
    const existing = document.querySelector(".chip-dropdown");
    if (existing) existing.remove();
    if (!items.length) return;
    const curId = this.store.state.activeView?.pageSelections[dimId];
    const dd = el("div", { class: "chip-dropdown" });
    for (const it of items) {
      const item = el("div", { class: "cd-item" + (it.id === curId ? " checked" : "") }, [it.name]);
      item.addEventListener("click", () => { dd.remove(); this.store.setPageItem(dimId, it.id); });
      dd.appendChild(item);
    }
    const r = chip.getBoundingClientRect();
    dd.style.left = r.left + "px";
    dd.style.top = (r.bottom + 2) + "px";
    document.body.appendChild(dd);
    const close = (e: MouseEvent) => {
      if (!dd.contains(e.target as Node)) { dd.remove(); document.removeEventListener("click", close); }
    };
    setTimeout(() => document.addEventListener("click", close), 0);
  }

  private async addDimPrompt(zone: Zone) {
    const v = this.store.state.activeView;
    if (!v) return;
    const cubeDims = this.store.state.dimensions.filter((d) => d.name !== "@");
    const assigned = new Set([...v.rowDimIds, ...v.colDimIds, ...v.pageDimIds]);
    const available = cubeDims.filter((d) => !assigned.has(d.id) && !this.store.isSystem(d.name));
    if (!available.length) { await alertDialog("No Dimensions", "No unassigned dimensions available to add."); return; }
    const names = available.map((d) => d.name);
    const pick = await pickDialog(`Add dimension to ${zone} axis`, names);
    if (!pick) return;
    const dim = available.find((d) => d.name === pick.trim());
    if (!dim) { await alertDialog("Not Found", `Dimension "${pick}" not found or already assigned.`); return; }
    this.store.moveDimension(dim.id, zone, v[`${zone}DimIds` as "rowDimIds" | "colDimIds" | "pageDimIds"].length);
  }
}
