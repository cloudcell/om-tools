/** First-run guided tour (tips v2): a separate, replayable sequence of anchored
 *  callouts — the deliberate-review channel to the contextual tips'
 *  trigger-moment one. Non-modal throughout: no backdrop, no input capture,
 *  Esc exits; the tour and tips never interleave (suppression hook in tips.ts).
 *
 *  placeCallout() is the DOM-free placement core (flip-on-overflow + viewport
 *  clamp), unit-testable in plain Node like TipQueue. */

import type { Store } from "./state";
import { el } from "./dom";
import { materialIconSvg } from "./menuIcons";
import { dismissTip, setTipSuppression, suppressedForOnboarding, updateTipsState } from "./tips";

export type Placement = "bottom" | "top" | "left" | "right" | "inside";

export interface TourStep {
  id: string;
  anchor?: string;           // data-tour value; absent → centered step
  fallbackAnchor?: string;   // used when the primary anchor is absent from the DOM
  place?: Placement;         // preferred side (default bottom)
  fallbackPlace?: Placement; // placement when the fallback anchor is used
  activeTab?: string;        // prefer the match whose active .lower-tab shows this label
  title: string;
  text: string;
}

/** The model the tour opens so every step shows real content — a catalog id
 *  resolved by the host's file boundary, same as Open Example…. */
const TOUR_EXAMPLE_ID = "dcf-valuation";

export const TOUR_STEPS: readonly TourStep[] = [
  { id: "welcome", title: "Welcome to OM Core",
    text: "This tour opens the DCF Valuation example — a live model you can explore." },
  { id: "menus", anchor: "menubar", place: "bottom", title: "Menus",
    text: "File opens models and bundles; View, Tools, and Help hold the rest." },
  { id: "views", anchor: "view-area", place: "inside", title: "Views",
    text: "Each tab is a live view into the model — drag a tab to split." },
  { id: "rules", anchor: "rules", fallbackAnchor: "view-area", place: "left", fallbackPlace: "inside", activeTab: "Rules", title: "Rules",
    text: "Rules attach a formula to a region of cells — select one here to inspect or edit it." },
  { id: "calc-flow", anchor: "view-area", place: "inside", title: "Calculation flow",
    text: "Changing an input recomputes every dependent cell in order — that dependency chain is the calculation flow." },
  { id: "status", anchor: "engine-status", fallbackAnchor: "statusbar", place: "bottom", title: "Engine status",
    text: "The dot shows the live engine state; the status bar below tracks your selection and version." },
  { id: "help", anchor: "help-menu", place: "bottom", title: "That's it",
    text: "Replay this tour anytime from Help → Take the Tour." },
];

export interface RectLike { x: number; y: number; w: number; h: number }

const GAP = 10;
const MARGIN = 8;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(lo, v), Math.max(lo, hi));

/** Position a callout so it corresponds to the anchor's actual location:
 *  the main axis (below/above/beside) decides placement — the first side whose
 *  main-axis edge fits wins; the cross axis is then CLAMPED into the viewport
 *  rather than flipped, so a callout under an edge anchor still sits under it.
 *  "inside" centers within the anchor region (for large areas like view-area).
 *  Pure — the DOM render just applies {x,y}. */
export function placeCallout(
  anchor: RectLike,
  size: { w: number; h: number },
  preferred: Placement,
  viewport: { w: number; h: number },
): { x: number; y: number; placement: Placement } {
  if (preferred === "inside") {
    return {
      x: clamp(anchor.x + anchor.w / 2 - size.w / 2, MARGIN, viewport.w - MARGIN - size.w),
      y: clamp(anchor.y + anchor.h / 2 - size.h / 2, MARGIN, viewport.h - MARGIN - size.h),
      placement: "inside",
    };
  }
  const at = (p: Exclude<Placement, "inside">): { x: number; y: number } => {
    const cx = anchor.x + anchor.w / 2 - size.w / 2;
    const cy = anchor.y + anchor.h / 2 - size.h / 2;
    switch (p) {
      case "bottom": return { x: cx, y: anchor.y + anchor.h + GAP };
      case "top":    return { x: cx, y: anchor.y - size.h - GAP };
      case "right":  return { x: anchor.x + anchor.w + GAP, y: cy };
      case "left":   return { x: anchor.x - size.w - GAP, y: cy };
    }
  };
  const fitsMain = (p: Exclude<Placement, "inside">, { x, y }: { x: number; y: number }) =>
    (p === "bottom" || p === "top")
      ? y >= MARGIN && y + size.h <= viewport.h - MARGIN
      : x >= MARGIN && x + size.w <= viewport.w - MARGIN;
  const clampCross = (p: Exclude<Placement, "inside">, { x, y }: { x: number; y: number }) =>
    (p === "bottom" || p === "top")
      ? { x: clamp(x, MARGIN, viewport.w - MARGIN - size.w), y }
      : { x, y: clamp(y, MARGIN, viewport.h - MARGIN - size.h) };
  const OPPOSITE = { bottom: "top", top: "bottom", left: "right", right: "left" } as const;
  const order = ([preferred, OPPOSITE[preferred], "bottom", "top", "right", "left"] as const)
    .filter((p, i, a): p is Exclude<Placement, "inside"> => a.indexOf(p) === i);
  for (const p of order) {
    const pos = at(p);
    if (fitsMain(p, pos)) return { ...clampCross(p, pos), placement: p };
  }
  const { x, y } = at(preferred as Exclude<Placement, "inside">);
  return {
    x: clamp(x, MARGIN, viewport.w - MARGIN - size.w),
    y: clamp(y, MARGIN, viewport.h - MARGIN - size.h),
    placement: preferred,
  };
}

export class TourManager {
  private stepIndex = -1;
  private callout: HTMLElement | null = null;
  private markedEl: HTMLElement | null = null;
  private inviteEl: HTMLElement | null = null;
  private invitePoll = 0;
  private startPoll = 0;
  private onResize = () => { if (this.active()) this.render(); };

  /** Opens a catalog example by id (host resolves om-example: refs); injected
   *  at mount so the tour loads a real model to point at. */
  private openExample: ((id: string) => Promise<void>) | null = null;

  constructor(private store: Store, openExample?: (id: string) => Promise<void>) {
    this.openExample = openExample ?? null;
  }

  active(): boolean { return this.stepIndex >= 0; }
  inviteVisible(): boolean { return this.inviteEl !== null; }

  /** Help → Take the Tour… / invite accept. Dismisses any visible tip first
   *  (two floating elements must never collide); while onboarding suppression
   *  is up (welcome gate, restore, views loading) the request retries briefly
   *  rather than appearing over a modal. */
  start() {
    if (this.active()) return;
    dismissTip();
    if (suppressedForOnboarding(this.store)) { this.queueStart(); return; }
    this.begin(0);
  }

  private queueStart() {
    if (this.startPoll) return;
    let tries = 0;
    this.startPoll = window.setInterval(() => {
      if (this.active() || ++tries > 40) { window.clearInterval(this.startPoll); this.startPoll = 0; return; }
      if (suppressedForOnboarding(this.store)) return;
      window.clearInterval(this.startPoll);
      this.startPoll = 0;
      this.begin(0);
    }, 500);
  }

  private begin(i: number) {
    this.hideInvite();
    this.stepIndex = i;
    window.addEventListener("resize", this.onResize);
    // Load a real model so anchored steps have something to point at. Async —
    // the first (centered) step reads while it loads; confirmDirty inside
    // openExampleById still protects unsaved work. Fire-and-forget: a declined
    // or failed load never blocks the tour.
    this.openExample?.(TOUR_EXAMPLE_ID)?.catch(() => {});
    this.render();
  }

  /** Completion and skip both persist tourDone — a skipped tour is a declined
   *  tour; replay stays one menu click away, so there is no resume state. */
  private finish() {
    this.stepIndex = -1;
    window.removeEventListener("resize", this.onResize);
    this.teardownDom();
    updateTipsState(this.store, { tourDone: true });
  }

  private next() {
    if (this.stepIndex >= TOUR_STEPS.length - 1) this.finish();
    else { this.stepIndex++; this.render(); }
  }

  private prev() { if (this.stepIndex > 0) { this.stepIndex--; this.render(); } }

  private anchorEl(step: TourStep): { el: HTMLElement; fallback: boolean } | null {
    if (!step.anchor) return null;
    const qsa = (name: string) => [...document.querySelectorAll<HTMLElement>(`[data-tour="${name}"]`)];
    let els = qsa(step.anchor);
    let fallback = false;
    if (!els.length && step.fallbackAnchor) { els = qsa(step.fallbackAnchor); fallback = true; }
    if (!els.length) return null;
    return { el: this.pickAnchor(els, step), fallback };
  }

  /** Multiple view panes can carry the same anchor — each pane has its own
   *  rules subpane, and a collapsed pane stays in the DOM as a thin tab strip.
   *  Point at the one that is actually open: prefer an expanded pane showing
   *  the step's active tab, then any expanded pane, then the largest match.
   *  The 40px floor never eliminates every candidate (collapsed ≈ 28px). */
  private pickAnchor(els: HTMLElement[], step: TourStep): HTMLElement {
    const area = (e: HTMLElement) => { const r = e.getBoundingClientRect(); return r.width * r.height; };
    const biggest = (pool: HTMLElement[]) => pool.reduce((a, b) => (area(b) > area(a) ? b : a));
    const expanded = els.filter((e) => e.getBoundingClientRect().height > 40);
    const pool = expanded.length ? expanded : els;
    if (step.activeTab) {
      const tabbed = pool.filter((e) =>
        (e.querySelector(".lower-tab.active")?.textContent ?? "").trim() === step.activeTab);
      if (tabbed.length) return biggest(tabbed);
    }
    return biggest(pool);
  }

  private render() {
    this.teardownDom();
    const step = TOUR_STEPS[this.stepIndex];
    const found = this.anchorEl(step);
    const anchor = found?.el ?? null;
    const place = found?.fallback ? (step.fallbackPlace ?? step.place) : step.place;
    if (anchor) { anchor.classList.add("om-tour-mark"); this.markedEl = anchor; }

    const n = this.stepIndex, total = TOUR_STEPS.length, last = n === total - 1;
    const nextBtn = el("button", { class: "om-tip-btn primary", onClick: () => this.next() },
      [last ? "Done" : "Next"]);
    const backBtn = el("button", { class: "om-tip-btn", onClick: () => this.prev(), ...(n === 0 ? { disabled: true } : {}) },
      ["Back"]);
    const skipBtn = el("button", { class: "om-tour-skip", onClick: () => this.finish() }, ["Skip tour"]);

    this.callout = el("div", {
      class: "om-tour" + (anchor ? "" : " centered"),
      role: "dialog", "aria-modal": "false", "aria-label": step.title, tabindex: "-1",
      onKeydown: (e: KeyboardEvent) => {
        if (e.key === "ArrowRight") { e.preventDefault(); this.next(); }
        else if (e.key === "ArrowLeft") { e.preventDefault(); this.prev(); }
        else if (e.key === "Escape") { e.preventDefault(); this.finish(); }
      },
    }, [
      el("div", { class: "om-tour-title" }, [step.title]),
      el("div", { class: "om-tour-text" }, [step.text]),
      el("div", { class: "om-tour-foot" }, [
        el("span", { class: "om-tour-count" }, [`${n + 1} / ${total}`]),
        skipBtn, backBtn, nextBtn,
      ]),
    ]);
    document.body.appendChild(this.callout);

    if (anchor) {
      const r = anchor.getBoundingClientRect();
      const c = this.callout.getBoundingClientRect();
      const pos = placeCallout(
        { x: r.x, y: r.y, w: r.width, h: r.height },
        { w: c.width, h: c.height },
        place ?? "bottom",
        { w: window.innerWidth, h: window.innerHeight },
      );
      this.callout.style.left = `${pos.x}px`;
      this.callout.style.top = `${pos.y}px`;
      this.callout.dataset.placement = pos.placement;
      // Arrow on the edge facing the anchor, aligned to the anchor's centre
      // (clamped inside the callout's rounded corners). "inside"/centered → none.
      if (pos.placement !== "inside") {
        const arrow = el("span", { class: "om-tour-arrow" });
        if (pos.placement === "bottom" || pos.placement === "top") {
          arrow.classList.add(pos.placement === "bottom" ? "edge-top" : "edge-bottom");
          arrow.style.left = `${clamp(r.x + r.width / 2 - pos.x, 16, c.width - 16)}px`;
        } else {
          arrow.classList.add(pos.placement === "left" ? "edge-right" : "edge-left");
          arrow.style.top = `${clamp(r.y + r.height / 2 - pos.y, 16, c.height - 16)}px`;
        }
        this.callout.appendChild(arrow);
      }
    }
    nextBtn.focus();
  }

  private teardownDom() {
    this.callout?.remove();
    this.callout = null;
    this.markedEl?.classList.remove("om-tour-mark");
    this.markedEl = null;
  }

  /** First-run invite: a .om-tip-shaped toast rendered OUTSIDE TipQueue (the
   *  queue's seen-memory must never record the invite — tourDone is its own
   *  fact). Re-shown each run until Take the tour / Don't ask again. */
  maybeInvite() {
    if (this.inviteEl || this.active()) return;
    if (this.store.api.loadUiState()?.tips?.tourDone) return;
    if (this.store.state.options.showTips === false) return;
    if (suppressedForOnboarding(this.store)) { this.pollInvite(); return; }

    this.inviteEl = el("div", { class: "om-tip om-tour-invite", role: "status", "aria-live": "polite" }, [
      el("span", { class: "om-tip-icon", html: materialIconSvg("menu_book") }),
      el("span", { class: "om-tip-text" }, ["New here? Take a 30-second tour."]),
      el("button", { class: "om-tip-btn primary", onClick: () => this.start() },
        ["Take the tour"]),
      el("button", { class: "om-tip-btn", onClick: () => this.hideInvite() },
        ["Later"]),
      el("button", { class: "om-tip-btn", title: "Don't ask again (Help → Take the Tour… still works)",
        onClick: () => { updateTipsState(this.store, { tourDone: true }); this.hideInvite(); } },
        ["Don't ask again"]),
    ]);
    document.body.appendChild(this.inviteEl);
  }

  /** The welcome gate can sit up for a while — re-check once a second for up
   *  to two minutes, then give up for this run (invited again next run). */
  private pollInvite() {
    if (this.invitePoll) return;
    let tries = 0;
    this.invitePoll = window.setInterval(() => {
      if (++tries > 120 || this.inviteEl || this.active()
          || this.store.api.loadUiState()?.tips?.tourDone
          || this.store.state.options.showTips === false) {
        window.clearInterval(this.invitePoll);
        this.invitePoll = 0;
        return;
      }
      if (suppressedForOnboarding(this.store)) return;
      window.clearInterval(this.invitePoll);
      this.invitePoll = 0;
      this.maybeInvite();
    }, 1000);
  }

  private hideInvite() { this.inviteEl?.remove(); this.inviteEl = null; }

  dispose() {
    window.clearInterval(this.invitePoll);
    window.clearInterval(this.startPoll);
    this.invitePoll = 0;
    this.startPoll = 0;
    this.stepIndex = -1;
    window.removeEventListener("resize", this.onResize);
    this.teardownDom();
    this.hideInvite();
  }
}

let mgr: TourManager | null = null;

/** Called once at mount, beside initTips: registers the tour/invite suppression
 *  gate with the tips channel and fires the first-run invite. */
export function initTour(store: Store, opts?: { openExample?: (id: string) => Promise<void> }): TourManager {
  mgr?.dispose();
  mgr = new TourManager(store, opts?.openExample);
  setTipSuppression(() => (mgr?.active() || mgr?.inviteVisible()) ?? false);
  mgr.maybeInvite();
  return mgr;
}

export function startTour() { mgr?.start(); }
export function tourActive(): boolean { return mgr?.active() ?? false; }
