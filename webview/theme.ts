import type { UiTheme } from "../shared/messages";

/** Used when nothing valid is saved (T-039: dark by default). */
export const DEFAULT_THEME: UiTheme = "dark";

/** Saved value from storage: anything but "light" / "dark" falls back to the default. */
export function sanitizeTheme(raw: unknown): UiTheme {
  return raw === "light" || raw === "dark" ? raw : DEFAULT_THEME;
}

/** Colours live in styles.css under `:root` (light) and `:root[data-theme="dark"]`. */
export function applyTheme(theme: UiTheme): void {
  document.documentElement.dataset.theme = theme;
}

export function currentTheme(): UiTheme {
  return sanitizeTheme(document.documentElement.dataset.theme);
}
