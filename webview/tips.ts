/** Contextual first-use tips (T-tips): a small non-modal toast that fires once per
 *  trigger until acknowledged with "Got it". Close/timer hides without marking seen,
 *  so nothing educational is permanently lost. Registry is append-only — an id is
 *  forever; renaming re-shows the tip to everyone.
 *
 *  TipQueue is the DOM-free core (seen memory + one-visible/one-pending queue),
 *  unit-testable in plain Node; TipManager adds suppression checks, persistence,
 *  and the toast render. */

import type { Store } from "./state";
import { el } from "./dom";
import { materialIconSvg } from "./menuIcons";

export interface Tip { id: string; text: string; }

export const TIPS: readonly Tip[] = [
  { id: "example-opened", text: "Explore the Rules panel to see how this model calculates its results." },
  { id: "view-split", text: "You can inspect different parts of your model side by side." },
  { id: "rules-opened", text: "Select a rule to inspect or edit the model's calculations." },
  { id: "bundle-saved", text: "Your model and workspace layout are saved together in an .omz file." },
];
const TIP_IDS = new Set(TIPS.map((t) => t.id));
const TEXT_BY_ID = new Map(TIPS.map((t) => [t.id, t.text]));

/** Seen memory + queue policy: at most one visible and one pending. push() dedupes
 *  (same id visible, pending, or already seen). resolve() marks seen only on
 *  acknowledgement; a pending tip that became seen while queued is discarded stale. */
export class TipQueue {
  private seen = new Set<string>();
  private visible: string | null = null;
  private pending: string | null = null;

  constructor(seen?: Iterable<string>) { if (seen) for (const id of seen) this.seen.add(id); }

  isSeen(id: string) { return this.seen.has(id); }
  get seenIds(): string[] { return [...this.seen]; }
  get current(): string | null { return this.visible; }
  get queued(): string | null { return this.pending; }
  clearSeen() { this.seen.clear(); }

  /** Returns the id to render now, or null when queued/absorbed. */
  push(id: string): string | null {
    if (this.seen.has(id) || this.visible === id || this.pending === id) return null;
    if (this.visible) { this.pending = id; return null; }
    this.visible = id;
    return id;
  }

  /** The visible tip ended: ack marks it seen. Returns the pending candidate to
   *  promote (caller re-checks suppression before rendering), or null. */
  resolve(ack: boolean): string | null {
    if (!this.visible) return null;
    if (ack) this.seen.add(this.visible);
    this.visible = null;
    const next = this.pending;
    this.pending = null;
    if (!next) return null;
    if (this.seen.has(next)) return null;
    this.visible = next;
    return next;
  }

  /** Drops the visible tip without marking and discards the queue (disable path). */
  cancel() { this.visible = null; this.pending = null; }
}

const AUTO_DISMISS_MS = 8000;

/** Onboarding-wide suppression probes shared by tips and the tour: never over
 *  the welcome gate, during session restore, or while any view is still loading. */
export function suppressedForOnboarding(store: Store): boolean {
  if (store.isRestoring()) return true;
  if (typeof document !== "undefined" && document.querySelector(".welcome-overlay")) return true;
  return Object.values(store.state.viewStates).some((v) => v.loading);
}

/** Nested read-modify-write of `UiState.tips` — `updateUiState` shallow-merges
 *  top-level keys only, so the `seen` writer (tips) and the `tourDone` writer
 *  (tour) must go through one merge helper or they wipe each other. */
export function updateTipsState(store: Store, patch: { seen?: string[]; tourDone?: boolean }): void {
  const cur = store.api.loadUiState()?.tips ?? {};
  store.api.updateUiState({ tips: { ...cur, ...patch } });
}

/** Extra suppression injected by the tour module (tour running or invite up)
 *  — kept as a hook rather than an import so tips.ts has no dependency on tour.ts. */
let extraSuppression: (() => boolean) | null = null;
export function setTipSuppression(fn: (() => boolean) | null): void { extraSuppression = fn; }

export class TipManager {
  private queue: TipQueue;
  private toast: HTMLElement | null = null;
  private timer = 0;
  private timerStart = 0;
  private remaining = AUTO_DISMISS_MS;
  private warned = false;
  private unsub: (() => void) | null = null;

  constructor(private store: Store) {
    this.queue = new TipQueue(store.api.loadUiState()?.tips?.seen);
    this.unsub = store.onUiEvent((name) => { if (TIP_IDS.has(name)) this.show(name); });
  }

  dispose() { this.unsub?.(); this.unsub = null; this.teardown(); }

  enabled(): boolean { return this.store.state.options.showTips !== false; }

  setEnabled(on: boolean) {
    this.store.setOptions({ showTips: on });
    if (!on) { this.queue.cancel(); this.teardown(); }
  }

  /** Reset = fresh onboarding: clears seen tips AND the tour-done flag, so the
   *  invite re-fires next run ("show me everything again" semantics). */
  reset() { this.queue.clearSeen(); updateTipsState(this.store, { seen: [], tourDone: false }); }

  /** Drops the visible tip and the queue without marking seen — used when the
   *  tour starts so no two floating elements collide (T5). */
  dismiss() { this.queue.cancel(); this.teardown(); }

  /** Suppression (3e): shared onboarding probes + enabled + tour/invite gate. */
  private suppressed(): boolean {
    if (!this.enabled()) return true;
    if (suppressedForOnboarding(this.store)) return true;
    if (extraSuppression?.()) return true;
    return false;
  }

  show(id: string) {
    if (this.suppressed()) return;
    const show = this.queue.push(id);
    if (show) this.render(show);
  }

  /** Got it / × / timer — only "Got it" marks seen. */
  private finish(ack: boolean) {
    const next = this.queue.resolve(ack);
    if (ack) this.persist();
    this.teardown();
    if (next && !this.suppressed()) this.render(next);
  }

  private persist() {
    const seen = this.queue.seenIds;
    updateTipsState(this.store, { seen });
    // Transports swallow save errors — detect failure by read-back (P2).
    const rb = this.store.api.loadUiState()?.tips?.seen;
    if (!this.warned && (!Array.isArray(rb) || rb.length !== seen.length)) {
      this.warned = true;
      console.warn("tips: seen-state could not be persisted — tips reset when this session ends");
    }
  }

  private render(id: string) {
    this.teardown();
    const gotIt = el("button", { class: "om-tip-btn primary", onClick: () => this.finish(true) }, ["Got it"]);
    const dontShow = el("button", { class: "om-tip-btn", title: "Turn off tips (Help → Show Tips re-enables)",
      onClick: () => { this.setEnabled(false); } }, ["Don't show tips"]);
    const close = el("button", { class: "om-tip-close", "aria-label": "Dismiss tip", title: "Dismiss — the tip may return",
      onClick: () => this.finish(false) }, ["×"]);
    this.toast = el("div", { class: "om-tip", role: "status", "aria-live": "polite",
      onPointerenter: () => this.pause(), onPointerleave: () => this.resume(),
      onFocusin: () => this.pause(), onFocusout: () => this.resume() }, [
      el("span", { class: "om-tip-icon", html: materialIconSvg("info") }),
      el("span", { class: "om-tip-text" }, [TEXT_BY_ID.get(id) ?? id]),
      gotIt, dontShow, close,
    ]);
    document.body.appendChild(this.toast);
    this.startTimer(AUTO_DISMISS_MS);
  }

  private teardown() {
    this.pause();
    this.toast?.remove();
    this.toast = null;
  }

  private startTimer(ms: number) {
    this.remaining = ms;
    this.timerStart = Date.now();
    this.timer = window.setTimeout(() => this.finish(false), ms);
  }
  private pause() {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = 0;
    this.remaining -= Date.now() - this.timerStart;
  }
  private resume() {
    if (this.timer || !this.toast) return;
    this.startTimer(Math.max(500, this.remaining));
  }
}

let mgr: TipManager | null = null;

/** Called once at mount; subscribes the manager to store UI events. */
export function initTips(store: Store): TipManager {
  mgr?.dispose();
  mgr = new TipManager(store);
  return mgr;
}
export function tipsEnabled(): boolean { return mgr?.enabled() ?? false; }
export function setTipsEnabled(on: boolean) { mgr?.setEnabled(on); }
export function resetTips() { mgr?.reset(); }
/** Drops any visible/queued tip without marking seen — the tour calls this on start. */
export function dismissTip() { mgr?.dismiss(); }
