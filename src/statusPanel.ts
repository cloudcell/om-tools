// The OM Core side panel (T-062): one row per part the engine needs, refreshed on events and polled while visible.

import * as vscode from "vscode";
import { StatusRow, StatusSnapshot, buildStatusRows } from "./engineStatus";

/** The runtime does not report that it started or exited: while the panel is visible it is pinged this often. */
export const STATUS_POLL_MS = 10_000;

export class StatusPanel implements vscode.TreeDataProvider<StatusRow>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly view: vscode.TreeView<StatusRow>;
  private rows: StatusRow[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private again = false;

  constructor(viewId: string, private readonly snapshot: () => Promise<StatusSnapshot>) {
    this.view = vscode.window.createTreeView(viewId, { treeDataProvider: this });
    this.view.onDidChangeVisibility(() => this.syncPolling());
    this.syncPolling();
    void this.refresh();
  }

  getTreeItem(r: StatusRow): vscode.TreeItem {
    const item = new vscode.TreeItem(r.label, vscode.TreeItemCollapsibleState.None);
    item.id = r.id;
    item.description = r.description;
    item.tooltip = r.tooltip;
    item.iconPath = new vscode.ThemeIcon(r.icon, r.color ? new vscode.ThemeColor(r.color) : undefined);
    return item;
  }

  getChildren(element?: StatusRow): StatusRow[] {
    return element ? [] : this.rows;
  }

  /** Re-reads everything. Calls during a refresh do not run in parallel: they cause one more round after it. */
  refresh(): Promise<void> {
    if (this.running) { this.again = true; return this.running; }
    this.running = (async () => {
      do {
        this.again = false;
        try {
          this.rows = buildStatusRows(await this.snapshot());
        } catch (e: any) {
          this.rows = [{ id: "runtime", label: "Status", description: "unavailable", tooltip: String(e?.message || e), icon: "error" }];
        }
        this.changed.fire();
      } while (this.again);
    })().finally(() => { this.running = null; });
    return this.running;
  }

  private syncPolling(): void {
    if (this.view.visible && !this.timer) {
      this.timer = setInterval(() => void this.refresh(), STATUS_POLL_MS);
      void this.refresh();
    } else if (!this.view.visible && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.view.dispose();
    this.changed.dispose();
  }
}
