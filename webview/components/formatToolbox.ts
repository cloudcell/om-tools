import { Store } from "../state";
import { el, clear } from "../dom";

/** FormatToolbox — left dock with formatting controls.
 *  Mirrors lib_gui/format_toolbox.py: Background, Font, Alignment, Borders, Number. */
export class FormatToolbox {
  constructor(private store: Store) {}

  render(): HTMLElement {
    const panel = el("div", { class: "dock" });
    panel.appendChild(el("div", { class: "dock-header" }, ["Format"]));
    const content = el("div", { class: "dock-content" });

    // Section selector
    const sections = ["Background", "Font", "Alignment", "Borders", "Number"];
    const sectionList = el("div", { class: "format-section-list" });
    const sectionContent = el("div", { class: "format-section-content" });
    let activeSection = "Background";

    const renderSection = () => {
      clear(sectionContent);
      if (activeSection === "Background") this.renderBackground(sectionContent);
      else if (activeSection === "Font") this.renderFont(sectionContent);
      else if (activeSection === "Alignment") this.renderAlignment(sectionContent);
      else if (activeSection === "Borders") this.renderBorders(sectionContent);
      else if (activeSection === "Number") this.renderNumber(sectionContent);
    };

    for (const s of sections) {
      const item = el("div", { class: "format-section-item" + (s === activeSection ? " active" : "") }, [s]);
      item.addEventListener("click", () => { activeSection = s; sectionList.querySelectorAll(".format-section-item").forEach((el, i) => el.classList.toggle("active", sections[i] === s)); renderSection(); });
      sectionList.appendChild(item);
    }
    content.appendChild(sectionList);
    content.appendChild(sectionContent);
    panel.appendChild(content);
    renderSection();
    return panel;
  }

  private applyFormat(property: string, value: any) {
    this.store.api.setProperty("selection", property, value).then(() => {
      const v = this.store.state.activeView;
      if (v) this.store.loadView(v.viewId);
    }).catch((e) => console.error("format", e));
  }

  private renderBackground(c: HTMLElement) {
    c.appendChild(el("div", { class: "format-section" }, [el("h4", {}, ["Background Color"])]));
    const colorBtn = el("input", { class: "format-color-btn", type: "color", value: "#ffffff" }) as HTMLInputElement;
    colorBtn.addEventListener("change", () => this.applyFormat("format.bg_color", colorBtn.value));
    c.appendChild(el("div", { class: "format-row" }, [el("label", {}, ["Color:"]), colorBtn]));
    const clearBtn = el("button", { class: "tb-btn" }, ["Clear Background"]);
    clearBtn.addEventListener("click", () => this.applyFormat("format.bg_color", null));
    c.appendChild(el("div", { class: "format-row" }, [clearBtn]));
  }

  private renderFont(c: HTMLElement) {
    c.appendChild(el("div", { class: "format-section" }, [el("h4", {}, ["Font"])]));
    // Font family
    const fontSelect = el("select") as HTMLSelectElement;
    ["Arial", "Courier New", "Georgia", "Helvetica", "Times New Roman", "Verdana", "monospace"].forEach((f) => fontSelect.appendChild(el("option", { value: f }, [f])));
    fontSelect.addEventListener("change", () => this.applyFormat("format.font_family", fontSelect.value));
    c.appendChild(el("div", { class: "format-row" }, [el("label", {}, ["Family:"]), fontSelect]));
    // Font size
    const sizeInput = el("input", { type: "number", value: "10", min: "6", max: "72" }) as HTMLInputElement;
    sizeInput.addEventListener("change", () => this.applyFormat("format.font_size", parseInt(sizeInput.value)));
    c.appendChild(el("div", { class: "format-row" }, [el("label", {}, ["Size:"]), sizeInput]));
    // Font color
    const colorBtn = el("input", { class: "format-color-btn", type: "color", value: "#000000" }) as HTMLInputElement;
    colorBtn.addEventListener("change", () => this.applyFormat("format.color", colorBtn.value));
    c.appendChild(el("div", { class: "format-row" }, [el("label", {}, ["Color:"]), colorBtn]));
    // Bold/Italic/Underline
    const boldBtn = el("button", { class: "format-btn", style: { fontWeight: "700" } }, ["B"]);
    boldBtn.addEventListener("click", () => this.applyFormat("format.bold", true));
    const italicBtn = el("button", { class: "format-btn", style: { fontStyle: "italic" } }, ["I"]);
    italicBtn.addEventListener("click", () => this.applyFormat("format.italic", true));
    const underlineBtn = el("button", { class: "format-btn", style: { textDecoration: "underline" } }, ["U"]);
    underlineBtn.addEventListener("click", () => this.applyFormat("format.underline", true));
    c.appendChild(el("div", { class: "format-row" }, [el("label", {}, ["Style:"]), el("div", { class: "format-btn-group" }, [boldBtn, italicBtn, underlineBtn])]));
  }

  private renderAlignment(c: HTMLElement) {
    c.appendChild(el("div", { class: "format-section" }, [el("h4", {}, ["Alignment"])]));
    // Horizontal
    const hGroup = el("div", { class: "format-btn-group" });
    for (const [v, l] of [["left", "Left"], ["center", "Center"], ["right", "Right"]] as const) {
      const btn = el("button", { class: "format-btn" }, [l]);
      btn.addEventListener("click", () => this.applyFormat("format.text_h_align", v));
      hGroup.appendChild(btn);
    }
    c.appendChild(el("div", { class: "format-row" }, [el("label", {}, ["Horizontal:"]), hGroup]));
    // Vertical
    const vGroup = el("div", { class: "format-btn-group" });
    for (const [v, l] of [["top", "Top"], ["middle", "Middle"], ["bottom", "Bottom"]] as const) {
      const btn = el("button", { class: "format-btn" }, [l]);
      btn.addEventListener("click", () => this.applyFormat("format.text_v_align", v));
      vGroup.appendChild(btn);
    }
    c.appendChild(el("div", { class: "format-row" }, [el("label", {}, ["Vertical:"]), vGroup]));
  }

  private renderBorders(c: HTMLElement) {
    c.appendChild(el("div", { class: "format-section" }, [el("h4", {}, ["Borders"])]));
    // Presets
    const allBtn = el("button", { class: "format-btn" }, ["All Borders"]);
    allBtn.addEventListener("click", () => this.applyFormat("format.border_preset", { preset: "all", style: "solid", color: "#000000" }));
    const outerBtn = el("button", { class: "format-btn" }, ["Outer Only"]);
    outerBtn.addEventListener("click", () => this.applyFormat("format.border_preset", { preset: "outer", style: "solid", color: "#000000" }));
    const noneBtn = el("button", { class: "format-btn" }, ["No Borders"]);
    noneBtn.addEventListener("click", () => this.applyFormat("format.border_preset", { preset: "none", style: "none", color: "#000000" }));
    c.appendChild(el("div", { class: "format-row" }, [el("label", {}, ["Presets:"]), el("div", { class: "format-btn-group" }, [allBtn, outerBtn, noneBtn])]));
    // Line style
    const styleSelect = el("select") as HTMLSelectElement;
    [["solid", "Solid"], ["dashed", "Dashed"], ["dotted", "Dotted"]].forEach(([v, l]) => styleSelect.appendChild(el("option", { value: v }, [l])));
    c.appendChild(el("div", { class: "format-row" }, [el("label", {}, ["Style:"]), styleSelect]));
    // Line color
    const colorBtn = el("input", { class: "format-color-btn", type: "color", value: "#000000" }) as HTMLInputElement;
    c.appendChild(el("div", { class: "format-row" }, [el("label", {}, ["Color:"]), colorBtn]));
    // Individual borders
    c.appendChild(el("div", { class: "format-row" }, [el("label", {}, ["Sides:"])]));
    for (const side of ["top", "bottom", "left", "right"]) {
      const thinBtn = el("button", { class: "format-btn" }, [`${side} thin`]);
      thinBtn.addEventListener("click", () => this.applyFormat("format.border", { side, thickness: "thin", style: styleSelect.value, color: colorBtn.value }));
      const thickBtn = el("button", { class: "format-btn" }, [`${side} thick`]);
      thickBtn.addEventListener("click", () => this.applyFormat("format.border", { side, thickness: "thick", style: styleSelect.value, color: colorBtn.value }));
      c.appendChild(el("div", { class: "format-row" }, [el("div", { class: "format-btn-group" }, [thinBtn, thickBtn])]));
    }
  }

  private renderNumber(c: HTMLElement) {
    c.appendChild(el("div", { class: "format-section" }, [el("h4", {}, ["Number Format"])]));
    const fmtSelect = el("select") as HTMLSelectElement;
    [["general", "General"], ["number", "Number (1,234.56)"], ["currency", "Currency ($1,234.56)"], ["percent", "Percentage (12.34%)"], ["scientific", "Scientific (1.23E+03)"]].forEach(([v, l]) => fmtSelect.appendChild(el("option", { value: v }, [l])));
    fmtSelect.addEventListener("change", () => this.applyFormat("format.number_format", fmtSelect.value));
    c.appendChild(el("div", { class: "format-row" }, [el("label", {}, ["Format:"]), fmtSelect]));
    const decInput = el("input", { type: "number", value: "2", min: "0", max: "10" }) as HTMLInputElement;
    decInput.addEventListener("change", () => this.applyFormat("format.decimal_places", parseInt(decInput.value)));
    c.appendChild(el("div", { class: "format-row" }, [el("label", {}, ["Decimals:"]), decInput]));
  }
}
