import { Store } from "../state";
import { el, clear } from "../dom";
import { inputDialog, confirmDialog, alertDialog } from "./dialogs";

/** Timeline — right dock showing checkpoints/snapshots.
 *  Mirrors lib_timelinegui/panel.py. */
export class Timeline {
  constructor(private store: Store) {}
  private selectedSnapshot: string | null = null;

  render(): HTMLElement {
    const panel = el("div", { class: "dock" });
    panel.appendChild(el("div", { class: "dock-header" }, ["Timeline"]));
    const content = el("div", { class: "dock-content" });

    // toolbar
    const toolbar = el("div", { class: "timeline-toolbar" });
    const checkpointBtn = el("button", { class: "tb-btn" }, ["Checkpoint"]);
    checkpointBtn.addEventListener("click", () => this.createCheckpoint());
    const dumpBtn = el("button", { class: "tb-btn" }, ["Dump State"]);
    dumpBtn.addEventListener("click", () => this.dumpState());
    toolbar.appendChild(checkpointBtn);
    toolbar.appendChild(dumpBtn);
    content.appendChild(toolbar);

    // snapshot list
    const list = el("div", { class: "timeline-list" });
    content.appendChild(list);

    // info panel
    const info = el("div", { class: "timeline-info" });
    content.appendChild(info);

    panel.appendChild(content);
    this.refresh(list, info);
    return panel;
  }

  private async refresh(list: HTMLElement, info: HTMLElement) {
    clear(list);
    clear(info);
    try {
      const snapshots = await this.store.api.timelineSnapshots();
      const snaps = Array.isArray(snapshots) ? snapshots : (snapshots?.snapshots || []);
      if (!snaps.length) { list.appendChild(el("div", { class: "muted", style: { padding: "8px" } }, ["No checkpoints yet. Click \"Checkpoint\" to create one."])); return; }
      for (const snap of snaps) {
        const item = el("div", { class: "timeline-item" + (this.selectedSnapshot === snap.snapshot_id ? " active" : "") }, [
          el("div", {}, [snap.description || "(unnamed)"]),
          el("div", { class: "muted", style: { fontSize: "10px" } }, [snap.created_at ? new Date(snap.created_at).toLocaleString() : ""]),
        ]);
        item.addEventListener("click", () => { this.selectedSnapshot = snap.snapshot_id; this.showInfo(info, snap); this.refresh(list, info); });
        item.addEventListener("dblclick", () => this.restoreCheckpoint(snap.snapshot_id, snap.description));
        item.addEventListener("contextmenu", (e) => { e.preventDefault(); this.showSnapshotMenu(e, snap, list, info); });
        list.appendChild(item);
      }
    } catch (e) {
      list.appendChild(el("div", { class: "muted" }, [`Timeline unavailable: ${e}`]));
    }
  }

  private showInfo(info: HTMLElement, snap: any) {
    clear(info);
    const addRow = (label: string, value: any) => info.appendChild(el("div", { class: "info-row" }, [el("span", { class: "info-label" }, [label]), el("span", { class: "info-value" }, [String(value || "—")])]));
    addRow("Title", snap.description);
    addRow("ID", snap.snapshot_id?.slice(0, 12));
    addRow("Branch", snap.branch_name);
    addRow("Parent", snap.parent_id?.slice(0, 12));
    addRow("Created", snap.created_at ? new Date(snap.created_at).toLocaleString() : "—");
    const restoreBtn = el("button", { class: "tb-btn", style: { marginTop: "4px" } }, ["Restore"]);
    restoreBtn.addEventListener("click", () => this.restoreCheckpoint(snap.snapshot_id, snap.description));
    info.appendChild(restoreBtn);
  }

  private async createCheckpoint() {
    const desc = await inputDialog("New Checkpoint", "", "Checkpoint description");
    if (!desc || !desc.trim()) return;
    try {
      await this.store.api.checkpoint(desc.trim());
      this.refresh(document.querySelector(".timeline-list") as HTMLElement, document.querySelector(".timeline-info") as HTMLElement);
    } catch (e: any) { await alertDialog("Checkpoint Failed", e?.message || String(e)); }
  }

  private async restoreCheckpoint(snapshotId: string, desc?: string) {
    if (!(await confirmDialog("Restore Checkpoint", `Restore checkpoint "${desc || snapshotId.slice(0, 8)}"? Current state will be replaced.`, "Restore", true))) return;
    try {
      await this.store.api.restoreCheckpoint(snapshotId);
      await this.store.refreshModel();
      await this.store.refreshRules();
      if (this.store.state.activeView) await this.store.loadView(this.store.state.activeView.viewId);
    } catch (e: any) { await alertDialog("Restore Failed", e?.message || String(e)); }
  }

  private showSnapshotMenu(e: MouseEvent, snap: any, list: HTMLElement, info: HTMLElement) {
    const existing = document.querySelector(".ctx-menu");
    if (existing) existing.remove();
    const menu = el("div", { class: "ctx-menu" });
    const addItem = (label: string, fn: () => void) => {
      const item = el("div", { class: "ctx-item" }, [label]);
      item.addEventListener("click", () => { menu.remove(); fn(); });
      menu.appendChild(item);
    };
    addItem("Restore", () => this.restoreCheckpoint(snap.snapshot_id, snap.description));
    addItem("Rename…", async () => { const n = await inputDialog("Rename Checkpoint", snap.description, "New description"); if (n) this.store.api.renameCheckpoint(snap.snapshot_id, n).then(() => this.refresh(list, info)); });
    addItem("Delete", async () => { if (await confirmDialog("Delete Checkpoint", "Delete this checkpoint?", "Delete", true)) this.store.api.deleteCheckpoint(snap.snapshot_id).then(() => this.refresh(list, info)); });
    menu.style.left = e.clientX + "px";
    menu.style.top = e.clientY + "px";
    document.body.appendChild(menu);
    const close = (ev: MouseEvent) => { if (!menu.contains(ev.target as Node)) { menu.remove(); document.removeEventListener("click", close); } };
    setTimeout(() => document.addEventListener("click", close), 0);
  }

  private async dumpState() {
    try {
      const snapshots = await this.store.api.timelineSnapshots();
      console.log("=== Timeline Dump State ===");
      console.log(JSON.stringify(snapshots, null, 2));
      await alertDialog("State Dumped", "State dumped to browser console.");
    } catch (e) { await alertDialog("Dump Failed", String(e)); }
  }
}
