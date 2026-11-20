import { el } from "../dom";
import type { Store, AreaSide } from "../state";

const DRAG_SLOP = 4;
const SIDES: AreaSide[] = ["left", "right", "top", "bottom", "center"];

/** Drag a view tab out of its pane: a ghost follows the cursor and every pane shows
 *  drop targets — the four edges (split the pane, the tab opens in a new sibling
 *  aggregate pane) and the center (merge the tab into that pane). Escape cancels;
 *  a drop on the tab's own pane centre is a no-op activation.
 *
 *  Same tracking discipline as DockDrag: window capture-phase move/up listeners
 *  (webviews can drop pointer capture), preventDefault only once the drag starts. */
export class ViewTabDrag {
  constructor(private store: Store) {}

  attach(tab: HTMLElement, viewId: string) {
    tab.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const start = { x: e.clientX, y: e.clientY };
      let dragging = false;
      let ghost: HTMLElement | null = null;
      let overlays: HTMLElement[] = [];
      let target: { gid: string; side: AreaSide } | null = null;
      const name = (tab.textContent || "").replace(/×/g, "").trim() || "View";

      const begin = () => {
        dragging = true;
        ghost = el("div", { class: "dock-ghost" }, [name]);
        document.body.appendChild(ghost);
        for (const pane of document.querySelectorAll<HTMLElement>(".va-group")) {
          const ov = el("div", { class: "va-drop" });
          for (const s of SIDES) {
            ov.appendChild(el("div", { class: `va-target va-t-${s}`, "data-gid": pane.dataset.gid!, "data-side": s }));
          }
          pane.appendChild(ov);
          overlays.push(ov);
        }
        document.body.classList.add("dock-dragging");
        try { tab.setPointerCapture(e.pointerId); } catch { /* capture is best-effort */ }
      };

      const hit = (ev: PointerEvent): { gid: string; side: AreaSide } | null => {
        const t = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
        const cell = t?.closest(".va-target") as HTMLElement | null;
        return cell ? { gid: cell.dataset.gid!, side: cell.dataset.side as AreaSide } : null;
      };

      const setTarget = (n: { gid: string; side: AreaSide } | null) => {
        target = n;
        for (const ov of overlays) {
          ov.querySelectorAll<HTMLElement>(".va-target").forEach((c) => {
            c.classList.toggle("hover", !!n && c.dataset.gid === n.gid && c.dataset.side === n.side);
          });
        }
      };

      const onMove = (ev: PointerEvent) => {
        if (!dragging && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) >= DRAG_SLOP) begin();
        if (!dragging || !ghost) return;
        ev.preventDefault();
        ghost.style.left = `${ev.clientX + 12}px`;
        ghost.style.top = `${ev.clientY + 12}px`;
        setTarget(hit(ev));
      };

      const finish = (drop: boolean) => {
        window.removeEventListener("pointermove", onMove, true);
        window.removeEventListener("pointerup", onUp, true);
        window.removeEventListener("pointercancel", onCancel, true);
        window.removeEventListener("keydown", onEsc, true);
        ghost?.remove();
        for (const ov of overlays) ov.remove();
        overlays = [];
        document.body.classList.remove("dock-dragging");
        const t = target;
        target = null;
        if (drop && dragging) {
          const swallow = (ev: MouseEvent) => {
            ev.stopPropagation();
            ev.preventDefault();
            window.removeEventListener("click", swallow, true);
          };
          window.addEventListener("click", swallow, true);
        }
        if (drop && dragging && t) this.store.moveTab(viewId, t.gid, t.side);
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
