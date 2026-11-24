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

export type Placement = "bottom" | "top" | "left" | "right";

export interface TourStep {
  id: string;
  anchor?: string;           // data-tour value; absent → centered step
  fallbackAnchor?: string;   // used when the primary anchor is absent from the DOM
  place?: Placement;         // preferred side (default bottom)
  title: string;
  text: string;
}

export const TOUR_STEPS: readonly TourStep[] = [
  { id: "welcome", title: "Welcome to OM Core",
    text: "This is your model workspace — a live view of your data." },
  { id: "menus", anchor: "menubar", place: "bottom", title: "Menus",
    text: "File opens models and bundles; View, Tools, and Help hold the rest." },
  { id: "views", anchor: "view-area", place: "top", title: "Views",
    text: "Each tab is a live view into the model — drag a tab to split." },
  { id: "rules", anchor: "rules", fallbackAnchor: "view-area", place: "left", title: "Rules",
    text: "Rules define how cells calculate — select one to inspect or edit it." },
  { id: "status", anchor: "statusbar", place: "top", title: "Engine status",
    text: "The indicator shows the engine state and current selection." },
  { id: "help", anchor: "help-menu", place: "bottom", title: "That's it",
    text: "Replay this tour anytime from Help → Take the Tour." },
];

export interface RectLike { x: number; y: number; w: number; h: number }

const GAP = 10;
const MARGIN = 8;

/** Position a callout next to an anchor rect: preferred side first, flip through
 *  the remaining sides on overflow, clamp inside the viewport as a last resort.
 *  Pure — the DOM render just applies {x,y}. */
export function placeCallout(
  anchor: RectLike,
  size: { w: number; h: number },
  preferred: Placement,
  viewport: { w: number; h: number },
): { x: number; y: number; placement: Placement } {
  const at = (p: Placement): { x: number; y: number } => {
    const cx = anchor.x + anchor.w / 2 - size.w / 2;
    const cy = anchor.y + anchor.h / 2 - size.h / 2;
    switch (p) {
      case "bottom": return { x: cx, y: anchor.y + anchor.h + GAP };
      case "top":    return { x: cx, y: anchor.y - size.h - GAP };
      case "right":  return { x: anchor.x + anchor.w + GAP, y: cy };
      case "left":   return { x: anchor.x - size.w - GAP, y: cy };
    }
  };
  const fits = ({ x, y }: { x: number; y: number }) =>
    x >= MARGIN && y >= MARGIN && x + size.w <= viewport.w - MARGIN && y + size.h <= viewport.h - MARGIN;
  const order = [preferred, "bottom", "top", "right", "left"]
    .filter((p, i, a): p is Placement => a.indexOf(p) === i);
  for (const p of order) {
    const pos = at(p);
    if (fits(pos)) return { ...pos, placement: p };
  }
  const { x, y } = at(preferred);
  return {
    x: Math.min(Math.max(MARGIN, x), Math.max(MARGIN, viewport.w - MARGIN - size.w)),
    y: Math.min(Math.max(MARGIN, y), Math.max(MARGIN, viewport.h - MARGIN - size.h)),
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

  constructor(private store: Store) {}

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

  private anchorEl(step: TourStep): HTMLElement | null {
    if (!step.anchor) return null;
    const primary = document.querySelector(`[data-tour="${step.anchor}"]`);
    if (primary) return primary as HTMLElement;
    if (step.fallbackAnchor)
      return document.querySelector(`[data-tour="${step.fallbackAnchor}"]`) as HTMLElement | null;
    return null;
  }

  private render() {
    this.teardownDom();
    const step = TOUR_STEPS[this.stepIndex];
    const anchor = this.anchorEl(step);
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
        step.place ?? "bottom",
        { w: window.innerWidth, h: window.innerHeight },
      );
      this.callout.style.left = `${pos.x}px`;
      this.callout.style.top = `${pos.y}px`;
      this.callout.dataset.placement = pos.placement;
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
export function initTour(store: Store): TourManager {
  mgr?.dispose();
  mgr = new TourManager(store);
  setTipSuppression(() => (mgr?.active() || mgr?.inviteVisible()) ?? false);
  mgr.maybeInvite();
  return mgr;
}

export function startTour() { mgr?.start(); }
export function tourActive(): boolean { return mgr?.active() ?? false; }
