import { Store } from "../state";
import { el, clear } from "../dom";

/** StatusBar — bottom bar showing focus path, cell address, nav mode, selection stats.
 *  Mirrors lib_gui/app.py status bar. */
export class StatusBar {
  constructor(private store: Store) {}

  render(): HTMLElement {
    const bar = el("div", { class: "statusbar" });
    const focusPath = el("span", { class: "sb-section" }, ["OM Core"]);
    const sep1 = el("span", { class: "sb-sep" }, ["|"]);
    const cellAddr = el("span", { class: "sb-section" }, ["—"]);
    const sep2 = el("span", { class: "sb-sep" }, ["|"]);
    const navMode = el("span", { class: "sb-section" }, ["nav: cell"]);
    const sep3 = el("span", { class: "sb-sep" }, ["|"]);
    const stats = el("span", { class: "sb-section" }, [""]);
    const sep4 = el("span", { class: "sb-sep" }, ["|"]);
    const dirty = el("span", { class: "sb-section dirty-marker" }, [""]);

    bar.appendChild(focusPath);
    bar.appendChild(sep1);
    bar.appendChild(cellAddr);
    bar.appendChild(sep2);
    bar.appendChild(navMode);
    bar.appendChild(sep3);
    bar.appendChild(stats);
    bar.appendChild(sep4);
    bar.appendChild(dirty);

    this.store.subscribe(() => {
      const s = this.store.state;
      focusPath.textContent = s.focusPath;
      const v = s.activeView;
      if (v && v.selectedRow >= 0 && v.selectedCol >= 0) {
        const rh = v.rowHeaders[v.selectedRow] || `r${v.selectedRow}`;
        const ch = v.colHeaders[v.selectedCol] || `c${v.selectedCol}`;
        cellAddr.textContent = `${rh} / ${ch}`;
        navMode.textContent = `nav: ${v.selMode}`;
      } else {
        cellAddr.textContent = "—";
        navMode.textContent = "nav: —";
      }
      const st = s.selectionStats;
      const parts: string[] = [];
      if (st.count != null) parts.push(`count: ${st.count}`);
      if (st.counta != null) parts.push(`counta: ${st.counta}`);
      if (st.sum != null) parts.push(`sum: ${typeof st.sum === "number" ? st.sum.toFixed(2) : st.sum}`);
      if (st.avg != null) parts.push(`avg: ${typeof st.avg === "number" ? st.avg.toFixed(2) : st.avg}`);
      if (st.min != null) parts.push(`min: ${st.min}`);
      if (st.max != null) parts.push(`max: ${st.max}`);
      stats.textContent = parts.join("  ");
      dirty.textContent = s.dirty ? "● unsaved" : "";
    });

    return bar;
  }
}
