import { el } from "../dom";
import type { DockPanelId, DockZoneId } from "../../shared/messages";
import type { DockController } from "./dockZone";

/** Pointer movement below this stays a click, not a drag. */
const DRAG_SLOP = 4;
const ZONES: DockZoneId[] = ["left", "right", "bottom"];

/** Quantrix-style panel drag: pick up a panel's caption (solo zones) or a zone tab
 *  (multi zones) → a ghost follows the cursor → drop onto a zone's strip/body to
 *  merge it as a tab, or onto an edge strip (shown during the drag for empty zones,
 *  which are hidden and can't be hit-tested). Escape cancels; a drop back onto the
 *  panel's own zone is a no-op.
 *
 *  Movement is tracked on `window` (capture phase) rather than relying solely on
 *  pointer capture: webviews and preview iframes can drop or refuse capture, and a
 *  dead tracking path shows up as "nothing drags". preventDefault is delayed until
 *  the drag actually starts — calling it on pointerdown suppresses the click that
 *  activates the tab. */
export class DockDrag {
  /** `host` is the .body element — edge strips are absolutely positioned inside it. */
  constructor(private ctl: DockController, private host: HTMLElement) {}

  /** `zone` pins the source for zone tabs (which reconcile() rebuilds); omit it for a
   *  panel's own caption — its zone is resolved at pointerdown so the same handle
   *  works wherever the panel currently lives. */
  attachHandle(handle: HTMLElement, panel: DockPanelId, zone?: DockZoneId) {
    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const from = zone ?? this.ctl.store.dockPanelZone(panel);
      if (!from) return;
      // A collapsed zone's strip is the splitter's resize handle, not a drag source.
      if (this.ctl.zones[from].el.classList.contains("collapsed")) return;
      const start = { x: e.clientX, y: e.clientY };
      let dragging = false;
      let ghost: HTMLElement | null = null;
      let edges: HTMLElement[] = [];
      let target: DockZoneId | null = null;

      const begin = () => {
        dragging = true;
        ghost = el("div", { class: "dock-ghost" }, [this.ctl.panels[panel]?.title ?? "Panel"]);
        document.body.appendChild(ghost);
        // Every zone gets an edge strip during the drag so the drop targets are visible:
        // on an empty zone the strip IS the only target (the zone itself is hidden);
        // on a non-empty one it reinforces the edge cue, dropping there merges anyway.
        for (const z of ZONES) {
          const edge = el("div", { class: `dock-edge dock-edge-${z}`, "data-zone": z });
          this.host.appendChild(edge);
          edges.push(edge);
        }
        document.body.classList.add("dock-dragging");
        try { handle.setPointerCapture(e.pointerId); } catch { /* capture is best-effort */ }
      };

      const hitZone = (ev: PointerEvent): DockZoneId | null => {
        const t = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
        if (!t) return null;
        const edge = t.closest(".dock-edge") as HTMLElement | null;
        if (edge) return edge.dataset.zone as DockZoneId;
        const zone = t.closest(".dock-zone");
        if (!zone || !(zone instanceof HTMLElement)) return null;
        return (ZONES.find((z) => zone.classList.contains(`dock-${z}`))) ?? null;
      };

      const setTarget = (z: DockZoneId | null) => {
        if (z === target) return;
        target = z;
        for (const zz of ZONES) this.ctl.zones[zz].el.classList.toggle("dock-target", zz === target);
        for (const ed of edges) ed.classList.toggle("hover", ed.dataset.zone === target);
      };

      const onMove = (ev: PointerEvent) => {
        if (!dragging && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) >= DRAG_SLOP) begin();
        if (!dragging || !ghost) return;
        ev.preventDefault();
        ghost.style.left = `${ev.clientX + 12}px`;
        ghost.style.top = `${ev.clientY + 12}px`;
        setTarget(hitZone(ev));
      };

      const finish = (drop: boolean) => {
        window.removeEventListener("pointermove", onMove, true);
        window.removeEventListener("pointerup", onUp, true);
        window.removeEventListener("pointercancel", onCancel, true);
        window.removeEventListener("keydown", onEsc, true);
        ghost?.remove();
        for (const ed of edges) ed.remove();
        edges = [];
        document.body.classList.remove("dock-dragging");
        const t = target;
        setTarget(null);
        if (drop && dragging) {
          // Swallow the click that follows a real drag — it would land on whatever is
          // under the cursor (e.g. activate a tab in the target zone).
          const swallow = (ev: MouseEvent) => {
            ev.stopPropagation();
            ev.preventDefault();
            window.removeEventListener("click", swallow, true);
          };
          window.addEventListener("click", swallow, true);
        }
        if (drop && dragging && t && t !== from) this.ctl.move(panel, t);
      };
      const onUp = (ev: PointerEvent) => {
        if (dragging) { ev.preventDefault(); ev.stopPropagation(); }
        finish(true);
      };
      const onCancel = () => finish(false);
      const onEsc = (ev: KeyboardEvent) => {
        if (ev.key !== "Escape" || !dragging) return;
        ev.preventDefault();
        ev.stopPropagation();
        finish(false);
      };

      window.addEventListener("pointermove", onMove, true);
      window.addEventListener("pointerup", onUp, true);
      window.addEventListener("pointercancel", onCancel, true);
      window.addEventListener("keydown", onEsc, true);
    });
  }
}
