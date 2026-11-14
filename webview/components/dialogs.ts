import { el } from "../dom";

/** HIG-compliant dialog helpers.
 *  Replaces native prompt()/confirm()/alert() with proper modal dialogs
 *  that follow Apple HIG principles: clear hierarchy, immediate feedback,
 *  forgiveness (Escape to cancel), and consistent typography. */

let overlay: HTMLElement | null = null;

function ensureOverlay(): HTMLElement {
  if (overlay && document.body.contains(overlay)) return overlay;
  overlay = el("div", { class: "dlg-overlay", style: {
    position: "fixed", inset: "0", background: "var(--dlg-overlay)",
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
      background: "var(--popup-bg)", borderRadius: "10px", padding: "20px",
      minWidth: "320px", maxWidth: "400px", boxShadow: "var(--dlg-shadow)",
      fontFamily: "-apple-system, system-ui, sans-serif",
    } }) as HTMLElement;

    const label = el("div", { style: { fontSize: "13px", fontWeight: "600", marginBottom: "12px", color: "var(--dlg-title)" } }, [title]);
    dlg.appendChild(label);

    const input = document.createElement("input") as HTMLInputElement;
    input.type = "text";
    input.value = defaultValue;
    input.placeholder = placeholder;
    input.style.cssText = "width: 100%; box-sizing: border-box; padding: 8px 12px; background: var(--input-bg); border: 1px solid var(--dlg-border); border-radius: 6px; font-size: 13px; font-family: inherit; margin-bottom: 16px;";
    dlg.appendChild(input);

    const btnRow = el("div", { style: { display: "flex", justifyContent: "flex-end", gap: "8px" } }) as HTMLElement;
    const cancelBtn = el("button", { style: {
      padding: "6px 16px", border: "1px solid var(--dlg-border)", borderRadius: "6px",
      background: "var(--dlg-btn-bg)", fontSize: "13px", cursor: "pointer", fontFamily: "inherit",
    } }, ["Cancel"]) as HTMLButtonElement;
    const okBtn = el("button", { style: {
      padding: "6px 16px", border: "none", borderRadius: "6px",
      background: "var(--dlg-primary)", color: "var(--on-accent)", fontSize: "13px", cursor: "pointer", fontFamily: "inherit", fontWeight: "500",
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
      background: "var(--popup-bg)", borderRadius: "10px", padding: "20px",
      minWidth: "320px", maxWidth: "400px", boxShadow: "var(--dlg-shadow)",
      fontFamily: "-apple-system, system-ui, sans-serif",
    } }) as HTMLElement;

    const label = el("div", { style: { fontSize: "13px", fontWeight: "600", marginBottom: "8px", color: "var(--dlg-title)" } }, [title]);
    dlg.appendChild(label);

    const msg = el("div", { style: { fontSize: "13px", color: "var(--dlg-text)", marginBottom: "16px", lineHeight: "1.4", whiteSpace: "pre-line" } }, [message]);
    dlg.appendChild(msg);

    const btnRow = el("div", { style: { display: "flex", justifyContent: "flex-end", gap: "8px" } }) as HTMLElement;
    const cancelBtn = el("button", { style: {
      padding: "6px 16px", border: "1px solid var(--dlg-border)", borderRadius: "6px",
      background: "var(--dlg-btn-bg)", fontSize: "13px", cursor: "pointer", fontFamily: "inherit",
    } }, ["Cancel"]) as HTMLButtonElement;
    const okBtn = el("button", { style: {
      padding: "6px 16px", border: "none", borderRadius: "6px",
      background: destructive ? "var(--dlg-danger)" : "var(--dlg-primary)", color: "var(--on-accent)",
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
      background: "var(--popup-bg)", borderRadius: "10px", padding: "20px",
      minWidth: "360px", maxWidth: "440px", boxShadow: "var(--dlg-shadow)",
      fontFamily: "-apple-system, system-ui, sans-serif",
    } }) as HTMLElement;
    dlg.appendChild(el("div", { style: { fontSize: "13px", fontWeight: "600", marginBottom: "8px", color: "var(--dlg-title)" } }, [title]));
    dlg.appendChild(el("div", { style: { fontSize: "13px", color: "var(--dlg-text)", marginBottom: "16px", lineHeight: "1.4", whiteSpace: "pre-line" } }, [message]));

    const done = (val: string | null) => { closeOverlay(); resolve(val); };
    const btnRow = el("div", { style: { display: "flex", justifyContent: "flex-end", gap: "8px" } }) as HTMLElement;
    let focusBtn: HTMLButtonElement | null = null;
    for (const c of choices) {
      const kind = c.kind || "normal";
      const btn = el("button", { "data-value": c.value, style: {
        padding: "6px 16px", borderRadius: "6px", fontSize: "13px", cursor: "pointer", fontFamily: "inherit",
        border: kind === "primary" ? "none" : "1px solid var(--dlg-border)",
        background: kind === "primary" ? "var(--dlg-primary)" : "var(--dlg-btn-bg)",
        color: kind === "primary" ? "var(--on-accent)" : kind === "destructive" ? "var(--dlg-danger)" : "var(--dlg-title)",
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
      background: "var(--popup-bg)", borderRadius: "10px", padding: "20px",
      minWidth: "320px", maxWidth: "400px", boxShadow: "var(--dlg-shadow)",
      fontFamily: "-apple-system, system-ui, sans-serif",
    } }) as HTMLElement;

    const label = el("div", { style: { fontSize: "13px", fontWeight: "600", marginBottom: "8px", color: "var(--dlg-title)" } }, [title]);
    dlg.appendChild(label);

    const msg = el("div", { style: { fontSize: "13px", color: "var(--dlg-text)", marginBottom: "16px", lineHeight: "1.4", whiteSpace: "pre-line" } }, [message]);
    dlg.appendChild(msg);

    const btnRow = el("div", { style: { display: "flex", justifyContent: "flex-end", gap: "8px" } }) as HTMLElement;
    const okBtn = el("button", { style: {
      padding: "6px 16px", border: "none", borderRadius: "6px",
      background: "var(--dlg-primary)", color: "var(--on-accent)", fontSize: "13px", cursor: "pointer", fontFamily: "inherit", fontWeight: "500",
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
      background: "var(--popup-bg)", borderRadius: "10px", padding: "20px",
      minWidth: "320px", maxWidth: "400px", boxShadow: "var(--dlg-shadow)",
      fontFamily: "-apple-system, system-ui, sans-serif",
    } }) as HTMLElement;

    const label = el("div", { style: { fontSize: "13px", fontWeight: "600", marginBottom: "12px", color: "var(--dlg-title)" } }, [title]);
    dlg.appendChild(label);

    const select = document.createElement("select") as HTMLSelectElement;
    select.style.cssText = "width: 100%; box-sizing: border-box; padding: 8px 12px; background: var(--input-bg); border: 1px solid var(--dlg-border); border-radius: 6px; font-size: 13px; font-family: inherit; margin-bottom: 16px;";
    options.forEach((opt, i) => {
      const o = document.createElement("option");
      o.value = opt; o.textContent = opt;
      if (i === defaultIndex) o.selected = true;
      select.appendChild(o);
    });
    dlg.appendChild(select);

    const btnRow = el("div", { style: { display: "flex", justifyContent: "flex-end", gap: "8px" } }) as HTMLElement;
    const cancelBtn = el("button", { style: {
      padding: "6px 16px", border: "1px solid var(--dlg-border)", borderRadius: "6px",
      background: "var(--dlg-btn-bg)", fontSize: "13px", cursor: "pointer", fontFamily: "inherit",
    } }, ["Cancel"]) as HTMLButtonElement;
    const okBtn = el("button", { style: {
      padding: "6px 16px", border: "none", borderRadius: "6px",
      background: "var(--dlg-primary)", color: "var(--on-accent)", fontSize: "13px", cursor: "pointer", fontFamily: "inherit", fontWeight: "500",
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

/** One field of a formDialog. `visibleIf` hides the row; a function `options` is recomputed on every change
 *  (dependent selects, e.g. the default item of the chosen dimension). Hidden fields are still returned. */
export type FormValues = Record<string, any>;
export type FormOption = { value: string; label: string };
export type FormField =
  | { kind: "text"; key: string; label: string; value?: string; placeholder?: string; visibleIf?: (v: FormValues) => boolean }
  | { kind: "select"; key: string; label: string; options: FormOption[] | ((v: FormValues) => FormOption[]); value?: string; visibleIf?: (v: FormValues) => boolean }
  | { kind: "checks"; key: string; label: string; options: FormOption[]; values?: string[]; visibleIf?: (v: FormValues) => boolean }
  | { kind: "check"; key: string; label: string; value?: boolean; visibleIf?: (v: FormValues) => boolean };

/** Multi-field dialog — the web counterpart of the Qt QFormLayout dialogs (New Cube, New View, Add Dimension…).
 *  `validate` returns an error shown inside the dialog, which stays open (Qt re-opens the dialog instead).
 *  Resolves with the values, or null on Cancel / Escape / click outside. */
export function formDialog(title: string, fields: FormField[], opts: { okLabel?: string; validate?: (v: FormValues) => string | null } = {}): Promise<FormValues | null> {
  return new Promise((resolve) => {
    const ov = ensureOverlay();
    clear(ov);
    const dlg = el("div", { class: "dlg dlg-form", role: "dialog", "aria-label": title, style: {
      background: "var(--popup-bg)", borderRadius: "10px", padding: "20px",
      minWidth: "360px", maxWidth: "440px", boxShadow: "var(--dlg-shadow)",
      fontFamily: "-apple-system, system-ui, sans-serif",
    } }) as HTMLElement;
    dlg.appendChild(el("div", { style: { fontSize: "13px", fontWeight: "600", marginBottom: "12px", color: "var(--dlg-title)" } }, [title]));

    const values: FormValues = {};
    const ctl = "width: 100%; box-sizing: border-box; padding: 6px 10px; background: var(--input-bg); border: 1px solid var(--dlg-border); border-radius: 6px; font-size: 13px; font-family: inherit;";
    const rows: { f: FormField; row: HTMLElement; sync?: () => void }[] = [];
    const refresh = () => {
      for (const r of rows) { r.sync?.(); r.row.style.display = !r.f.visibleIf || r.f.visibleIf(values) ? "" : "none"; }
    };
    for (const f of fields) {
      const row = el("div", { class: "dlg-row", "data-key": f.key, style: { marginBottom: "10px" } }) as HTMLElement;
      const lab = el("div", { style: { fontSize: "12px", color: "var(--dlg-label)", marginBottom: "4px" } }, [f.label]);
      let sync: (() => void) | undefined;
      if (f.kind === "text") {
        row.appendChild(lab);
        const input = document.createElement("input");
        input.type = "text"; input.value = f.value ?? ""; input.placeholder = f.placeholder ?? "";
        input.style.cssText = ctl; input.dataset.key = f.key; input.setAttribute("aria-label", f.label);
        values[f.key] = input.value;
        input.addEventListener("input", () => { values[f.key] = input.value; refresh(); });
        row.appendChild(input);
      } else if (f.kind === "select") {
        row.appendChild(lab);
        const select = document.createElement("select");
        select.style.cssText = ctl; select.dataset.key = f.key; select.setAttribute("aria-label", f.label);
        let shown = "";
        sync = () => {
          const list = typeof f.options === "function" ? f.options(values) : f.options;
          const sig = JSON.stringify(list);
          if (sig === shown) return;
          shown = sig;
          const keep = values[f.key];
          select.innerHTML = "";
          for (const o of list) { const op = document.createElement("option"); op.value = o.value; op.textContent = o.label; select.appendChild(op); }
          select.value = list.some((o) => o.value === keep) ? keep : (list[0]?.value ?? "");
          values[f.key] = select.value;
        };
        values[f.key] = f.value ?? "";
        sync();
        select.addEventListener("change", () => { values[f.key] = select.value; refresh(); });
        row.appendChild(select);
      } else if (f.kind === "checks") {
        row.appendChild(lab);
        const box = el("div", { style: { border: "1px solid var(--dlg-border)", borderRadius: "6px", padding: "4px 8px", maxHeight: "160px", overflowY: "auto" } }) as HTMLElement;
        values[f.key] = f.options.map((o) => o.value).filter((v) => (f.values || []).includes(v));
        for (const o of f.options) {
          const cb = document.createElement("input");
          cb.type = "checkbox"; cb.value = o.value; cb.checked = values[f.key].includes(o.value); cb.dataset.key = f.key;
          cb.addEventListener("change", () => {
            const set = new Set<string>(values[f.key]);
            if (cb.checked) set.add(o.value); else set.delete(o.value);
            values[f.key] = f.options.map((x) => x.value).filter((v) => set.has(v)); // keep option order
            refresh();
          });
          box.appendChild(el("label", { style: { display: "flex", gap: "6px", alignItems: "center", fontSize: "13px", padding: "2px 0", cursor: "pointer" } }, [cb, document.createTextNode(o.label)]));
        }
        row.appendChild(box);
      } else {
        const cb = document.createElement("input");
        cb.type = "checkbox"; cb.checked = !!f.value; cb.dataset.key = f.key;
        values[f.key] = cb.checked;
        cb.addEventListener("change", () => { values[f.key] = cb.checked; refresh(); });
        row.appendChild(el("label", { style: { display: "flex", gap: "6px", alignItems: "center", fontSize: "13px", cursor: "pointer" } }, [cb, document.createTextNode(f.label)]));
      }
      rows.push({ f, row, sync });
      dlg.appendChild(row);
    }
    const err = el("div", { class: "dlg-error", role: "alert", style: { color: "var(--dlg-danger)", fontSize: "12px", minHeight: "16px", marginBottom: "8px", whiteSpace: "pre-line" } }) as HTMLElement;
    dlg.appendChild(err);

    const btnRow = el("div", { style: { display: "flex", justifyContent: "flex-end", gap: "8px" } }) as HTMLElement;
    const cancelBtn = el("button", { style: {
      padding: "6px 16px", border: "1px solid var(--dlg-border)", borderRadius: "6px",
      background: "var(--dlg-btn-bg)", fontSize: "13px", cursor: "pointer", fontFamily: "inherit",
    } }, ["Cancel"]) as HTMLButtonElement;
    const okBtn = el("button", { style: {
      padding: "6px 16px", border: "none", borderRadius: "6px",
      background: "var(--dlg-primary)", color: "var(--on-accent)", fontSize: "13px", cursor: "pointer", fontFamily: "inherit", fontWeight: "500",
    } }, [opts.okLabel || "OK"]) as HTMLButtonElement;
    btnRow.appendChild(cancelBtn); btnRow.appendChild(okBtn);
    dlg.appendChild(btnRow);
    ov.appendChild(dlg);
    refresh();

    const done = (v: FormValues | null) => { closeOverlay(); resolve(v); };
    const submit = () => {
      const msg = opts.validate?.(values) ?? null;
      if (msg) { err.textContent = msg; return; }
      done({ ...values });
    };
    cancelBtn.addEventListener("click", () => done(null));
    okBtn.addEventListener("click", submit);
    dlg.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); done(null); }
      else if (e.key === "Enter" && (e.target as HTMLElement).tagName !== "BUTTON") { e.preventDefault(); submit(); }
    });
    ov.addEventListener("click", (e) => { if (e.target === ov) done(null); });
    (dlg.querySelector("input, select") as HTMLElement | null)?.focus();
  });
}

function clear(node: HTMLElement) { while (node.firstChild) node.removeChild(node.firstChild); }
