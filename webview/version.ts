// Baked at build time by scripts/build.mjs (define OM_GUI_VERSION). Watch/dev
// esbuild runs don't set the define — the fallback keeps `typeof` safe.
declare const OM_GUI_VERSION: string | undefined;

/** Full om-gui build string, same shape as the engine's:
 *  {semver}-{YYYYMMDD}-{HHMMSS}-{git7}-{mode}-{toolchain}-b{n} */
export const guiVersion: string = typeof OM_GUI_VERSION === "string" ? OM_GUI_VERSION : "dev";

/** Compact display form of any OM build string (a-11-versioning.md §5):
 *  `{semver}·{git7}` — the semver is the first field, git7 the 7-hex field
 *  before MODE. Returns the input unchanged when it doesn't parse. */
export function shortForm(v: string): string {
    if (!v) return "";
    const parts = v.split("-");
    const git = parts.find(p => /^[0-9a-f]{7}$/.test(p));
    return git ? `${parts[0]}·${git}` : v;
}

/** Compact display form: semver + git7 (`0.1.0-alpha.0·138bf66`). */
export const guiVersionShort = shortForm(guiVersion);
