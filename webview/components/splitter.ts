import { el } from "../dom";

/** Draggable border between a panel and the grid (T-045), like the sashes in VS Code.
 *
 *  - Drag: resize within [min, max()]. Past half the minimum the panel collapses at once (before the
 *    mouse is released); dragging back opens it again. Escape during a drag restores size and state.
 *  - Collapsed: `collapsed` class on the element (the left column turns it into a strip with a grip).
 *    Click opens the panel at its previous size, drag opens it under the mouse.
 *  - Double-click on an open splitter: default size.
 *  - Keyboard: arrows ±10 px (Shift ±50), the arrow towards the edge at the minimum collapses,
 *    Enter collapses / expands.
 *
 *  The owner keeps the size and applies it (CSS variable, classes) in `apply`; `size` is always the
 *  expanded size, also while collapsed. `commit` runs once per finished gesture, to persist. */
export interface SplitterOptions {
  /** "x": vertical line, sizes a width; "y": horizontal line, sizes a height. */
  axis: "x" | "y";
  /** +1: moving right / down makes the panel bigger (left column); -1: moving left / up (bottom panel). */
  grow: 1 | -1;
  min: number;
  max: () => number;
  defaultSize: number;
  /** Room the collapsed panel still takes (strip or tab row) — where a drag from collapsed starts. */
  collapsedSize: number;
  /** For tooltips: "the left panel", "the bottom panel". */
  label: string;
  get: () => { size: number; collapsed: boolean };
  apply: (size: number, collapsed: boolean) => void;
  commit: () => void;
}

/** Pointer movement below this counts as a click, not a drag. */
const CLICK_SLOP = 3;

export class Splitter {
  readonly el: HTMLElement;
  /** A click that just opened the panel: the dblclick that follows it must not reset the size. */
  private openedByClickAt = 0;

  constructor(private o: SplitterOptions) {
    this.el = el("div", {
      class: `splitter splitter-${o.axis}`,
      role: "separator",
      tabindex: "0",
      "aria-orientation": o.axis === "x" ? "vertical" : "horizontal",
    });
    this.el.addEventListener("pointerdown", (e) => this.beginDrag(e, this.el));
    this.el.addEventListener("dblclick", () => this.onDoubleClick());
    this.el.addEventListener("keydown", (e) => this.onKey(e));
    this.sync();
  }

  /** Refresh class, tooltip and ARIA from the owner's state. */
  sync() {
    const { size, collapsed } = this.o.get();
    this.el.classList.toggle("collapsed", collapsed);
    this.el.title = collapsed
      ? `Drag or click to show ${this.o.label}`
      : `Drag to resize ${this.o.label}, drag to the edge to hide. Double-click: default size`;
    this.el.setAttribute("aria-label", `Resize ${this.o.label}`);
    this.el.setAttribute("aria-expanded", String(!collapsed));
    this.el.setAttribute("aria-valuemin", String(this.o.min));
    this.el.setAttribute("aria-valuemax", String(Math.round(this.o.max())));
    this.el.setAttribute("aria-valuenow", String(collapsed ? 0 : Math.round(size)));
  }

  /** Expand or collapse from code (a tab click on the collapsed bottom panel, View menu). */
  setCollapsed(collapsed: boolean) {
    const { size, collapsed: was } = this.o.get();
    if (was === collapsed) return;
    this.set(this.clampSize(size), collapsed);
    this.o.commit();
  }

  /** Start a drag from this splitter or from another handle (the tab row of the collapsed bottom panel). */
  beginDrag(e: PointerEvent, handle: HTMLElement) {
    if (e.button !== 0) return;
    e.preventDefault();
    const start = { ...this.o.get() };
    const startPos = this.pos(e);
    const visibleStart = start.collapsed ? this.o.collapsedSize : start.size;
    let moved = false;
    let last: PointerEvent = e;
    let frame = 0;

    const update = (ev: PointerEvent) => {
      const delta = (this.pos(ev) - startPos) * this.o.grow;
      if (Math.abs(delta) >= CLICK_SLOP) moved = true;
      if (!moved) return;
      const raw = visibleStart + delta;
      if (raw < this.o.min / 2) this.set(start.size, true);   // keep the size to reopen with
      else this.set(this.clampSize(raw), false);
    };
    const onMove = (ev: PointerEvent) => {
      last = ev;
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; update(last); });
    };
    const finish = (cancel: boolean) => {
      if (frame) { cancelAnimationFrame(frame); frame = 0; }
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onEsc, true);
      try { handle.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      this.el.classList.remove("dragging");
      document.body.classList.remove(`splitter-dragging-${this.o.axis}`);
      if (cancel) this.set(start.size, start.collapsed);
      else if (!moved && start.collapsed) { this.set(this.clampSize(start.size), false); this.openedByClickAt = Date.now(); }
      const now = this.o.get();
      if (now.size !== start.size || now.collapsed !== start.collapsed) this.o.commit();
    };
    const onUp = (ev: PointerEvent) => { update(ev); finish(false); };
    const onCancel = () => finish(true);
    const onEsc = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      finish(true);
    };

    handle.setPointerCapture(e.pointerId);
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onEsc, true);
    this.el.classList.add("dragging");
    document.body.classList.add(`splitter-dragging-${this.o.axis}`);
  }

  private onDoubleClick() {
    const { collapsed } = this.o.get();
    if (collapsed || Date.now() - this.openedByClickAt < 600) return;
    this.set(this.clampSize(this.o.defaultSize), false);
    this.o.commit();
  }

  private onKey(e: KeyboardEvent) {
    const { size, collapsed } = this.o.get();
    const bigger = this.o.axis === "x" ? (this.o.grow === 1 ? "ArrowRight" : "ArrowLeft") : (this.o.grow === 1 ? "ArrowDown" : "ArrowUp");
    const smaller = this.o.axis === "x" ? (this.o.grow === 1 ? "ArrowLeft" : "ArrowRight") : (this.o.grow === 1 ? "ArrowUp" : "ArrowDown");
    if (e.key === "Enter") {
      this.set(this.clampSize(size), !collapsed);
    } else if (e.key === bigger || e.key === smaller) {
      const step = e.shiftKey ? 50 : 10;
      if (collapsed) {
        if (e.key !== bigger) return;
        this.set(this.clampSize(size), false);
      } else if (e.key === smaller && size <= this.o.min) {
        this.set(size, true);
      } else {
        this.set(this.clampSize(size + (e.key === bigger ? step : -step)), false);
      }
    } else {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    this.o.commit();
  }

  private set(size: number, collapsed: boolean) {
    this.o.apply(Math.round(size), collapsed);
    this.sync();
  }

  private clampSize(px: number): number {
    return Math.max(this.o.min, Math.min(Math.max(this.o.min, this.o.max()), px));
  }

  private pos(e: PointerEvent): number {
    return this.o.axis === "x" ? e.clientX : e.clientY;
  }
}
