import { Store } from "../state";
import { el, clear, NOT_IN_MVP_TITLE } from "../dom";
import { RuleDTO } from "../api";
import { confirmDialog, alertDialog } from "./dialogs";

/** RulePanel — bottom panel with 3 tabs: Rules, Calculation Flow, Circular References.
 *  Mirrors lib_gui/rule_panel.py + lib_gui/calculation_flow_panel.py + lib_gui/circular_refs_panel.py. */
export class RulePanel {
  constructor(private store: Store) {}
  private activeTab = "rules";
  private activeCubeId: string | null = null;
  private channelFilter = "all";
  private editingRuleId: string | null = null;

  render(): HTMLElement {
    const panel = el("div", { class: "rule-panel" });
    const tabs = el("div", { class: "lower-tabs" });
    const tabNames = [["rules", "Rules"], ["calcflow", "Calculation Flow"], ["circrefs", "Circular References"]];
    for (const [id, label] of tabNames) {
      const off = disabledTabs.has(id);
      const t = el("div", {
        class: "lower-tab" + (id === this.activeTab ? " active" : "") + (off ? " disabled" : ""),
        title: off ? NOT_IN_MVP_TITLE : label,
      }, [label]);
      if (!off) t.addEventListener("click", () => { this.activeTab = id; this.refresh(panel); });
      tabs.appendChild(t);
    }
    panel.appendChild(tabs);
    const content = el("div", { class: "lower-content" });
    panel.appendChild(content);

    this.store.subscribe(() => this.refresh(panel));
    this.refresh(panel);
    return panel;
  }

  private refresh(panel: HTMLElement) {
    const content = panel.querySelector(".lower-content") as HTMLElement;
    if (!content) return;
    clear(content);
    // update tab active states
    panel.querySelectorAll(".lower-tab").forEach((t, i) => {
      t.classList.toggle("active", tabNames[i][0] === this.activeTab);
    });

    if (this.activeTab === "rules") this.renderRules(content);
    else if (this.activeTab === "calcflow") this.renderCalcFlow(content);
    else if (this.activeTab === "circrefs") this.renderCircRefs(content);
  }

  // ---- Rules tab ----
  private renderRules(content: HTMLElement) {
    const v = this.store.state.activeView;
    this.activeCubeId = v?.cubeId || null;
    const rules = this.store.state.rules.filter((r) => !this.activeCubeId || r.cube_id === this.activeCubeId);

    // header
    const header = el("div", { class: "rule-header" }, [
      el("span", { class: "rule-title" }, ["Rules" + (v ? `: ${v.viewName}` : "")]),
      el("span", { class: "rule-count" }, [`${rules.length} total`]),
    ]);
    content.appendChild(header);

    // channel filter pills
    const channels = ["all", ...new Set(rules.map((r) => r.cube_id))];
    const filterBar = el("div", { class: "channel-filter" });
    for (const ch of channels) {
      const name = ch === "all" ? "all" : this.store.state.cubes.find((c) => c.id === ch)?.name || ch.slice(0, 8);
      const pill = el("div", { class: "channel-pill" + (this.channelFilter === ch ? " active" : "") }, [name]);
      pill.addEventListener("click", () => { this.channelFilter = ch; this.refresh(content.parentElement as HTMLElement); });
      filterBar.appendChild(pill);
    }
    content.appendChild(filterBar);

    const filtered = this.channelFilter === "all" ? rules : rules.filter((r) => r.cube_id === this.channelFilter);
    const list = el("div", { class: "rule-list" });
    for (const rule of filtered) {
      list.appendChild(this.renderRuleRow(rule));
    }
    if (!filtered.length) list.appendChild(el("div", { class: "muted", style: { padding: "8px" } }, ["No rules. Use the rule bar above to create one."]));
    content.appendChild(list);
  }

  private renderRuleRow(rule: RuleDTO): HTMLElement {
    if (this.editingRuleId === rule.id) {
      const row = el("div", { class: "rule-row selected" });
      const input = el("input", { class: "rule-edit", type: "text", value: this.ruleToText(rule) }) as HTMLInputElement;
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); this.commitRuleEdit(rule, input.value); }
        else if (e.key === "Escape") { this.editingRuleId = null; this.refresh(document.querySelector(".rule-panel") as HTMLElement); }
      });
      input.addEventListener("blur", () => { if (this.editingRuleId === rule.id) this.commitRuleEdit(rule, input.value); });
      row.appendChild(input);
      setTimeout(() => input.focus(), 0);
      return row;
    }

    const row = el("div", { class: "rule-row" });
    const grip = el("span", { class: "rule-grip", draggable: "true" }, ["⣿"]);
    grip.addEventListener("dragstart", (e) => { e.dataTransfer!.setData("text/rule-id", rule.id); e.dataTransfer!.effectAllowed = "move"; });
    row.appendChild(grip);

    const text = el("span", { class: "rule-text" }, [this.ruleToText(rule)]);
    row.appendChild(text);

    if (rule.is_anchored) row.appendChild(el("span", { class: "rule-anchored" }, ["⚓"]));

    row.addEventListener("click", () => { /* select */ });
    row.addEventListener("contextmenu", (e) => { e.preventDefault(); this.showRuleContextMenu(e, rule); });
    row.addEventListener("dragover", (e) => { e.preventDefault(); row.style.borderTop = "2px solid var(--accent)"; });
    row.addEventListener("dragleave", () => { row.style.borderTop = ""; });
    row.addEventListener("drop", (e) => {
      e.preventDefault();
      row.style.borderTop = "";
      const draggedId = e.dataTransfer!.getData("text/rule-id");
      if (draggedId && draggedId !== rule.id) this.reorderRules(draggedId, rule.id);
    });

    return row;
  }

  private ruleToText(rule: RuleDTO): string {
    const lhs = rule.targets?.map((t: any) => Array.isArray(t) ? t.join(".") : String(t)).join(", ") || "";
    return `${lhs} = ${rule.expression}`;
  }

  private async commitRuleEdit(rule: RuleDTO, text: string) {
    this.editingRuleId = null;
    const eqIdx = text.indexOf("=");
    if (eqIdx < 0) return;
    const lhs = text.slice(0, eqIdx).trim();
    const rhs = text.slice(eqIdx + 1).trim();
    const anchored = lhs.startsWith("$");
    const cleanLhs = anchored ? lhs.slice(1) : lhs;
    try {
      const resolved = await this.store.api.ruleTargetResolve(rule.cube_id, cleanLhs);
      await this.store.api.updateRule(rule.id, resolved?.targets || [], rhs, anchored);
      this.store.markDirty();
      await this.store.refreshRules();
    } catch (e: any) { await alertDialog("Rule Edit Failed", e?.message || String(e)); }
  }

  private showRuleContextMenu(e: MouseEvent, rule: RuleDTO) {
    const existing = document.querySelector(".ctx-menu");
    if (existing) existing.remove();
    const menu = el("div", { class: "ctx-menu" });
    const addItem = (label: string, fn: () => void) => {
      const item = el("div", { class: "ctx-item" }, [label]);
      item.addEventListener("click", () => { menu.remove(); fn(); });
      menu.appendChild(item);
    };
    addItem("Edit…", () => { this.editingRuleId = rule.id; this.refresh(document.querySelector(".rule-panel") as HTMLElement); });
    addItem("Delete", async () => { if (await confirmDialog("Delete Rule", "Delete this rule?", "Delete", true)) this.store.api.deleteRule(rule.id).then(() => { this.store.markDirty(); this.store.refreshRules(); }); });
    addItem("Copy Rule", () => { try { navigator.clipboard.writeText(this.ruleToText(rule)); } catch {} });
    menu.style.left = e.clientX + "px";
    menu.style.top = e.clientY + "px";
    document.body.appendChild(menu);
    const close = (ev: MouseEvent) => { if (!menu.contains(ev.target as Node)) { menu.remove(); document.removeEventListener("click", close); } };
    setTimeout(() => document.addEventListener("click", close), 0);
  }

  private async reorderRules(draggedId: string, targetId: string) {
    const order = this.store.state.ruleOrder.length ? [...this.store.state.ruleOrder] : this.store.state.rules.map((r) => r.id);
    const fromIdx = order.indexOf(draggedId);
    const toIdx = order.indexOf(targetId);
    if (fromIdx < 0 || toIdx < 0) return;
    order.splice(fromIdx, 1);
    order.splice(toIdx, 0, draggedId);
    try { await this.store.api.setRuleOrder(order); this.store.markDirty(); await this.store.refreshRules(); } catch (e: any) { console.error("reorder", e); }
  }

  // ---- Calculation Flow tab ----
  // Mirrors lib_gui/calculation_flow_panel.py (list mode). The engine
  // (trace_calculation_flow) returns a breadth-first list of nodes: each has
  // depth, source, expression, precedents/precedent_targets and
  // dependents/dependent_targets.
  private calcFlowDepth = 2;
  /** Last trace. Store notifies on every change (selection stats, status, …);
   *  re-query only when the cell, depth, rules or cell data change, or on Refresh. */
  private calcFlowCache: CalcFlowCache | null = null;

  private renderCalcFlow(content: HTMLElement) {
    const panel = content.parentElement as HTMLElement;
    const v = this.store.state.activeView;
    const header = el("div", { class: "calc-flow-header" }, ["Calculation Flow"]);
    content.appendChild(header);

    const controls = el("div", { class: "perf-section" });
    controls.appendChild(el("label", {}, ["Depth: "]));
    const depthInput = el("input", { type: "number", value: String(this.calcFlowDepth), min: "1", max: "10", style: { width: "40px" } }) as HTMLInputElement;
    depthInput.addEventListener("change", () => {
      this.calcFlowDepth = Math.min(10, Math.max(1, parseInt(depthInput.value) || 2));
      this.refresh(panel);
    });
    controls.appendChild(depthInput);
    const refreshBtn = el("button", { class: "tb-btn" }, ["Refresh"]);
    refreshBtn.addEventListener("click", () => { this.calcFlowCache = null; this.refresh(panel); });
    controls.appendChild(refreshBtn);
    content.appendChild(controls);

    if (!v || v.selectedRow < 0 || v.selectedCol < 0 || !v.cells) {
      content.appendChild(el("div", { class: "muted", style: { padding: "12px" } }, ["Select a data cell to inspect calculation flow."]));
      return;
    }
    const cell = v.cells.cells[v.selectedRow * v.colKeys.length + v.selectedCol];
    if (!cell?.addr) { content.appendChild(el("div", { class: "muted", style: { padding: "12px" } }, ["No cell address available."])); return; }

    const list = el("div", { class: "calc-flow-list" });
    content.appendChild(list);

    const key = `${v.cubeId}|${cell.addr.join("|")}|${this.calcFlowDepth}`;
    const rules = this.store.state.rules;
    const cached = this.calcFlowCache;
    if (cached && cached.key === key && cached.rules === rules && cached.cells === v.cells) {
      if (cached.error !== undefined) list.appendChild(el("div", { class: "muted" }, [`Trace unavailable: ${cached.error}`]));
      else if (cached.flow) this.renderFlowList(list, header, cached.flow);
      else list.appendChild(el("div", { class: "grid-loading" }, ["Loading…"]));
      return;
    }

    const entry: CalcFlowCache = { key, rules, cells: v.cells };
    this.calcFlowCache = entry;
    list.appendChild(el("div", { class: "grid-loading" }, ["Loading…"]));
    this.store.api.diagnosticsCalculationFlow(v.cubeId, cell.addr, this.calcFlowDepth)
      .then((flow) => { entry.flow = Array.isArray(flow) ? flow : []; })
      .catch((e) => { entry.error = String(e?.message || e); })
      .then(() => { if (this.calcFlowCache === entry && this.activeTab === "calcflow") this.refresh(panel); });
  }

  private renderFlowList(list: HTMLElement, header: HTMLElement, flow: FlowNode[]) {
    if (!flow.length) { list.appendChild(el("div", { class: "muted" }, ["No flow information available."])); return; }

    const root = flow.find((n) => (n.depth || 0) === 0) || flow[0];
    if (root?.dependents_truncated) {
      header.appendChild(el("span", { class: "cf-warning" }, [` — WARNING: TRUNCATED TO ${root.dependents_limit ?? "?"}`]));
    }

    const cellIndex = this.currentViewCellIndex();
    for (const node of flow) {
      const pad = 8 + 16 * (node.depth || 0);
      const head = this.flowLine(`• ${node.addr_label || "?"}${node.source ? `  [${node.source}]` : ""}`,
        "cf-node" + ((node.depth || 0) === 0 ? " cf-root" : ""), pad, node.cube_id, node.addr, cellIndex);
      list.appendChild(head);
      if (node.expression) list.appendChild(this.flowLine(`= ${node.expression}`, "cf-expr", pad + 16));

      const section = (title: string, labels: string[] | undefined, targets: FlowTarget[] | undefined, dir: string, bullet: string) => {
        if (!labels?.length) return;
        list.appendChild(this.flowLine(title, `cf-section cf-${dir}`, pad + 16));
        labels.forEach((label, i) => {
          const t = targets?.[i];
          list.appendChild(this.flowLine(`${bullet} ${label}`, `cf-${dir}`, pad + 32, t?.cube_id, t?.addr, cellIndex));
        });
      };
      section("Upstream (precedents)", node.precedents, node.precedent_targets, "upstream", "↳");
      section("Downstream (dependents)", node.dependents, node.dependent_targets, "downstream", "↰");
    }
  }

  /** One list line. Clickable (selects the cell) when the address is on the current grid page. */
  private flowLine(text: string, cls: string, pad: number, cubeId?: string, addr?: string[], cellIndex?: Map<string, number>): HTMLElement {
    const line = el("div", { class: `calc-flow-entry ${cls}`, style: { paddingLeft: `${pad}px` } }, [text]);
    const v = this.store.state.activeView;
    if (cubeId && addr && cellIndex && v && cubeId === v.cubeId && cellIndex.has(addr.join("|"))) {
      line.classList.add("link");
      line.title = "Select this cell";
      line.addEventListener("click", () => this.navigateToCell(cubeId, addr));
    }
    return line;
  }

  /** addr ("a|b|c") → flat index into activeView.cells.cells. */
  private currentViewCellIndex(): Map<string, number> {
    const idx = new Map<string, number>();
    const cells = this.store.state.activeView?.cells?.cells || [];
    cells.forEach((c, i) => { if (c?.addr) idx.set(c.addr.join("|"), i); });
    return idx;
  }

  /** Select the cell in the active view. Cells of other cubes or other page selections are not navigable yet. */
  private navigateToCell(cubeId: string, addr: string[]) {
    const v = this.store.state.activeView;
    if (!v || v.cubeId !== cubeId || !v.colKeys.length) return;
    const i = this.currentViewCellIndex().get(addr.join("|"));
    if (i === undefined) return;
    this.store.setSelectionFull(Math.floor(i / v.colKeys.length), i % v.colKeys.length, "cell", new Set<string>());
  }

  // ---- Circular References tab ----
  private circRefsDepth = 12;

  private renderCircRefs(content: HTMLElement) {
    const v = this.store.state.activeView;
    const header = el("div", { class: "calc-flow-header" }, ["Circular References"]);
    content.appendChild(header);

    const controls = el("div", { class: "perf-section" });
    controls.appendChild(el("label", {}, ["Depth: "]));
    const depthInput = el("input", { type: "number", value: String(this.circRefsDepth), min: "2", max: "100", style: { width: "40px" } }) as HTMLInputElement;
    depthInput.addEventListener("change", () => { this.circRefsDepth = parseInt(depthInput.value) || 12; this.refresh(content.parentElement as HTMLElement); });
    controls.appendChild(depthInput);
    const refreshBtn = el("button", { class: "tb-btn" }, ["Refresh"]);
    refreshBtn.addEventListener("click", () => this.refresh(content.parentElement as HTMLElement));
    controls.appendChild(refreshBtn);
    content.appendChild(controls);

    if (!v || v.selectedRow < 0 || v.selectedCol < 0 || !v.cells) {
      content.appendChild(el("div", { class: "muted", style: { padding: "12px" } }, ["Select a data cell to check for circular references."]));
      return;
    }
    const cell = v.cells.cells[v.selectedRow * v.colKeys.length + v.selectedCol];
    if (!cell?.addr) { content.appendChild(el("div", { class: "muted", style: { padding: "12px" } }, ["No cell address available."])); return; }

    const result = el("div", {});
    result.appendChild(el("div", { class: "grid-loading" }, ["Loading…"]));
    content.appendChild(result);

    this.store.api.diagnosticsCircularReferences(v.cubeId, cell.addr, this.circRefsDepth).then((circ) => {
      clear(result);
      if (!circ || !circ.cycles || !circ.cycles.length) { result.appendChild(el("div", { class: "muted", style: { padding: "12px" } }, ["No circular references detected."])); return; }
      const severity = circ.severity || "warning";
      result.appendChild(el("div", { class: "circ-refs-summary" }, [`Circular reference detected (${severity}) | cycles: ${circ.cycles.length}`]));

      // cycle picker
      const picker = el("div", { class: "circ-refs-cycle-picker" });
      const select = el("select") as HTMLSelectElement;
      circ.cycles.forEach((_: any, i: number) => select.appendChild(el("option", { value: String(i) }, [`Cycle ${i + 1} of ${circ.cycles.length}`])));
      picker.appendChild(el("label", {}, ["Cycle: "]));
      picker.appendChild(select);
      result.appendChild(picker);

      const nodesContainer = el("div", { class: "circ-refs-nodes" });
      result.appendChild(nodesContainer);

      const loadCycle = (idx: number) => {
        clear(nodesContainer);
        const cycle = circ.cycles[idx];
        if (!cycle) return;
        const nodes = cycle.nodes || cycle.path || cycle || [];
        const path = el("div", { class: "circ-refs-path" }, [(cycle.path_text || nodes.map((n: any, i: number) => `${i + 1}. ${n.addr_label || n.label || n.addr?.join("|") || "?"} [${n.source || ""}]`).join("\n"))]);
        nodesContainer.appendChild(path);
        for (const [i, node] of nodes.entries()) {
          const entry = el("div", { class: "circ-refs-node" }, [`${i + 1}. ${node.addr_label || node.label || node.addr?.join("|") || "?"} [${node.source || ""}]`]);
          if (node.cube_id && node.addr) entry.addEventListener("click", () => this.navigateToCell(node.cube_id, node.addr));
          nodesContainer.appendChild(entry);
        }
      };
      select.addEventListener("change", () => loadCycle(parseInt(select.value)));
      loadCycle(0);
    }).catch((e) => { clear(result); result.appendChild(el("div", { class: "muted" }, [`Trace unavailable: ${e?.message || e}`])); });
  }
}

const tabNames = [["rules", "Rules"], ["calcflow", "Calculation Flow"], ["circrefs", "Circular References"]];
/** Tabs outside the MVP preview: shown greyed out, not clickable. */
const disabledTabs = new Set(["circrefs"]);

/** Target of a precedent/dependent link; unresolved references have only a label. */
interface FlowTarget { label: string; cube_id?: string; addr?: string[] }
/** One node of `diagnostics_calculation_flow` (lib_openm/_engine_core.py: trace_calculation_flow). */
interface FlowNode {
  cube_id: string; cube_name?: string; addr: string[]; addr_label: string;
  depth: number; source: string; expression: string | null;
  precedents?: string[]; precedent_targets?: FlowTarget[];
  dependents?: string[]; dependent_targets?: FlowTarget[];
  dependents_truncated?: boolean; dependents_limit?: number | null;
}
interface CalcFlowCache { key: string; rules: unknown; cells: unknown; flow?: FlowNode[]; error?: string }
