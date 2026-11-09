import { el } from "../dom";

/** HIG-compliant dialog helpers.
 *  Replaces native prompt()/confirm()/alert() with proper modal dialogs
 *  that follow Apple HIG principles: clear hierarchy, immediate feedback,
 *  forgiveness (Escape to cancel), and consistent typography. */

let overlay: HTMLElement | null = null;

function ensureOverlay(): HTMLElement {
  if (overlay && document.body.contains(overlay)) return overlay;
  overlay = el("div", { class: "dlg-overlay", style: {
    position: "fixed", inset: "0", background: "rgba(0,0,0,0.3)",
    zIndex: "100000", display: "flex", alignItems: "center", justifyContent: "center",
  } }) as HTMLElement;
  document.body.appendChild(overlay);
  return overlay;
}

function closeOverlay() {
  if (overlay) { overlay.remove(); overlay = null; }
}

/** Show a text input dialog. Returns the entered string or null if cancelled. */
export function inputDialog(title: string, defaultValue = "", placeholder = ""): Promise<string | null> {
  return new Promise((resolve) => {
    const ov = ensureOverlay();
    clear(ov);

    const dlg = el("div", { class: "dlg", style: {
      background: "#fff", borderRadius: "10px", padding: "20px",
      minWidth: "320px", maxWidth: "400px", boxShadow: "0 8px 32px rgba(0,0,0,0.2)",
      fontFamily: "-apple-system, system-ui, sans-serif",
    } }) as HTMLElement;

    const label = el("div", { style: { fontSize: "13px", fontWeight: "600", marginBottom: "12px", color: "#202020" } }, [title]);
    dlg.appendChild(label);

    const input = document.createElement("input") as HTMLInputElement;
    input.type = "text";
    input.value = defaultValue;
    input.placeholder = placeholder;
    input.style.cssText = "width: 100%; box-sizing: border-box; padding: 8px 12px; border: 1px solid #d0d0d0; border-radius: 6px; font-size: 13px; font-family: inherit; margin-bottom: 16px;";
    dlg.appendChild(input);

    const btnRow = el("div", { style: { display: "flex", justifyContent: "flex-end", gap: "8px" } }) as HTMLElement;
    const cancelBtn = el("button", { style: {
      padding: "6px 16px", border: "1px solid #d0d0d0", borderRadius: "6px",
      background: "#f2f4f8", fontSize: "13px", cursor: "pointer", fontFamily: "inherit",
    } }, ["Cancel"]) as HTMLButtonElement;
    const okBtn = el("button", { style: {
      padding: "6px 16px", border: "none", borderRadius: "6px",
      background: "#2a76d2", color: "#fff", fontSize: "13px", cursor: "pointer", fontFamily: "inherit", fontWeight: "500",
    } }, ["OK"]) as HTMLButtonElement;
    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(okBtn);
    dlg.appendChild(btnRow);
    ov.appendChild(dlg);

    input.focus();
    input.select();

    const done = (val: string | null) => { closeOverlay(); resolve(val); };
    cancelBtn.addEventListener("click", () => done(null));
    okBtn.addEventListener("click", () => done(input.value));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); done(input.value); }
      else if (e.key === "Escape") { e.preventDefault(); done(null); }
    });
    ov.addEventListener("click", (e) => { if (e.target === ov) done(null); });
  });
}

/** Show a confirmation dialog. Returns true if confirmed, false if cancelled. */
export function confirmDialog(title: string, message: string, confirmLabel = "Confirm", destructive = false): Promise<boolean> {
  return new Promise((resolve) => {
    const ov = ensureOverlay();
    clear(ov);

    const dlg = el("div", { class: "dlg", style: {
      background: "#fff", borderRadius: "10px", padding: "20px",
      minWidth: "320px", maxWidth: "400px", boxShadow: "0 8px 32px rgba(0,0,0,0.2)",
      fontFamily: "-apple-system, system-ui, sans-serif",
    } }) as HTMLElement;

    const label = el("div", { style: { fontSize: "13px", fontWeight: "600", marginBottom: "8px", color: "#202020" } }, [title]);
    dlg.appendChild(label);

    const msg = el("div", { style: { fontSize: "13px", color: "#404040", marginBottom: "16px", lineHeight: "1.4" } }, [message]);
    dlg.appendChild(msg);

    const btnRow = el("div", { style: { display: "flex", justifyContent: "flex-end", gap: "8px" } }) as HTMLElement;
    const cancelBtn = el("button", { style: {
      padding: "6px 16px", border: "1px solid #d0d0d0", borderRadius: "6px",
      background: "#f2f4f8", fontSize: "13px", cursor: "pointer", fontFamily: "inherit",
    } }, ["Cancel"]) as HTMLButtonElement;
    const okBtn = el("button", { style: {
      padding: "6px 16px", border: "none", borderRadius: "6px",
      background: destructive ? "#c00" : "#2a76d2", color: "#fff",
      fontSize: "13px", cursor: "pointer", fontFamily: "inherit", fontWeight: "500",
    } }, [confirmLabel]) as HTMLButtonElement;
    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(okBtn);
    dlg.appendChild(btnRow);
    ov.appendChild(dlg);

    cancelBtn.focus();

    const done = (val: boolean) => { closeOverlay(); resolve(val); };
    cancelBtn.addEventListener("click", () => done(false));
    okBtn.addEventListener("click", () => done(true));
    dlg.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); done(false); }
      else if (e.key === "Enter") { e.preventDefault(); done(true); }
    });
    ov.addEventListener("click", (e) => { if (e.target === ov) done(false); });
  });
}

export interface DialogChoice {
  label: string;
  value: string;
  /** primary: blue; destructive: red text, placed apart on the left (HIG: keep it away from the default). */
  kind?: "primary" | "destructive" | "normal";
}

/** Dialog with several buttons, e.g. Save / Discard / Cancel. Resolves to the chosen `value`, or null on
 *  Escape or a click outside. `defaultValue` gets focus, so Enter picks it (native button behaviour). */
export function choiceDialog(title: string, message: string, choices: DialogChoice[], defaultValue?: string): Promise<string | null> {
  return new Promise((resolve) => {
    const ov = ensureOverlay();
    clear(ov);

    const dlg = el("div", { class: "dlg", style: {
      background: "#fff", borderRadius: "10px", padding: "20px",
      minWidth: "360px", maxWidth: "440px", boxShadow: "0 8px 32px rgba(0,0,0,0.2)",
      fontFamily: "-apple-system, system-ui, sans-serif",
    } }) as HTMLElement;
    dlg.appendChild(el("div", { style: { fontSize: "13px", fontWeight: "600", marginBottom: "8px", color: "#202020" } }, [title]));
    dlg.appendChild(el("div", { style: { fontSize: "13px", color: "#404040", marginBottom: "16px", lineHeight: "1.4" } }, [message]));

    const done = (val: string | null) => { closeOverlay(); resolve(val); };
    const btnRow = el("div", { style: { display: "flex", justifyContent: "flex-end", gap: "8px" } }) as HTMLElement;
    let focusBtn: HTMLButtonElement | null = null;
    for (const c of choices) {
      const kind = c.kind || "normal";
      const btn = el("button", { "data-value": c.value, style: {
        padding: "6px 16px", borderRadius: "6px", fontSize: "13px", cursor: "pointer", fontFamily: "inherit",
        border: kind === "primary" ? "none" : "1px solid #d0d0d0",
        background: kind === "primary" ? "#2a76d2" : "#f2f4f8",
        color: kind === "primary" ? "#fff" : kind === "destructive" ? "#c00" : "#202020",
        fontWeight: kind === "primary" ? "500" : "400",
        marginRight: kind === "destructive" ? "auto" : "0",
      } }, [c.label]) as HTMLButtonElement;
      btn.addEventListener("click", () => done(c.value));
      btnRow.appendChild(btn);
      if (c.value === defaultValue) focusBtn = btn;
    }
    dlg.appendChild(btnRow);
    ov.appendChild(dlg);

    (focusBtn || (btnRow.lastElementChild as HTMLButtonElement | null))?.focus();
    dlg.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); done(null); } });
    ov.addEventListener("click", (e) => { if (e.target === ov) done(null); });
  });
}

/** Show an alert dialog. Returns when dismissed. */
export function alertDialog(title: string, message: string): Promise<void> {
  return new Promise((resolve) => {
    const ov = ensureOverlay();
    clear(ov);

    const dlg = el("div", { class: "dlg", style: {
      background: "#fff", borderRadius: "10px", padding: "20px",
      minWidth: "320px", maxWidth: "400px", boxShadow: "0 8px 32px rgba(0,0,0,0.2)",
      fontFamily: "-apple-system, system-ui, sans-serif",
    } }) as HTMLElement;

    const label = el("div", { style: { fontSize: "13px", fontWeight: "600", marginBottom: "8px", color: "#202020" } }, [title]);
    dlg.appendChild(label);

    const msg = el("div", { style: { fontSize: "13px", color: "#404040", marginBottom: "16px", lineHeight: "1.4" } }, [message]);
    dlg.appendChild(msg);

    const btnRow = el("div", { style: { display: "flex", justifyContent: "flex-end", gap: "8px" } }) as HTMLElement;
    const okBtn = el("button", { style: {
      padding: "6px 16px", border: "none", borderRadius: "6px",
      background: "#2a76d2", color: "#fff", fontSize: "13px", cursor: "pointer", fontFamily: "inherit", fontWeight: "500",
    } }, ["OK"]) as HTMLButtonElement;
    btnRow.appendChild(okBtn);
    dlg.appendChild(btnRow);
    ov.appendChild(dlg);

    okBtn.focus();

    const done = () => { closeOverlay(); resolve(); };
    okBtn.addEventListener("click", done);
    dlg.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === "Escape") { e.preventDefault(); done(); }
    });
    ov.addEventListener("click", (e) => { if (e.target === ov) done(); });
  });
}

/** Show a dropdown/picker dialog. Returns the selected item or null if cancelled. */
export function pickDialog(title: string, options: string[], defaultIndex = 0): Promise<string | null> {
  return new Promise((resolve) => {
    const ov = ensureOverlay();
    clear(ov);

    const dlg = el("div", { class: "dlg", style: {
      background: "#fff", borderRadius: "10px", padding: "20px",
      minWidth: "320px", maxWidth: "400px", boxShadow: "0 8px 32px rgba(0,0,0,0.2)",
      fontFamily: "-apple-system, system-ui, sans-serif",
    } }) as HTMLElement;

    const label = el("div", { style: { fontSize: "13px", fontWeight: "600", marginBottom: "12px", color: "#202020" } }, [title]);
    dlg.appendChild(label);

    const select = document.createElement("select") as HTMLSelectElement;
    select.style.cssText = "width: 100%; box-sizing: border-box; padding: 8px 12px; border: 1px solid #d0d0d0; border-radius: 6px; font-size: 13px; font-family: inherit; margin-bottom: 16px;";
    options.forEach((opt, i) => {
      const o = document.createElement("option");
      o.value = opt; o.textContent = opt;
      if (i === defaultIndex) o.selected = true;
      select.appendChild(o);
    });
    dlg.appendChild(select);

    const btnRow = el("div", { style: { display: "flex", justifyContent: "flex-end", gap: "8px" } }) as HTMLElement;
    const cancelBtn = el("button", { style: {
      padding: "6px 16px", border: "1px solid #d0d0d0", borderRadius: "6px",
      background: "#f2f4f8", fontSize: "13px", cursor: "pointer", fontFamily: "inherit",
    } }, ["Cancel"]) as HTMLButtonElement;
    const okBtn = el("button", { style: {
      padding: "6px 16px", border: "none", borderRadius: "6px",
      background: "#2a76d2", color: "#fff", fontSize: "13px", cursor: "pointer", fontFamily: "inherit", fontWeight: "500",
    } }, ["OK"]) as HTMLButtonElement;
    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(okBtn);
    dlg.appendChild(btnRow);
    ov.appendChild(dlg);

    select.focus();

    const done = (val: string | null) => { closeOverlay(); resolve(val); };
    cancelBtn.addEventListener("click", () => done(null));
    okBtn.addEventListener("click", () => done(select.value));
    select.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); done(select.value); }
      else if (e.key === "Escape") { e.preventDefault(); done(null); }
    });
    ov.addEventListener("click", (e) => { if (e.target === ov) done(null); });
  });
}

function clear(node: HTMLElement) { while (node.firstChild) node.removeChild(node.firstChild); }
