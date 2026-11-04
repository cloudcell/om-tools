import { Store } from "../state";
import { el, clear } from "../dom";

/** InfoToolbox — left dock showing details about the selected model element or cell.
 *  Mirrors lib_gui/info_toolbox.py. */
export class InfoToolbox {
  constructor(private store: Store) {}

  render(): HTMLElement {
    const panel = el("div", { class: "dock" });
    panel.appendChild(el("div", { class: "dock-header" }, ["Info"]));
    const content = el("div", { class: "dock-content" });
    panel.appendChild(content);

    const refresh = () => {
      clear(content);
      const v = this.store.state.activeView;
      if (v && v.selectedRow >= 0 && v.selectedCol >= 0 && v.cells) {
        this.showCell(content, v.selectedRow, v.selectedCol);
      } else {
        content.appendChild(el("div", { class: "muted", style: { padding: "8px" } }, ["Select a model element or cell to see details."]));
      }
    };

    this.store.subscribe(refresh);
    refresh();
    return panel;
  }

  private showCell(content: HTMLElement, r: number, c: number) {
    const v = this.store.state.activeView!;
    const cell = v.cells!.cells[r * v.colKeys.length + c];
    if (!cell) { content.appendChild(el("div", { class: "muted" }, ["No cell data."])); return; }

    const sec = el("div", { class: "info-section" });
    const addRow = (label: string, value: any) => sec.appendChild(el("div", { class: "info-row" }, [el("span", { class: "info-label" }, [label]), el("span", { class: "info-value" }, [String(value ?? "—")])]));
    addRow("Type", "Cell");
    addRow("Address", cell.addr?.join(" | "));
    addRow("Value", cell.display_value ?? cell.value ?? "");
    addRow("Kind", cell.kind);
    addRow("Source", cell.explain?.source || "empty");
    addRow("Override", cell.explain?.source === "override" ? "Yes (User Hardcoded)" : "No (Rule)");
    if (cell.explain?.rule_body) addRow("Rule", cell.explain.rule_body);
    if (cell.explain?.error) addRow("Error", cell.explain.error);
    addRow("Cube", this.store.state.cubes.find((c2) => c2.id === v.cubeId)?.name || v.cubeId?.slice(0, 8));
    addRow("View", v.viewName);
    content.appendChild(sec);
  }
}
