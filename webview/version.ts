// Baked at build time by scripts/build.mjs (define OM_GUI_VERSION). Watch/dev
// esbuild runs don't set the define — the fallback keeps `typeof` safe.
declare const OM_GUI_VERSION: string | undefined;

/** Full om-gui build string, same shape as the engine's:
 *  {semver}-{YYYYMMDD}-{HHMMSS}-{git7}-{mode}-{toolchain}-b{n} */
export const guiVersion: string = typeof OM_GUI_VERSION === "string" ? OM_GUI_VERSION : "dev";

/** Compact display form: semver + git7 (`0.1.0-alpha.0·138bf66`). */
export const guiVersionShort = (() => {
    const parts = guiVersion.split("-");
    const git = parts.find(p => /^[0-9a-f]{7}$/.test(p));
    return git ? `${parts[0]}·${git}` : guiVersion;
})();
