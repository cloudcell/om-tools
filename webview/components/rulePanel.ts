import { Store } from "../state";
import { el, clear } from "../dom";
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
      const t = el("div", { class: "lower-tab" + (id === this.activeTab ? " active" : "") }, [label]);
      t.addEventListener("click", () => { this.activeTab = id; this.refresh(panel); });
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
  private calcFlowDepth = 3;

  private renderCalcFlow(content: HTMLElement) {
    const v = this.store.state.activeView;
    const header = el("div", { class: "calc-flow-header" }, ["Calculation Flow"]);
    content.appendChild(header);

    const controls = el("div", { class: "perf-section" });
    controls.appendChild(el("label", {}, ["Depth: "]));
    const depthInput = el("input", { type: "number", value: String(this.calcFlowDepth), min: "1", max: "20", style: { width: "40px" } }) as HTMLInputElement;
    depthInput.addEventListener("change", () => { this.calcFlowDepth = parseInt(depthInput.value) || 3; this.refresh(content.parentElement as HTMLElement); });
    controls.appendChild(depthInput);
    const refreshBtn = el("button", { class: "tb-btn" }, ["Refresh"]);
    refreshBtn.addEventListener("click", () => this.refresh(content.parentElement as HTMLElement));
    controls.appendChild(refreshBtn);
    content.appendChild(controls);

    if (!v || v.selectedRow < 0 || v.selectedCol < 0 || !v.cells) {
      content.appendChild(el("div", { class: "muted", style: { padding: "12px" } }, ["Select a data cell to inspect calculation flow."]));
      return;
    }
    const cell = v.cells.cells[v.selectedRow * v.colKeys.length + v.selectedCol];
    if (!cell?.addr) { content.appendChild(el("div", { class: "muted", style: { padding: "12px" } }, ["No cell address available."])); return; }

    const list = el("div", { class: "calc-flow-list" });
    list.appendChild(el("div", { class: "grid-loading" }, ["Loading…"]));
    content.appendChild(list);

    this.store.api.diagnosticsCalculationFlow(v.cubeId, cell.addr, this.calcFlowDepth).then((flow) => {
      clear(list);
      if (!flow) { list.appendChild(el("div", { class: "muted" }, ["No flow information available."])); return; }
      const precedents = flow.precedents || flow.upstream || [];
      const dependents = flow.dependents || flow.downstream || [];
      if (precedents.length) {
        list.appendChild(el("div", { class: "calc-flow-header" }, ["Upstream (precedents)"]));
        for (const p of precedents) list.appendChild(this.flowEntry(p, "upstream"));
      }
      if (dependents.length) {
        list.appendChild(el("div", { class: "calc-flow-header" }, ["Downstream (dependents)"]));
        for (const d of dependents) list.appendChild(this.flowEntry(d, "downstream"));
      }
      if (!precedents.length && !dependents.length) list.appendChild(el("div", { class: "muted" }, ["No flow information available."]));
    }).catch((e) => { clear(list); list.appendChild(el("div", { class: "muted" }, [`Trace unavailable: ${e?.message || e}`])); });
  }

  private flowEntry(node: any, dir: string): HTMLElement {
    const label = node.addr_label || node.label || node.addr?.join("|") || "?";
    const source = node.source || "";
    const expr = node.expression ? ` = ${node.expression}` : "";
    const entry = el("div", { class: `calc-flow-entry cf-${dir}` }, [
      el("span", { class: `cf-depth-${node.depth || 0}` }, [`${dir === "upstream" ? "↳" : "↰"} ${label} [${source}]${expr}`]),
    ]);
    if (node.cube_id && node.addr) entry.addEventListener("click", () => this.navigateToCell(node.cube_id, node.addr));
    return entry;
  }

  private navigateToCell(cubeId: string, addr: string[]) {
    // Find a view for this cube and navigate to the cell
    const view = this.store.state.views.find((v) => {
      const vDetail = this.store.state.activeView;
      return vDetail?.cubeId === cubeId;
    });
    if (view) this.store.loadView(view.id);
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
