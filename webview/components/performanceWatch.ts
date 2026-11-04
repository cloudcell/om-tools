import { Store } from "../state";
import { el, clear } from "../dom";

/** PerformanceWatch — right dock showing engine diagnostics.
 *  Mirrors lib_gui/performance_watch.py. */
export class PerformanceWatch {
  constructor(private store: Store) {}
  private timer: any = null;

  render(): HTMLElement {
    const panel = el("div", { class: "dock" });
    panel.appendChild(el("div", { class: "dock-header" }, ["Performance Watch"]));
    const content = el("div", { class: "dock-content" });

    // toggles
    const depToggle = el("input", { type: "checkbox" }) as HTMLInputElement;
    depToggle.checked = this.store.state.depTrackingEnabled;
    depToggle.addEventListener("change", () => this.store.api.setDependencyTracking(depToggle.checked).then(() => { this.store.state.depTrackingEnabled = depToggle.checked; this.store.notify(); }));
    const mtToggle = el("input", { type: "checkbox" }) as HTMLInputElement;
    mtToggle.checked = this.store.state.mtEnabled;
    mtToggle.addEventListener("change", () => this.store.api.setMultithreadRecompute(mtToggle.checked).then(() => { this.store.state.mtEnabled = mtToggle.checked; this.store.notify(); }));

    content.appendChild(el("div", { class: "perf-section" }, [
      el("div", { class: "perf-toggle" }, [depToggle, el("label", {}, ["Enable incremental recompute"])]),
      el("div", { class: "perf-toggle" }, [mtToggle, el("label", {}, ["Enable multithreaded calculation"])]),
    ]));

    // refresh + reset buttons
    const btnRow = el("div", { class: "perf-section" });
    const refreshBtn = el("button", { class: "tb-btn" }, ["Refresh"]);
    refreshBtn.addEventListener("click", () => this.updateMetrics(content));
    const resetBtn = el("button", { class: "tb-btn" }, ["Reset Profiler"]);
    resetBtn.addEventListener("click", () => this.store.api.clearProfilerSnapshot().then(() => this.updateMetrics(content)));
    btnRow.appendChild(refreshBtn);
    btnRow.appendChild(resetBtn);
    content.appendChild(btnRow);

    // metrics container
    const metrics = el("div", { class: "perf-metrics" });
    content.appendChild(metrics);

    panel.appendChild(content);
    this.updateMetrics(content);

    return panel;
  }

  private async updateMetrics(container: HTMLElement) {
    const metricsEl = container.querySelector(".perf-metrics") as HTMLElement;
    if (!metricsEl) return;
    clear(metricsEl);
    try {
      const [depMetrics, mtConfig, ruleProfile, trackingState, engineInfo] = await Promise.all([
        this.store.api.diagnosticsDependencyMetrics().catch(() => null),
        this.store.api.diagnosticsMultithreadConfig().catch(() => null),
        this.store.api.diagnosticsRuleEvalProfile(5).catch(() => null),
        this.store.api.diagnosticsDependencyTrackingState().catch(() => null),
        this.store.api.diagnosticsEngineBackend().catch(() => null),
      ]);

      // Dependency graph metrics
      if (depMetrics) {
        const sec = el("div", { class: "perf-section" }, [el("h4", {}, ["Dependency Graph Metrics"])]);
        const m = depMetrics;
        const addMetric = (label: string, value: any) => sec.appendChild(el("div", { class: "perf-metric" }, [el("span", { class: "perf-label" }, [label]), el("span", { class: "perf-value" }, [String(value ?? "—")])]));
        addMetric("Slice hits", m.slice_hits ?? m.slice_hits);
        addMetric("Slice misses", m.slice_misses ?? m.slice_misses);
        addMetric("Function hits", m.function_hits ?? m.function_hits);
        addMetric("Function misses", m.function_misses ?? m.function_misses);
        metricsEl.appendChild(sec);
      }

      // Multithreaded recompute
      if (mtConfig) {
        const sec = el("div", { class: "perf-section" }, [el("h4", {}, ["Multithreaded Recompute"])]);
        const addMetric = (label: string, value: any) => sec.appendChild(el("div", { class: "perf-metric" }, [el("span", { class: "perf-label" }, [label]), el("span", { class: "perf-value" }, [String(value ?? "—")])]));
        addMetric("Workers", mtConfig.workers ?? mtConfig.workers);
        addMetric("Parallel runs", mtConfig.parallel_runs ?? mtConfig.parallel_runs);
        addMetric("Parallel nodes", mtConfig.parallel_nodes ?? mtConfig.parallel_nodes);
        addMetric("Parallel frontiers", mtConfig.parallel_frontiers ?? mtConfig.parallel_frontiers);
        addMetric("Last run (ms)", mtConfig.last_run_ms ?? mtConfig.last_run_ms);
        metricsEl.appendChild(sec);
      }

      // Rule eval profile
      if (ruleProfile) {
        const sec = el("div", { class: "perf-section" }, [el("h4", {}, ["Profiler Snapshot"])]);
        const addMetric = (label: string, value: any) => sec.appendChild(el("div", { class: "perf-metric" }, [el("span", { class: "perf-label" }, [label]), el("span", { class: "perf-value" }, [String(value ?? "—")])]));
        addMetric("Cache hit rate", ruleProfile.cache_hit_rate != null ? (ruleProfile.cache_hit_rate * 100).toFixed(1) + "%" : "—");
        addMetric("Rule eval count", ruleProfile.rule_eval_count ?? ruleProfile.rule_eval_count);
        addMetric("Rule avg eval (ms)", ruleProfile.rule_avg_eval_ms != null ? ruleProfile.rule_avg_eval_ms.toFixed(3) : "—");
        addMetric("Rule slow evals", ruleProfile.rule_slow_evals ?? ruleProfile.rule_slow_evals);
        const topRules = ruleProfile.top_rules || ruleProfile.top_rules_by_count || [];
        if (topRules.length) {
          sec.appendChild(el("div", { style: { marginTop: "4px", fontWeight: "600" } }, ["Top 5 rules by count:"]));
          for (const r of topRules.slice(0, 5)) sec.appendChild(el("div", { class: "perf-metric" }, [el("span", { class: "perf-label" }, [r.expression?.slice(0, 40) || r.id?.slice(0, 8) || "?"]), el("span", { class: "perf-value" }, [String(r.count || r.eval_count || 0)])]));
        }
        metricsEl.appendChild(sec);
      }

      if (trackingState) {
        const sec = el("div", { class: "perf-section" }, [el("h4", {}, ["Tracking State"])]);
        sec.appendChild(el("div", { class: "perf-metric" }, [el("span", { class: "perf-label" }, ["Dependency tracking"]), el("span", { class: "perf-value" }, [trackingState.dependency_tracking_enabled ? "Enabled" : "Disabled"])]));
        metricsEl.appendChild(sec);
      }

      if (engineInfo) {
        const sec = el("div", { class: "perf-section" }, [el("h4", {}, ["Engine Backend"])]);
        sec.appendChild(el("div", { class: "perf-metric" }, [el("span", { class: "perf-label" }, ["Engine"]), el("span", { class: "perf-value" }, [engineInfo.engine_type || engineInfo.type || "python"])]));
        metricsEl.appendChild(sec);
      }
    } catch (e) {
      metricsEl.appendChild(el("div", { class: "muted" }, [`Metrics unavailable: ${e}`]));
    }
  }

  dispose() { if (this.timer) clearInterval(this.timer); }
}
