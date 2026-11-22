import { Store } from "../state";
import { el } from "../dom";
import { guiVersion, guiVersionShort } from "../version";

/** Compact display form of an engine build string: semver + git7. */
function engineVersionShort(v: string): string {
    if (!v) return "";
    const parts = v.split("-");
    const git = parts.find(p => /^[0-9a-f]{7}$/.test(p));
    return git ? `${parts[0]}·${git}` : v;
}

/** StatusBar — bottom bar showing focus path, cell address, nav mode, selection stats.
 *  Mirrors lib_gui/app.py status bar. The stats widget is the Qt dropdown button
 *  (_StatsDropdownButton): click toggles which metrics render, like the menubar
 *  checkable actions (Average, CountA, Count, Maximum, Minimum, Sum, Selection
 *  count — plus Scientific format and None). Qt defaults: Average + Sum. */
export class StatusBar {
  constructor(private store: Store) {}

  /** Qt _render_stats_from_dto._fmt: None -> "0", ints bare, else %.6f trimmed,
   *  or %.6e with a two-digit exponent when scientific is on. */
  private fmt(v: any, sci: boolean): string {
    if (v == null || isNaN(Number(v))) return "0";
    if (sci) return Number(v).toExponential(6).replace(/e([+-])(\d)$/, "e$10$2");
    if (Number.isInteger(v)) return String(v);
    return Number(v).toFixed(6).replace(/\.?0+$/, "");
  }

  private statsText(): string {
    const s = this.store.state;
    const st = s.selectionStats;
    const m = s.statsMetrics;
    if (m.size === 0) return "";   // "None"
    const chunks: string[] = [];
    if (m.has("selcount")) chunks.push(`Selection count: ${st.total_count ?? 0}`);
    if (m.has("count")) chunks.push(`Count: ${st.count ?? 0}`);
    if (m.has("counta")) chunks.push(`CountA: ${st.counta ?? 0}`);
    if (m.has("sum")) chunks.push(`Sum: ${this.fmt(st.sum, s.statsSci)}`);
    if (m.has("avg")) chunks.push(`Average: ${this.fmt(st.avg, s.statsSci)}`);
    if (m.has("min")) chunks.push(`Min: ${this.fmt(st.min, s.statsSci)}`);
    if (m.has("max")) chunks.push(`Max: ${this.fmt(st.max, s.statsSci)}`);
    return chunks.join("  ");
  }

  private showStatsMenu(anchor: HTMLElement) {
    document.querySelector(".ctx-menu")?.remove();
    const s = this.store.state;
    const menu = el("div", { class: "ctx-menu" });
    const close = (ev: MouseEvent) => { if (!menu.contains(ev.target as Node)) { menu.remove(); document.removeEventListener("mousedown", close); } };
    const closeMenu = () => { menu.remove(); document.removeEventListener("mousedown", close); };

    const addCheck = (label: string, checked: boolean, fn: () => void, title = label) => {
      const item = el("div", { class: "ctx-item", title }, [
        el("span", { class: "ctx-checkmark" }, [checked ? "✓" : ""]),
        label,
      ]);
      item.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
      item.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); closeMenu(); fn(); });
      menu.appendChild(item);
    };
    const addSep = () => menu.appendChild(el("div", { class: "ctx-sep" }));

    // Qt stat_defs menu order.
    const defs: [string, string][] = [
      ["avg", "Average"], ["counta", "CountA"], ["count", "Count"],
      ["max", "Maximum"], ["min", "Minimum"], ["sum", "Sum"], ["selcount", "Selection count"],
    ];
    for (const [key, label] of defs) {
      addCheck(label, s.statsMetrics.has(key as any), () => {
        const m = s.statsMetrics as Set<any>;
        if (m.has(key)) m.delete(key); else m.add(key);
        this.store.notify();
      });
    }
    addSep();
    addCheck("Scientific format", s.statsSci, () => { s.statsSci = !s.statsSci; this.store.notify(); });
    addSep();
    addCheck("None", s.statsMetrics.size === 0, () => { s.statsMetrics.clear(); this.store.notify(); });

    // Status bar sits at the window bottom — the menu opens upward.
    document.body.appendChild(menu);
    const r = anchor.getBoundingClientRect();
    menu.style.left = Math.min(r.left, window.innerWidth - menu.offsetWidth - 4) + "px";
    menu.style.top = (r.top - menu.offsetHeight - 4) + "px";
    document.addEventListener("mousedown", close);
  }

  render(): HTMLElement {
    const bar = el("div", { class: "statusbar" });
    const focusPath = el("span", { class: "sb-section" }, ["OM Core"]);
    const sep1 = el("span", { class: "sb-sep" }, ["|"]);
    const cellAddr = el("span", { class: "sb-section" }, ["—"]);
    const sep2 = el("span", { class: "sb-sep" }, ["|"]);
    const navMode = el("span", { class: "sb-section" }, ["nav: cell"]);
    const sep3 = el("span", { class: "sb-sep" }, ["|"]);
    const stats = el("span", { class: "sb-section sb-stats", tabindex: "0", role: "button", title: "Selection statistics — click to choose metrics" }, [""]);
    const sep4 = el("span", { class: "sb-sep" }, ["|"]);
    // Workspace file: the name, the full path on hover. In VS Code this and the editor tab are the only
    // places that show which file is open (document.title is not visible there).
    const file = el("span", { class: "sb-section sb-file" }, [""]);
    const dirty = el("span", { class: "sb-section dirty-marker" }, [""]);
    // Right-aligned version chip (GUI + engine builds). Click copies both
    // strings — the most useful data for a bug report.
    const version = el("span", { class: "sb-section sb-version", tabindex: "0", role: "button", title: "" }, [""]);
    const showVersions = () => {
      const eng = this.store.state.engineVersion;
      version.textContent = `v${guiVersionShort}${eng ? ` · eng ${engineVersionShort(eng)}` : ""}`;
      version.title = `om-gui ${guiVersion}\nom-engine ${eng || "unknown"}\n(click to copy)`;
    };
    const copyVersions = () => {
      navigator.clipboard?.writeText(`om-gui ${guiVersion}\nom-engine ${this.store.state.engineVersion || "unknown"}`).catch(() => {});
    };
    version.addEventListener("click", copyVersions);
    version.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); copyVersions(); }
    });

    stats.addEventListener("click", () => this.showStatsMenu(stats));
    stats.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this.showStatsMenu(stats); }
      else if (e.key === "Escape") document.querySelector(".ctx-menu")?.remove();
    });

    bar.appendChild(focusPath);
    bar.appendChild(sep1);
    bar.appendChild(cellAddr);
    bar.appendChild(sep2);
    bar.appendChild(navMode);
    bar.appendChild(sep3);
    bar.appendChild(stats);
    bar.appendChild(sep4);
    bar.appendChild(file);
    bar.appendChild(dirty);
    bar.appendChild(version);

    this.store.subscribe(() => {
      const s = this.store.state;
      focusPath.textContent = s.focusPath;
      const v = s.activeView;
      if (v && v.selectedRow >= 0 && v.selectedCol >= 0) {
        // Selection indices are visual; header arrays are data-indexed.
        const dr = this.store.dataRowIndex(v, v.selectedRow);
        const dc = this.store.dataColIndex(v, v.selectedCol);
        const rh = (dr >= 0 && v.rowHeaders[dr]) || `r${v.selectedRow}`;
        const ch = (dc >= 0 && v.colHeaders[dc]) || `c${v.selectedCol}`;
        cellAddr.textContent = `${rh} / ${ch}`;
        navMode.textContent = `nav: ${v.selMode}`;
      } else {
        cellAddr.textContent = "—";
        navMode.textContent = "nav: —";
      }
      stats.textContent = this.statsText();
      file.textContent = this.store.fileName();
      file.title = s.filePath || "Not saved to a file yet";
      dirty.textContent = s.dirty ? "● unsaved" : "";
      showVersions();
    });
    showVersions();

    return bar;
  }
}
