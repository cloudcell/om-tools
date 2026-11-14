import { Store } from "../state";
import { el, clear, attachTooltip, NOT_IN_MVP_TITLE } from "../dom";
import { RuleDTO } from "../api";
import { confirmDialog, alertDialog } from "./dialogs";
import { materialIconSvg } from "../menuIcons";
import { RULE_CHANNELS, computeRuleInfos, toggleChannel, type RuleInfo } from "../ruleInfo";

/** RulePanel — bottom panel with 3 tabs: Rules, Calculation Flow, Circular References.
 *  Mirrors lib_gui/rule_panel.py + lib_gui/calculation_flow_panel.py + lib_gui/circular_refs_panel.py. */
export class RulePanel {
  constructor(private store: Store) {}
  /** Set by AppShell: open the panel when it is collapsed to its tab row and a tab is clicked. */
  onExpand?: () => void;
  private activeTab = "rules";
  private activeCubeId: string | null = null;
  /** Channel pills in use (Qt `ChannelFilterBar.selected_channels`); empty = all channels. */
  private selectedChannels = new Set<string>();
  /** Cubes whose `cube_detail` is being loaded (the mask and the `@` slot need the dimension order). */
  private loadingCubes = new Set<string>();
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
      if (!off) t.addEventListener("click", () => {
        this.activeTab = id;
        if (this.store.state.layout.rulePanelCollapsed) this.onExpand?.();
        this.refresh(panel);
      });
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
    const collapsed = this.store.state.layout.rulePanelCollapsed;
    panel.querySelectorAll(".lower-tab").forEach((t, i) => {
      t.classList.toggle("active", tabNames[i][0] === this.activeTab);
      if (!disabledTabs.has(tabNames[i][0])) (t as HTMLElement).title = collapsed ? `Show ${tabNames[i][1]}` : tabNames[i][1];
    });
    // Collapsed to its tab row (T-045): render nothing, so Calculation Flow does not trace cells unseen.
    if (collapsed) return;

    if (this.activeTab === "rules") this.renderRules(content);
    else if (this.activeTab === "calcflow") this.renderCalcFlow(content);
    else if (this.activeTab === "circrefs") this.renderCircRefs(content);
  }

  // ---- Rules tab ----
  private renderRules(content: HTMLElement) {
    const v = this.store.state.activeView;
    this.activeCubeId = v?.cubeId || null;
    // Qt rule_panel.rebuild: rules in rule_order (evaluation order), then any the order does not list
    const order = this.store.state.ruleOrder;
    const pos = (id: string) => { const i = order.indexOf(id); return i < 0 ? order.length : i; };
    const rules = this.store.state.rules
      .filter((r) => !this.activeCubeId || r.cube_id === this.activeCubeId)
      .map((r, i) => ({ r, i })).sort((a, b) => pos(a.r.id) - pos(b.r.id) || a.i - b.i).map((x) => x.r);
    const cubeName = v ? this.store.state.cubes.find((c) => c.id === v.cubeId)?.name : "";

    // Mask, specificity and precedence need the dimension order of the cube: load it once, then redraw.
    const dimIds = this.activeCubeId ? this.store.cubeDimensionIds(this.activeCubeId) : null;
    const panel = content.parentElement as HTMLElement;
    if (this.activeCubeId && !this.store.cubeCache.has(this.activeCubeId) && !this.loadingCubes.has(this.activeCubeId)) {
      const cubeId = this.activeCubeId;
      this.loadingCubes.add(cubeId);
      this.store.ensureCubeDetail(cubeId).then(() => {
        this.loadingCubes.delete(cubeId);
        if (panel.isConnected && this.activeCubeId === cubeId) this.refresh(panel);
      });
    }
    const infos = computeRuleInfos(rules, { dimIds, hasCube: !!this.activeCubeId, dimName: (id) => (id === "@" ? "@" : this.store.dimName(id)) });
    const counts = new Map<string, number>();
    for (const info of infos) counts.set(info.channel, (counts.get(info.channel) || 0) + 1);

    // header (Qt: "Rules: <cube>" — the list is the cube's rules, not the view's; the middle label names the filter)
    const filterLabel = this.selectedChannels.size ? [...this.selectedChannels].sort().join(", ") : "all channels";
    const header = el("div", { class: "rule-header" }, [
      el("span", { class: "rule-title" }, ["Rules" + (cubeName ? `: ${cubeName}` : "")]),
      el("span", { class: "rule-filter" }, [filterLabel]),
      el("span", { class: "rule-count" }, [`${rules.length} total`]),
    ]);
    content.appendChild(header);

    // Channel pills (Qt `ChannelFilterBar`): a filter on the `@` system dimension, not on cubes (issue #3).
    // Click selects one channel (click again clears), Ctrl/Cmd+click adds or removes; none selected = all rules.
    // Qt disables the bar while a rule is edited.
    const filterBar = el("div", { class: "channel-filter", role: "group", "aria-label": "Filter rules by channel" });
    for (const ch of RULE_CHANNELS) {
      const n = counts.get(ch.id) || 0, on = this.selectedChannels.has(ch.id);
      const short = ch.id.replace("@.", "");
      const pill = el("button", {
        class: "channel-pill" + (on ? " active" : "") + (n === 0 ? " empty" : ""), type: "button",
        "aria-label": `${short}: ${n} rules`, "aria-pressed": on ? "true" : "false",
        html: materialIconSvg(ch.icon, 14),
      }) as HTMLButtonElement;
      attachTooltip(pill, `${short}: ${n} rule${n === 1 ? "" : "s"}`);   // themed, not the native title tooltip
      pill.appendChild(el("span", { class: "pill-count" }, [n < 100 ? String(n) : "99+"]));
      pill.disabled = this.editingRuleId !== null;
      pill.addEventListener("click", (e) => { this.selectedChannels = toggleChannel(this.selectedChannels, ch.id, e.ctrlKey || e.metaKey); this.refresh(panel); });
      filterBar.appendChild(pill);
    }
    content.appendChild(filterBar);

    const shown = rules.map((rule, i) => ({ rule, info: infos[i] })).filter((x) => !this.selectedChannels.size || this.selectedChannels.has(x.info.channel));
    const list = el("div", { class: "rule-list" });
    for (const x of shown) list.appendChild(this.renderRuleRow(x.rule, x.info));
    if (!shown.length) list.appendChild(el("div", { class: "muted", style: { padding: "8px" } }, [rules.length ? "No rules in the selected channels." : "No rules. Use the rule bar above to create one."]));
    content.appendChild(list);
  }

  private renderRuleRow(rule: RuleDTO, info: RuleInfo): HTMLElement {
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

    // Two lines as in Qt: the rule, then its precedence status; the tooltip has mask, specificity and the precedence rules.
    const row = el("div", { class: "rule-row" });
    attachTooltip(row, info.tooltip);   // themed tooltip: a native title is dark inside a dark VS Code even in the light theme
    const grip = el("span", { class: "rule-grip", draggable: "true" }, ["⣿"]);
    grip.addEventListener("dragstart", (e) => { e.dataTransfer!.setData("text/rule-id", rule.id); e.dataTransfer!.effectAllowed = "move"; });
    row.appendChild(grip);

    row.appendChild(el("span", { class: "rule-num" }, [`${info.number}.`]));

    const body = el("div", { class: "rule-body" });
    const line = el("div", { class: "rule-line" }, [el("span", { class: "rule-text" }, [this.ruleToText(rule)])]);
    if (rule.is_anchored) line.appendChild(el("span", { class: "rule-anchored" }, ["⚓"]));
    body.appendChild(line);
    body.appendChild(el("div", { class: "rule-status" }, [info.status]));
    row.appendChild(body);

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
    return `${this.ruleLhs(rule)} = ${rule.expression}`;
  }

  /** Qt `RulePanel._format_rule_lhs`, targets branch: the text must survive `rule_target_resolve`
   *  when edited back. Several targets go in brackets — "Month.*, Metric.Price" without them
   *  resolves to the dimension "Month.*, Metric". All wildcards → "Cube::*.*". */
  private ruleLhs(rule: RuleDTO): string {
    const cubeName = this.store.state.cubes.find((c) => c.id === rule.cube_id)?.name || "";
    const wholeCube = cubeName ? `${cubeName}::*.*` : "*.*";
    const targets: [string, string][] = (rule.targets || []).filter((t: any) => Array.isArray(t) && t.length === 2);
    if (!targets.length) return wholeCube;
    let allWild = true;
    const parts = targets.map(([dim, item]) => {
      if (item === "*") return `${dim}.*`;
      allWild = false;
      return ["THIS", "PREV", "NEXT", "FIRST", "LAST"].includes(String(item).toUpperCase()) ? `${dim}[${item}]` : `${dim}.${item}`;
    });
    if (allWild) return wholeCube;
    const lhs = parts.length === 1 ? parts[0] : `[${parts.join(", ")}]`;
    return (rule.is_anchored ? "$" : "") + lhs;
  }

  /** Qt `_on_rule_edited`: split at the first "=", "$" marks an anchored rule, resolve the LHS, update_rule.
   *  Unchanged text sends nothing. */
  private async commitRuleEdit(rule: RuleDTO, text: string) {
    this.editingRuleId = null;
    const m = text.trim().match(/^=?\s*(.*?)\s*=\s*(.+)$/);
    if (!m || text.trim() === this.ruleToText(rule)) { this.refresh(document.querySelector(".rule-panel") as HTMLElement); return; }
    let lhs = m[1].trim();
    const rhs = m[2].trim();
    const anchored = lhs.startsWith("$");
    if (anchored) lhs = lhs.slice(1).trim();
    try {
      const resolved = await this.store.api.ruleTargetResolve(rule.cube_id, lhs);
      if (resolved?.error || !resolved?.targets?.length) throw new Error(resolved?.error || `Cannot resolve rule target "${lhs}"`);
      await this.store.api.updateRule(rule.id, resolved.targets, rhs, anchored);
    } catch (e: any) {
      await alertDialog("Rule error", e?.message || String(e));
      this.refresh(document.querySelector(".rule-panel") as HTMLElement);
      return;
    }
    await this.store.afterRuleChange();
  }

  private async deleteRule(rule: RuleDTO) {
    if (!(await confirmDialog("Delete Rule", `Delete rule "${this.ruleToText(rule)}"?`, "Delete", true))) return;
    try { await this.store.api.deleteRule(rule.id); }
    catch (e: any) { await alertDialog("Delete rule failed", e?.message || String(e)); await this.store.refreshRules(); return; }
    await this.store.afterRuleChange("all");
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
    addItem("Delete", () => this.deleteRule(rule));
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
    // Order is precedence: a reorder can change values, so recalc like any other rule change
    try { await this.store.api.setRuleOrder(order); }
    catch (e: any) { await alertDialog("Reorder rules failed", e?.message || String(e)); await this.store.refreshRules(); return; }
    await this.store.afterRuleChange("all");
  }

  // ---- Calculation Flow tab ----
  // Mirrors lib_gui/calculation_flow_panel.py (List and Graph modes). The engine
  // (trace_calculation_flow) returns a breadth-first list of nodes: each has
  // depth, source, expression, precedents/precedent_targets and
  // dependents/dependent_targets.
  private calcFlowDepth = 2;
  /** Last trace. Store notifies on every change (selection stats, status, …);
   *  re-query only when the cell, depth, rules or cell data change, or on Refresh. */
  private calcFlowCache: CalcFlowCache | null = null;
  private calcFlowMode: "list" | "graph" = "list";
  /** Graph canvas of the latest render: a pan that started before a re-render keeps moving the new one. */
  private cfCanvas: HTMLElement | null = null;

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
    const modeSelect = el("select", { title: "Show the trace as a list or as a graph" }) as HTMLSelectElement;
    for (const [val, label] of [["list", "List"], ["graph", "Graph"]]) {
      const opt = el("option", { value: val }, [label]) as HTMLOptionElement;
      opt.selected = val === this.calcFlowMode;
      modeSelect.appendChild(opt);
    }
    modeSelect.addEventListener("change", () => { this.calcFlowMode = modeSelect.value === "graph" ? "graph" : "list"; this.refresh(panel); });
    controls.appendChild(modeSelect);
    const refreshBtn = el("button", { class: "tb-btn", title: "Trace the selected cell again" }, ["Refresh"]);
    refreshBtn.addEventListener("click", () => { this.calcFlowCache = null; this.refresh(panel); });
    controls.appendChild(refreshBtn);
    content.appendChild(controls);

    if (!v || v.selectedRow < 0 || v.selectedCol < 0 || !v.cells) {
      content.appendChild(el("div", { class: "muted", style: { padding: "12px" } }, ["Select a data cell to inspect calculation flow."]));
      return;
    }
    const cell = v.cells.cells[v.selectedRow * v.colKeys.length + v.selectedCol];
    if (!cell?.addr) { content.appendChild(el("div", { class: "muted", style: { padding: "12px" } }, ["No cell address available."])); return; }

    const graph = this.calcFlowMode === "graph";
    const body = el("div", { class: graph ? "cf-graph" : "calc-flow-list" });
    content.appendChild(body);

    const key = `${v.cubeId}|${cell.addr.join("|")}|${this.calcFlowDepth}`;
    const rules = this.store.state.rules;
    const cached = this.calcFlowCache;
    if (cached && cached.key === key && cached.rules === rules && cached.cells === v.cells) {
      if (cached.error !== undefined) body.appendChild(el("div", { class: "muted" }, [`Trace unavailable: ${cached.error}`]));
      else if (!cached.flow) body.appendChild(el("div", { class: "grid-loading" }, ["Loading…"]));
      else if (!cached.flow.length) body.appendChild(el("div", { class: "muted" }, ["No flow information available."]));
      else {
        const root = cached.flow.find((n) => (n.depth || 0) === 0) || cached.flow[0];
        if (root.dependents_truncated) header.appendChild(el("span", { class: "cf-warning" }, [` — WARNING: TRUNCATED TO ${root.dependents_limit ?? "?"}`]));
        if (graph) this.renderFlowGraph(body, cached);
        else this.renderFlowList(body, cached.flow);
      }
      return;
    }

    const entry: CalcFlowCache = { key, rules, cells: v.cells };
    this.calcFlowCache = entry;
    body.appendChild(el("div", { class: "grid-loading" }, ["Loading…"]));
    this.store.api.diagnosticsCalculationFlow(v.cubeId, cell.addr, this.calcFlowDepth)
      .then((flow) => { entry.flow = Array.isArray(flow) ? flow : []; })
      .catch((e) => { entry.error = String(e?.message || e); })
      .then(() => { if (this.calcFlowCache === entry && this.activeTab === "calcflow") this.refresh(panel); });
  }

  private renderFlowList(list: HTMLElement, flow: FlowNode[]) {
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

  /** Graph mode, as `_render_graph` in lib_gui/calculation_flow_panel.py: cards in columns
   *  (precedents to the left of the traced cell, dependents to the right), curved arrows,
   *  hover highlights a node with its neighbours, click selects the cell,
   *  drag pans, wheel scrolls, Ctrl+wheel zooms. Pan/zoom survive re-renders (kept in the cache entry). */
  private renderFlowGraph(box: HTMLElement, entry: CalcFlowCache) {
    const { nodes, edges } = layoutFlowGraph(entry.flow || []);
    if (!nodes.length) { box.appendChild(el("div", { class: "muted" }, ["No flow information available."])); return; }
    const v = this.store.state.activeView;
    const cellIndex = this.currentViewCellIndex();

    const canvas = el("div", { class: "cf-graph-canvas" });
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "cf-graph-edges");
    canvas.appendChild(svg);
    box.appendChild(canvas);

    const adjacent = new Map<string, Set<string>>();
    for (const e of edges) {
      if (!adjacent.has(e.from)) adjacent.set(e.from, new Set());
      if (!adjacent.has(e.to)) adjacent.set(e.to, new Set());
      adjacent.get(e.from)!.add(e.to);
      adjacent.get(e.to)!.add(e.from);
    }
    const nodeEls = new Map<string, HTMLElement>();
    const edgeEls: { from: string; to: string; g: SVGGElement }[] = [];
    const highlight = (key: string | null) => {
      const near = (key && adjacent.get(key)) || new Set<string>();
      box.classList.toggle("hovering", key !== null);
      nodeEls.forEach((d, k) => { d.classList.toggle("primary", k === key); d.classList.toggle("secondary", near.has(k)); });
      for (const { from, to, g } of edgeEls) {
        const primary = key !== null && (from === key || to === key);
        g.classList.toggle("primary", primary);
        g.classList.toggle("secondary", !primary && (near.has(from) || near.has(to)));
      }
    };

    // 1. Cards. The box is in the document, so their heights can be measured right away.
    for (const n of nodes) {
      const r = n.row;
      const navigable = !!v && r.cube_id === v.cubeId && cellIndex.has(r.addr.join("|"));
      const card = el("div", {
        class: "cf-gnode" + (n.root ? " root" : "") + (navigable ? " link" : ""),
        tabindex: "0",
        style: { width: `${GRAPH_NODE_W}px` },
        title: `${r.addr_label}  [${r.source}]\n${navigable ? "Click or press Enter to select this cell" : "Not on the current page of this view"}`,
      }, [
        el("div", { class: "cf-gnode-title" }, [r.addr_label || "?"]),
        el("div", { class: "cf-gnode-source" }, [`[${r.source}]`]),
      ]);
      if (r.expression) card.appendChild(el("div", { class: "cf-gnode-expr" }, [`= ${r.expression}`]));
      if (navigable) {
        card.addEventListener("click", () => this.navigateToCell(r.cube_id, r.addr));
        card.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this.navigateToCell(r.cube_id, r.addr); }
        });
      }
      card.addEventListener("mouseenter", () => highlight(n.key));
      card.addEventListener("mouseleave", () => highlight(null));
      card.addEventListener("focus", () => highlight(n.key));
      card.addEventListener("blur", () => highlight(null));
      canvas.appendChild(card);
      nodeEls.set(n.key, card);
    }

    // 2. Positions: columns left to right, cards stacked top-down (nodes come sorted by column, label).
    const M = 16, GAP_X = 56, GAP_Y = 14;
    const rects = new Map<string, { x: number; y: number; w: number; h: number }>();
    const colBottom = new Map<number, number>();
    let width = 0, height = 0;
    for (const n of nodes) {
      const card = nodeEls.get(n.key)!;
      const h = card.offsetHeight || 56;
      const x = M + n.col * (GRAPH_NODE_W + GAP_X);
      const y = colBottom.get(n.col) ?? M;
      card.style.left = `${x}px`;
      card.style.top = `${y}px`;
      rects.set(n.key, { x, y, w: GRAPH_NODE_W, h });
      colBottom.set(n.col, y + h + GAP_Y);
      width = Math.max(width, x + GRAPH_NODE_W + M);
      height = Math.max(height, y + h + M);
    }
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(height));

    // 3. Arrows: right side of the source → left side of the target. A target in the same or an
    //    earlier column (cycles, diamonds) is entered from its right side.
    for (const e of edges) {
      const a = rects.get(e.from)!, b = rects.get(e.to)!;
      const sy = a.y + a.h / 2, ey = b.y + b.h / 2;
      let sx: number, ex: number, c1x: number, c2x: number;
      if (a.x + a.w < b.x) {
        sx = a.x + a.w; ex = b.x;
        const off = Math.max(40, (ex - sx) * 0.4);
        c1x = sx + off; c2x = ex - off;
      } else if (a.x === b.x) {
        sx = a.x + a.w; ex = b.x + b.w; c1x = sx + 40; c2x = ex + 40;
      } else {
        sx = a.x; ex = b.x + b.w;
        const off = Math.max(40, (sx - ex) * 0.4);
        c1x = sx - off; c2x = ex + off;
      }
      const g = document.createElementNS(SVG_NS, "g");
      g.setAttribute("class", `cf-edge ${e.dir}`);
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", `M${sx},${sy} C${c1x},${sy} ${c2x},${ey} ${ex},${ey}`);
      const ang = Math.atan2(0, ex - c2x);   // the last control point is level with the end
      const s = 8;
      const head = document.createElementNS(SVG_NS, "polygon");
      head.setAttribute("points", [
        [ex, ey],
        [ex - s * Math.cos(ang - Math.PI / 6), ey - s * Math.sin(ang - Math.PI / 6)],
        [ex - s * Math.cos(ang + Math.PI / 6), ey - s * Math.sin(ang + Math.PI / 6)],
      ].map((p) => p.join(",")).join(" "));
      g.appendChild(path);
      g.appendChild(head);
      svg.appendChild(g);
      edgeEls.push({ from: e.from, to: e.to, g });
    }

    // 4. Pan / zoom. Start with the traced cell in view; Fit and 100% buttons in the corner.
    const root = rects.get(nodes.find((n) => n.root)!.key)!;
    const initial = (): GraphView => {
      const bw = box.clientWidth, bh = box.clientHeight;
      const clampPos = (want: number, size: number, avail: number) => size <= avail ? 0 : Math.min(0, Math.max(avail - size, want));
      return { x: clampPos(bw / 2 - (root.x + root.w / 2), width, bw), y: clampPos(bh / 2 - (root.y + root.h / 2), height, bh), s: 1 };
    };
    const view = entry.view ?? (entry.view = initial());
    this.cfCanvas = canvas;
    const apply = () => { if (this.calcFlowCache === entry && this.cfCanvas) this.cfCanvas.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.s})`; };
    apply();

    const tools = el("div", { class: "cf-graph-tools" });
    const fitBtn = el("button", { class: "tb-btn", title: "Fit the whole graph into the panel" }, ["Fit"]);
    fitBtn.addEventListener("click", () => {
      const bw = box.clientWidth, bh = box.clientHeight;
      view.s = Math.max(GRAPH_MIN_ZOOM, Math.min(1, (bw - 8) / width, (bh - 8) / height));
      view.x = Math.max(0, (bw - width * view.s) / 2);
      view.y = Math.max(0, (bh - height * view.s) / 2);
      apply();
    });
    const resetBtn = el("button", { class: "tb-btn", title: "Actual size, centred on the selected cell" }, ["100%"]);
    resetBtn.addEventListener("click", () => { Object.assign(view, initial()); apply(); });
    tools.appendChild(fitBtn);
    tools.appendChild(resetBtn);
    box.appendChild(tools);

    box.addEventListener("mousedown", (e) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest(".cf-gnode, .cf-graph-tools")) return;
      e.preventDefault();
      const sx = e.clientX, sy = e.clientY, ox = view.x, oy = view.y;
      box.classList.add("panning");
      const move = (ev: MouseEvent) => { view.x = ox + ev.clientX - sx; view.y = oy + ev.clientY - sy; apply(); };
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        document.querySelector(".cf-graph")?.classList.remove("panning");
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    });
    box.addEventListener("wheel", (e) => {
      e.preventDefault();
      if (e.ctrlKey) {
        const r = box.getBoundingClientRect();
        const px = e.clientX - r.left, py = e.clientY - r.top;
        const s = Math.min(GRAPH_MAX_ZOOM, Math.max(GRAPH_MIN_ZOOM, view.s * (e.deltaY < 0 ? 1.18 : 1 / 1.18)));
        view.x = px - (px - view.x) * (s / view.s);
        view.y = py - (py - view.y) * (s / view.s);
        view.s = s;
      } else if (e.shiftKey) {
        view.x -= e.deltaY || e.deltaX;
      } else {
        view.x -= e.deltaX;
        view.y -= e.deltaY;
      }
      apply();
    }, { passive: false });
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
interface GraphView { x: number; y: number; s: number }
interface CalcFlowCache { key: string; rules: unknown; cells: unknown; flow?: FlowNode[]; error?: string; view?: GraphView }

// ---- Calculation Flow graph layout ----
const SVG_NS = "http://www.w3.org/2000/svg";
const GRAPH_NODE_W = 260;
const GRAPH_MIN_ZOOM = 0.25;
const GRAPH_MAX_ZOOM = 3;

interface GraphNode { key: string; row: FlowNode; col: number; root: boolean }
/** `from` feeds `to`. `up` comes from precedent_targets, `down` from dependent_targets. */
interface GraphEdge { from: string; to: string; dir: "up" | "down" }

const flowKey = (cubeId: string, addr: readonly string[]) => `${cubeId}|${addr.join("|")}`;

/** Columns as in Qt `_render_graph`: the traced cell in column 0, what it is computed from to the
 *  left, what depends on it to the right. Unlike Qt, an edge that appears both as a precedent of B
 *  and as a dependent of A is drawn once. Targets missing from the trace (unresolved references)
 *  are not drawn; Qt fetches them with extra queries, but the engine already returns every
 *  resolved target as a node. */
function layoutFlowGraph(flow: FlowNode[]): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const rows = new Map<string, FlowNode>();
  for (const r of flow) {
    if (!r.cube_id || !r.addr?.length) continue;
    const k = flowKey(r.cube_id, r.addr);
    if (!rows.has(k)) rows.set(k, r);
  }
  if (!rows.size) return { nodes: [], edges: [] };
  const rootRow = flow.find((r) => (r.depth || 0) === 0 && r.cube_id && r.addr?.length) || rows.values().next().value!;
  const rootKey = flowKey(rootRow.cube_id, rootRow.addr);

  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const add = (from: string, to: string, dir: GraphEdge["dir"]) => {
    if (from === to || !rows.has(from) || !rows.has(to) || seen.has(`${from}>${to}`)) return;
    seen.add(`${from}>${to}`);
    edges.push({ from, to, dir });
  };
  for (const [k, r] of rows) {
    for (const t of r.precedent_targets || []) if (t.cube_id && t.addr) add(flowKey(t.cube_id, t.addr), k, "up");
    for (const t of r.dependent_targets || []) if (t.cube_id && t.addr) add(k, flowKey(t.cube_id, t.addr), "down");
  }

  // Layers: BFS from the root (from feeds to ⇒ layer(to) = layer(from) + 1) …
  const layer = new Map<string, number>([[rootKey, 0]]);
  const links = new Map<string, { k: string; d: number }[]>();
  for (const e of edges) {
    if (!links.has(e.from)) links.set(e.from, []);
    if (!links.has(e.to)) links.set(e.to, []);
    links.get(e.from)!.push({ k: e.to, d: 1 });
    links.get(e.to)!.push({ k: e.from, d: -1 });
  }
  const queue = [rootKey];
  while (queue.length) {
    const k = queue.shift()!;
    for (const { k: nk, d } of links.get(k) || []) {
      if (layer.has(nk)) continue;
      layer.set(nk, layer.get(k)! + d);
      queue.push(nk);
    }
  }
  for (const [k, r] of rows) if (!layer.has(k)) layer.set(k, -(r.depth || 0));
  // … then push nodes apart until every edge points right: on the precedent side move the source
  // left, on the dependent side move the target right; the root stays put. Cycles stop at the pass limit.
  for (let pass = 0; pass < rows.size; pass++) {
    let moved = false;
    for (const e of edges) {
      const la = layer.get(e.from)!, lb = layer.get(e.to)!;
      if (la < lb) continue;
      const canFrom = e.from !== rootKey, canTo = e.to !== rootKey;
      if (canFrom && (lb <= 0 || !canTo)) layer.set(e.from, lb - 1);
      else if (canTo) layer.set(e.to, la + 1);
      else continue;
      moved = true;
    }
    if (!moved) break;
  }

  const cols = [...new Set(layer.values())].sort((a, b) => a - b);
  const nodes: GraphNode[] = [...rows].map(([k, row]) => ({ key: k, row, col: cols.indexOf(layer.get(k)!), root: k === rootKey }));
  nodes.sort((a, b) => a.col - b.col || (a.row.addr_label || "").localeCompare(b.row.addr_label || ""));
  return { nodes, edges };
}
