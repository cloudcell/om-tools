import { el } from "../dom";
import { AGGREGATE_SIGN_CHOICES, DEFAULT_OPTIONS, type UiOptions } from "../../shared/messages";
import type { OmApi } from "../api";

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
export function alertDialog(title: string, message: string, image?: string, link?: { label: string; url: string; open: (url: string) => void }): Promise<void> {
  return new Promise((resolve) => {
    const ov = ensureOverlay();
    clear(ov);

    const dlg = el("div", { class: "dlg", style: {
      background: "var(--popup-bg)", borderRadius: "10px", padding: "20px",
      minWidth: "320px", maxWidth: "400px", boxShadow: "var(--dlg-shadow)",
      fontFamily: "-apple-system, system-ui, sans-serif",
    } }) as HTMLElement;

    // An image (e.g. the About logo) switches the dialog to Qt's centred layout.
    const centered = image ? { textAlign: "center" } : {};
    if (image) dlg.appendChild(el("img", { src: image, alt: "", style: {
      display: "block", margin: "0 auto 12px", maxWidth: "240px", maxHeight: "120px", objectFit: "contain",
    } }));

    const label = el("div", { style: { fontSize: "13px", fontWeight: "600", marginBottom: "8px", color: "var(--dlg-title)", ...centered } }, [title]);
    dlg.appendChild(label);

    const msg = el("div", { style: { fontSize: "13px", color: "var(--dlg-text)", marginBottom: "16px", lineHeight: "1.4", whiteSpace: "pre-line", ...centered } }, [message]);
    dlg.appendChild(msg);

    if (link) dlg.appendChild(el("a", {
      href: link.url, target: "_blank", rel: "noopener noreferrer",
      style: { display: "block", marginTop: "-8px", marginBottom: "16px", fontSize: "13px", color: "var(--accent)", textDecoration: "underline", ...centered },
      onclick: (e: Event) => { e.preventDefault(); link.open(link.url); },
    }, [link.label]));

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

/** One catalog entry shown by examplePickerDialog (shared/catalog.json rows). */
export interface ExampleEntry { id: string; title: string; description: string; category: string; file?: string; }

/** Compact example picker — scrollable list: title + one-line description + dimmed category.
 *  Click selects, double-click or Enter opens, Escape cancels. Resolves the entry or null. */
export function examplePickerDialog(title: string, examples: ExampleEntry[]): Promise<ExampleEntry | null> {
  return new Promise((resolve) => {
    const ov = ensureOverlay();
    clear(ov);

    const dlg = el("div", { class: "dlg", style: {
      background: "var(--popup-bg)", borderRadius: "10px", padding: "20px",
      minWidth: "360px", maxWidth: "420px", boxShadow: "var(--dlg-shadow)",
      fontFamily: "-apple-system, system-ui, sans-serif",
    } }) as HTMLElement;
    dlg.appendChild(el("div", { style: { fontSize: "13px", fontWeight: "600", marginBottom: "12px", color: "var(--dlg-title)" } }, [title]));

    const list = el("div", { role: "listbox", "aria-label": title, tabIndex: "0", style: {
      maxHeight: "300px", overflowY: "auto", border: "1px solid var(--dlg-border)",
      borderRadius: "6px", marginBottom: "16px", outline: "none",
    } }) as HTMLElement;

    let sel = 0;
    const rows: HTMLElement[] = [];
    const paint = () => rows.forEach((r, i) => {
      r.style.background = i === sel ? "var(--selection)" : "transparent";
      r.setAttribute("aria-selected", String(i === sel));
    });
    examples.forEach((ex, i) => {
      const row = el("div", { role: "option", style: {
        padding: "8px 12px", cursor: "default",
        borderBottom: i < examples.length - 1 ? "1px solid var(--dlg-border)" : "none",
      } }, [
        el("div", { style: { display: "flex", justifyContent: "space-between", gap: "8px" } }, [
          el("span", { style: { fontSize: "13px", fontWeight: "500", color: "var(--dlg-title)" } }, [ex.title]),
          el("span", { style: { fontSize: "11px", color: "var(--text-muted)", flexShrink: "0" } }, [ex.category]),
        ]),
        el("div", { style: { fontSize: "12px", color: "var(--text-muted)", marginTop: "2px" } }, [ex.description]),
      ]) as HTMLElement;
      row.addEventListener("click", () => { sel = i; paint(); list.focus(); });
      row.addEventListener("dblclick", () => { sel = i; done(ex); });
      rows.push(row); list.appendChild(row);
    });
    paint();
    dlg.appendChild(list);

    const btnRow = el("div", { style: { display: "flex", justifyContent: "flex-end", gap: "8px" } }) as HTMLElement;
    const cancelBtn = el("button", { style: {
      padding: "6px 16px", border: "1px solid var(--dlg-border)", borderRadius: "6px",
      background: "var(--dlg-btn-bg)", fontSize: "13px", cursor: "pointer", fontFamily: "inherit",
    } }, ["Cancel"]) as HTMLButtonElement;
    const openBtn = el("button", { style: {
      padding: "6px 16px", border: "none", borderRadius: "6px",
      background: "var(--dlg-primary)", color: "var(--on-accent)", fontSize: "13px", cursor: "pointer", fontFamily: "inherit", fontWeight: "500",
    } }, ["Open"]) as HTMLButtonElement;
    btnRow.appendChild(cancelBtn); btnRow.appendChild(openBtn); dlg.appendChild(btnRow);
    ov.appendChild(dlg);

    list.focus();
    rows[sel]?.scrollIntoView({ block: "nearest" });

    const done = (val: ExampleEntry | null) => { closeOverlay(); resolve(val); };
    cancelBtn.addEventListener("click", () => done(null));
    openBtn.addEventListener("click", () => done(examples[sel] ?? null));
    list.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" && sel < examples.length - 1) { sel++; paint(); rows[sel].scrollIntoView({ block: "nearest" }); e.preventDefault(); }
      else if (e.key === "ArrowUp" && sel > 0) { sel--; paint(); rows[sel].scrollIntoView({ block: "nearest" }); e.preventDefault(); }
      else if (e.key === "Enter") { e.preventDefault(); done(examples[sel] ?? null); }
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

/** Tools → Options… — display preferences, persisted in UiState. Each row shows
 *  what the default setup uses; "Restore defaults" resets every control.
 *  Resolves with the full options map on OK, or null on Cancel/Escape/outside click. */
export function optionsDialog(current: Required<UiOptions>, onResetTips?: () => void): Promise<UiOptions | null> {
  return new Promise((resolve) => {
    const ov = ensureOverlay();
    clear(ov);
    const dlg = el("div", { class: "dlg dlg-options", role: "dialog", "aria-label": "Options", style: {
      background: "var(--popup-bg)", borderRadius: "10px", padding: "20px",
      minWidth: "360px", maxWidth: "440px", boxShadow: "var(--dlg-shadow)",
      fontFamily: "-apple-system, system-ui, sans-serif",
    } }) as HTMLElement;
    dlg.appendChild(el("div", { style: { fontSize: "13px", fontWeight: "600", marginBottom: "12px", color: "var(--dlg-title)" } }, ["Options"]));

    const defaultTag = (isDefault: boolean) =>
      el("span", { style: { fontSize: "11px", color: "var(--text-label)", marginLeft: "6px" } },
        [isDefault ? "(default)" : ""]);

    // — Mark hardvalue cells —
    const hvCb = document.createElement("input");
    hvCb.type = "checkbox"; hvCb.checked = current.markHardvalues;
    const hvDefault = el("span", { style: { fontSize: "11px", color: "var(--text-label)", marginLeft: "auto" } },
      [`default: ${DEFAULT_OPTIONS.markHardvalues ? "on" : "off"}`]);
    dlg.appendChild(el("label", { style: { display: "flex", gap: "6px", alignItems: "center", fontSize: "13px", marginBottom: "12px", cursor: "pointer" } }, [
      hvCb,
      document.createTextNode("Mark hardvalue cells"),
      el("span", { style: { fontSize: "11px", color: "var(--text-label)" } }, ["yellow fill + red corner"]),
      hvDefault,
    ]));

    // — Aggregate sign —
    const signSelect = document.createElement("select");
    signSelect.style.cssText = "box-sizing: border-box; padding: 4px 8px; background: var(--input-bg); border: 1px solid var(--dlg-border); border-radius: 6px; font-size: 13px; font-family: inherit;";
    for (const c of AGGREGATE_SIGN_CHOICES) {
      const op = document.createElement("option");
      op.value = c.value;
      op.textContent = c.value === DEFAULT_OPTIONS.aggregateSign ? `${c.label} (default)` : c.label;
      signSelect.appendChild(op);
    }
    signSelect.value = AGGREGATE_SIGN_CHOICES.some((c) => c.value === current.aggregateSign)
      ? current.aggregateSign : DEFAULT_OPTIONS.aggregateSign;
    const signTag = defaultTag(signSelect.value === DEFAULT_OPTIONS.aggregateSign);
    dlg.appendChild(el("div", { style: { display: "flex", gap: "8px", alignItems: "center", fontSize: "13px", marginBottom: "12px" } }, [
      el("span", {}, ["Aggregate sign"]),
      signSelect,
      signTag,
    ]));

    // — Assistant —
    const aiCb = document.createElement("input");
    aiCb.type = "checkbox"; aiCb.checked = current.assistant;
    const aiDefault = el("span", { style: { fontSize: "11px", color: "var(--text-label)", marginLeft: "auto" } },
      [`default: ${DEFAULT_OPTIONS.assistant ? "on" : "off"}`]);
    dlg.appendChild(el("label", { style: { display: "flex", gap: "6px", alignItems: "center", fontSize: "13px", marginBottom: "12px", cursor: "pointer" } }, [
      aiCb,
      document.createTextNode("Show AI Assistant"),
      el("span", { style: { fontSize: "11px", color: "var(--text-label)" } }, ["chat panel (om-tools-web)"]),
      aiDefault,
    ]));

    // — Dockable panels —
    const dockCb = document.createElement("input");
    dockCb.type = "checkbox"; dockCb.checked = current.docking;
    const dockDefault = el("span", { style: { fontSize: "11px", color: "var(--text-label)", marginLeft: "auto" } },
      [`default: ${DEFAULT_OPTIONS.docking ? "on" : "off"}`]);
    dlg.appendChild(el("label", { style: { display: "flex", gap: "6px", alignItems: "center", fontSize: "13px", marginBottom: "12px", cursor: "pointer" } }, [
      dockCb,
      document.createTextNode("Dockable panels"),
      el("span", { style: { fontSize: "11px", color: "var(--text-label)" } }, ["tabbed zones, drag between edges"]),
      dockDefault,
    ]));

    // — Advanced panels —
    const advCb = document.createElement("input");
    advCb.type = "checkbox"; advCb.checked = current.advancedPanels;
    const advDefault = el("span", { style: { fontSize: "11px", color: "var(--text-label)", marginLeft: "auto" } },
      [`default: ${DEFAULT_OPTIONS.advancedPanels ? "on" : "off"}`]);
    dlg.appendChild(el("label", { style: { display: "flex", gap: "6px", alignItems: "center", fontSize: "13px", marginBottom: "16px", cursor: "pointer" } }, [
      advCb,
      document.createTextNode("Performance & Timeline panels"),
      el("span", { style: { fontSize: "11px", color: "var(--text-label)" } }, ["experimental — enables View menu"]),
      advDefault,
    ]));

    // — Contextual tips —
    const tipsCb = document.createElement("input");
    tipsCb.type = "checkbox"; tipsCb.checked = current.showTips;
    const tipsDefault = el("span", { style: { fontSize: "11px", color: "var(--text-label)", marginLeft: "auto" } },
      [`default: ${DEFAULT_OPTIONS.showTips ? "on" : "off"}`]);
    dlg.appendChild(el("label", { style: { display: "flex", gap: "6px", alignItems: "center", fontSize: "13px", marginBottom: "16px", cursor: "pointer" } }, [
      tipsCb,
      document.createTextNode("Show contextual tips"),
      el("span", { style: { fontSize: "11px", color: "var(--text-label)" } }, ["first-use hints — Help → Reset Tips… replays them"]),
      tipsDefault,
    ]));
    if (onResetTips) {
      const tipsReset = el("button", { style: {
        padding: "4px 10px", border: "1px solid var(--dlg-border)", borderRadius: "6px",
        background: "var(--dlg-btn-bg)", fontSize: "12px", cursor: "pointer", fontFamily: "inherit",
        color: "var(--text)", margin: "-6px 0 16px 22px", display: "block",
      } }, ["Reset tips…"]) as HTMLButtonElement;
      tipsReset.addEventListener("click", () => { onResetTips(); });
      dlg.appendChild(tipsReset);
    }

    // — Buttons —
    const btnRow = el("div", { style: { display: "flex", justifyContent: "flex-end", gap: "8px" } }) as HTMLElement;
    const resetBtn = el("button", { style: {
      padding: "6px 16px", border: "1px solid var(--dlg-border)", borderRadius: "6px",
      background: "var(--dlg-btn-bg)", fontSize: "13px", cursor: "pointer", fontFamily: "inherit", marginRight: "auto",
    } }, ["Restore Defaults"]) as HTMLButtonElement;
    const cancelBtn = el("button", { style: {
      padding: "6px 16px", border: "1px solid var(--dlg-border)", borderRadius: "6px",
      background: "var(--dlg-btn-bg)", fontSize: "13px", cursor: "pointer", fontFamily: "inherit",
    } }, ["Cancel"]) as HTMLButtonElement;
    const okBtn = el("button", { style: {
      padding: "6px 16px", border: "none", borderRadius: "6px",
      background: "var(--dlg-primary)", color: "var(--on-accent)", fontSize: "13px", cursor: "pointer", fontFamily: "inherit", fontWeight: "500",
    } }, ["OK"]) as HTMLButtonElement;
    btnRow.appendChild(resetBtn); btnRow.appendChild(cancelBtn); btnRow.appendChild(okBtn);
    dlg.appendChild(btnRow);
    ov.appendChild(dlg);

    resetBtn.addEventListener("click", () => {
      hvCb.checked = DEFAULT_OPTIONS.markHardvalues;
      signSelect.value = DEFAULT_OPTIONS.aggregateSign;
      aiCb.checked = DEFAULT_OPTIONS.assistant;
      dockCb.checked = DEFAULT_OPTIONS.docking;
      advCb.checked = DEFAULT_OPTIONS.advancedPanels;
      tipsCb.checked = DEFAULT_OPTIONS.showTips;
      signTag.textContent = "(default)";
    });
    signSelect.addEventListener("change", () => {
      signTag.textContent = signSelect.value === DEFAULT_OPTIONS.aggregateSign ? "(default)" : "";
    });

    const done = (v: UiOptions | null) => { closeOverlay(); resolve(v); };
    cancelBtn.addEventListener("click", () => done(null));
    okBtn.addEventListener("click", () => done({ markHardvalues: hvCb.checked, aggregateSign: signSelect.value, assistant: aiCb.checked, docking: dockCb.checked, advancedPanels: advCb.checked, showTips: tipsCb.checked }));
    dlg.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); done(null); }
    });
    ov.addEventListener("click", (e) => { if (e.target === ov) done(null); });
    okBtn.focus();
  });
}

/** Server-side file browser for hosts that answer `fsList` (the bridge — the runtime
 *  needs a real path, which a browser <input type=file> cannot return).
 *  Directories open on double-click or via "Up"; a file click fills the name field;
 *  OK resolves the absolute path (name + current dir), Escape/Cancel → null. */
export function browseDialog(opts: {
  title: string;
  api: OmApi;
  startDir: string;
  mode: "open" | "save";
  defaultName?: string;
}): Promise<string | null> {
  return new Promise((resolve) => {
    const ov = ensureOverlay();
    clear(ov);
    const sepOf = (d: string) => (d.includes("\\") ? "\\" : "/");

    const dlg = el("div", { class: "dlg", style: {
      background: "var(--popup-bg)", borderRadius: "10px", padding: "16px",
      width: "460px", maxWidth: "90vw", boxShadow: "var(--dlg-shadow)",
      fontFamily: "-apple-system, system-ui, sans-serif",
    } }) as HTMLElement;
    dlg.appendChild(el("div", { style: { fontSize: "13px", fontWeight: "600", marginBottom: "10px", color: "var(--dlg-title)" } }, [opts.title]));

    const dirLabel = el("div", { style: { fontSize: "11px", color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: "1" } });
    const upBtn = el("button", { style: {
      padding: "3px 10px", border: "1px solid var(--dlg-border)", borderRadius: "6px",
      background: "var(--dlg-btn-bg)", fontSize: "12px", cursor: "pointer", fontFamily: "inherit", marginRight: "8px",
    }, title: "Up one folder" }, ["Up"]) as HTMLButtonElement;
    dlg.appendChild(el("div", { style: { display: "flex", alignItems: "center", marginBottom: "8px" } }, [upBtn, dirLabel]));

    const list = el("div", { style: {
      height: "220px", overflowY: "auto", border: "1px solid var(--dlg-border)",
      borderRadius: "6px", background: "var(--input-bg)", marginBottom: "10px",
    } }) as HTMLElement;
    dlg.appendChild(list);

    const nameInput = document.createElement("input") as HTMLInputElement;
    nameInput.type = "text";
    nameInput.value = opts.mode === "save" ? (opts.defaultName ?? "") : "";
    nameInput.placeholder = opts.mode === "save" ? "File name" : "Select a file above";
    nameInput.style.cssText = "width: 100%; box-sizing: border-box; padding: 7px 10px; background: var(--input-bg); border: 1px solid var(--dlg-border); border-radius: 6px; font-size: 13px; font-family: inherit; margin-bottom: 12px;";
    dlg.appendChild(nameInput);

    const btnRow = el("div", { style: { display: "flex", justifyContent: "flex-end", gap: "8px" } }) as HTMLElement;
    const mkBtn = (label: string, primary = false) => el("button", { style: {
      padding: "6px 16px", borderRadius: "6px", fontSize: "13px", cursor: "pointer", fontFamily: "inherit",
      border: primary ? "none" : "1px solid var(--dlg-border)",
      background: primary ? "var(--dlg-primary)" : "var(--dlg-btn-bg)",
      color: primary ? "var(--on-accent)" : "inherit",
    } }, [label]) as HTMLButtonElement;
    const cancelBtn = mkBtn("Cancel"), okBtn = mkBtn(opts.mode === "save" ? "Save" : "Open", true);
    btnRow.appendChild(cancelBtn); btnRow.appendChild(okBtn);
    dlg.appendChild(btnRow);
    ov.appendChild(dlg);

    let dir = opts.startDir || "/";
    let selected = "";

    const render = async () => {
      dirLabel.textContent = dir;
      list.innerHTML = "";
      let r;
      try { r = await opts.api.fsList(dir); }
      catch (e: any) { list.appendChild(el("div", { style: { padding: "10px", color: "var(--error, #c00)", fontSize: "12px" } }, [String(e?.message || e)])); return; }
      dir = r.dir;
      dirLabel.textContent = dir;
      upBtn.disabled = !r.parent;
      const sep = sepOf(dir);
      const row = (name: string, isDir: boolean) => {
        const item = el("div", { class: "browse-item", style: {
          padding: "4px 10px", fontSize: "13px", cursor: "default", display: "flex", gap: "6px",
          color: isDir ? "var(--accent)" : "inherit",
        } }, [isDir ? `${name}/` : name]);
        item.addEventListener("click", () => {
          if (isDir) return;
          selected = name;
          nameInput.value = name;
          list.querySelectorAll(".browse-item").forEach((x) => (x as HTMLElement).style.background = "");
          item.style.background = "var(--selection)";
        });
        item.addEventListener("dblclick", () => {
          if (isDir) { dir = dir.replace(/[\\/]+$/, "") + sep + name; void render(); }
          else { selected = name; nameInput.value = name; void done(join()); }
        });
        return item;
      };
      for (const d of r.dirs) list.appendChild(row(d, true));
      for (const f of r.files) list.appendChild(row(f, false));
      if (!r.dirs.length && !r.files.length) list.appendChild(el("div", { class: "muted", style: { padding: "10px", fontSize: "12px" } }, ["Empty folder"]));
    };

    const join = (): string | null => {
      const name = nameInput.value.trim();
      if (!name) return null;
      const sep = sepOf(dir);
      return name.includes("/") || name.includes("\\") ? name : dir.replace(/[\\/]+$/, "") + sep + name;
    };
    const done = (v: string | null) => { closeOverlay(); resolve(v); };

    upBtn.addEventListener("click", () => { void opts.api.fsList(dir).then((r) => { if (r.parent) { dir = r.parent; void render(); } }); });
    cancelBtn.addEventListener("click", () => done(null));
    okBtn.addEventListener("click", () => done(join()));
    nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); done(join()); }
      else if (e.key === "Escape") { e.preventDefault(); done(null); }
    });
    dlg.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); done(null); } });
    ov.addEventListener("click", (e) => { if (e.target === ov) done(null); });
    nameInput.focus();
    void render();
  });
}

function clear(node: HTMLElement) { while (node.firstChild) node.removeChild(node.firstChild); }

/** Share Session dialog (web build): generates a link that opens this exact screen for
 *  the recipient. The dialog owns the reachability question — when the model is a local
 *  file it asks once for a public model link and bakes model.url into everything it
 *  produces (the self-contained #session= link and the downloadable session file for
 *  self-hosting). Local model paths stay untouched when no URL is given: the session
 *  still resolves on this machine or a shared drive. Informational — resolves on close. */
export function shareSessionDialog(opts: {
  /** Set when the model source is a local path (not an https URL or om-example ref). */
  localModel: string | null;
  /** Rebuilds the descriptor with model.url baked in; selfLink is null when too big for a URL. */
  build: (modelUrl: string | null) => { json: string; selfLink: string | null };
  makeLink: (sessionFileUrl: string) => string;
  /** Bundles the descriptor + live model into an .omz and saves it via the host flow. */
  onDownload: (json: string) => Promise<void>;
  /** Saves the bare .omsession.json — the live-reference variant for places where
   *  the model path/URL is already reachable. */
  onDownloadSession: (json: string) => Promise<void>;
}): Promise<void> {
  return new Promise((resolve) => {
    const ov = ensureOverlay();
    clear(ov);
    const dlg = el("div", { class: "dlg", style: {
      background: "var(--popup-bg)", borderRadius: "10px", padding: "20px",
      minWidth: "340px", maxWidth: "460px", boxShadow: "var(--dlg-shadow)",
      fontFamily: "-apple-system, system-ui, sans-serif",
    } }) as HTMLElement;
    dlg.appendChild(el("div", { style: { fontSize: "13px", fontWeight: "600", marginBottom: "10px", color: "var(--dlg-title)" } }, ["Share"]));
    dlg.appendChild(el("div", { class: "muted", style: { fontSize: "12px", marginBottom: "12px", lineHeight: "1.45" } },
      ["A session link opens this exact screen — panes, tabs, chips, selection and scroll — for anyone who clicks it."]));

    const row = (label: string, value: string): HTMLElement => {
      const wrap = el("div", { style: { marginBottom: "12px" } });
      wrap.appendChild(el("div", { style: { fontSize: "12px", fontWeight: "600", marginBottom: "4px", color: "var(--dlg-title)" } }, [label]));
      const box = el("div", { style: { display: "flex", gap: "6px" } });
      const input = document.createElement("input") as HTMLInputElement;
      input.type = "text"; input.value = value; input.readOnly = true;
      input.style.cssText = "flex:1; box-sizing:border-box; padding:6px 10px; background:var(--input-bg); border:1px solid var(--dlg-border); border-radius:6px; font-size:12px; font-family:inherit;";
      const copy = el("button", { style: { padding: "6px 12px", border: "1px solid var(--dlg-border)", borderRadius: "6px", background: "var(--dlg-btn-bg)", fontSize: "12px", cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" } }, ["Copy"]) as HTMLButtonElement;
      copy.addEventListener("click", () => {
        input.select();
        const didCopy = () => { copy.textContent = "Copied"; setTimeout(() => { copy.textContent = "Copy"; }, 1500); };
        if (navigator.clipboard?.writeText) void navigator.clipboard.writeText(input.value).then(didCopy, () => { document.execCommand("copy"); didCopy(); });
        else { document.execCommand("copy"); didCopy(); }
      });
      box.appendChild(input); box.appendChild(copy);
      wrap.appendChild(box);
      return wrap;
    };
    const entry = (placeholder: string, oninput: (v: string) => void): HTMLInputElement => {
      const input = document.createElement("input") as HTMLInputElement;
      input.type = "text";
      input.placeholder = placeholder;
      input.style.cssText = "width:100%; box-sizing:border-box; padding:6px 10px; background:var(--input-bg); border:1px solid var(--dlg-border); border-radius:6px; font-size:12px; font-family:inherit; margin-bottom:8px;";
      input.addEventListener("input", () => oninput(input.value.trim()));
      return input;
    };

    let current = opts.build(null);
    const dynamic = el("div");

    // The model's reachability, asked once and only when it isn't already a URL.
    let modelInput: HTMLInputElement | null = null;
    if (opts.localModel) {
      const name = opts.localModel.split(/[\\/]/).pop() || opts.localModel;
      const block = el("div", { style: { marginBottom: "12px" } });
      block.appendChild(el("div", { style: { fontSize: "12px", marginBottom: "6px", lineHeight: "1.45", color: "var(--dlg-title)" } },
        [`The model is a local file (${name}). The link below works for anyone who can reach that path — this machine or a shared drive.`]));
      block.appendChild(el("div", { class: "muted", style: { fontSize: "12px", marginBottom: "6px", lineHeight: "1.45" } },
        ["To share with anyone on the web: upload the model file (GitHub, cloud drive, your site — anywhere that gives a public link) and paste it here:"]));
      modelInput = entry("https://… public link to your model file", (v) => {
        current = opts.build(/^https?:\/\//.test(v) ? v : null);
        renderDynamic();
      });
      block.appendChild(modelInput);
      dlg.appendChild(block);
    }

    const renderDynamic = () => {
      clear(dynamic);
      if (current.selfLink)
        dynamic.appendChild(row("Ready to share — everything is inside this link, nothing to host", current.selfLink));
      else
        dynamic.appendChild(el("div", { class: "muted", style: { fontSize: "12px", marginBottom: "12px", lineHeight: "1.45" } },
          ["This layout is too big to fit inside a link — share it as a file instead:"]));

      const fileBlock = el("div", { style: { marginBottom: "10px" } });
      fileBlock.appendChild(el("div", { style: { fontSize: "12px", fontWeight: "600", marginBottom: "6px", color: "var(--dlg-title)" } },
        ["Share as a file — one upload, nothing else needed"]));
      fileBlock.appendChild(el("div", { class: "muted", style: { fontSize: "12px", marginBottom: "8px", lineHeight: "1.45" } },
        ["An .omz bundle has the model and this session inside one file. Save it, upload it anywhere public, then paste its link below."]));
      const dlRow = el("div", { style: { display: "flex", gap: "6px", marginBottom: "8px", flexWrap: "wrap" } });
      const dlBtn = el("button", { style: { padding: "6px 12px", border: "1px solid var(--dlg-border)", borderRadius: "6px", background: "var(--dlg-btn-bg)", fontSize: "12px", cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" } },
        ["Save bundle (.omz)…"]) as HTMLButtonElement;
      dlBtn.addEventListener("click", () => { dlBtn.disabled = true; void opts.onDownload(current.json).finally(() => { dlBtn.disabled = false; }); });
      const sessBtn = el("button", { style: { padding: "6px 12px", border: "1px solid var(--dlg-border)", borderRadius: "6px", background: "var(--dlg-btn-bg)", fontSize: "12px", cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" } },
        ["Save session file only…"]) as HTMLButtonElement;
      sessBtn.title = "Just the layout — points at the model. Share it where the model path/link is reachable.";
      sessBtn.addEventListener("click", () => { sessBtn.disabled = true; void opts.onDownloadSession(current.json).finally(() => { sessBtn.disabled = false; }); });
      dlRow.appendChild(dlBtn); dlRow.appendChild(sessBtn);
      fileBlock.appendChild(dlRow);
      fileBlock.appendChild(entry("https://… public link to the .omz file", (v) => {
        clear(outWrap);
        if (/^https?:\/\//.test(v)) outWrap.appendChild(row("Share link", opts.makeLink(v)));
      }));
      fileBlock.appendChild(outWrap);
      dynamic.appendChild(fileBlock);
    };
    const outWrap = el("div");
    renderDynamic();
    dlg.appendChild(dynamic);

    dlg.appendChild(el("div", { class: "muted", style: { fontSize: "11px", marginTop: "8px", lineHeight: "1.45" } },
      ["If a hosted link doesn't open, that host isn't allowing browser access to the file — most static hosts and raw-file links do by default."]));

    const btnRow = el("div", { style: { display: "flex", justifyContent: "flex-end", marginTop: "14px" } });
    const closeBtn = el("button", { style: { padding: "6px 16px", border: "none", borderRadius: "6px", background: "var(--dlg-primary)", color: "var(--on-accent)", fontSize: "13px", cursor: "pointer", fontFamily: "inherit", fontWeight: "500" } }, ["Done"]) as HTMLButtonElement;
    btnRow.appendChild(closeBtn);
    dlg.appendChild(btnRow);
    ov.appendChild(dlg);
    (modelInput ?? dlg.querySelector("input"))?.focus();

    const done = () => { closeOverlay(); resolve(); };
    closeBtn.addEventListener("click", done);
    dlg.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); done(); } });
    ov.addEventListener("click", (e) => { if (e.target === ov) done(); });
  });
}
