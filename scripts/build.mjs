// Build script for the release bundle. Stamps every component with the
// standard OM build string (docs/versioning.md):
//   {semver}-{YYYYMMDD}-{HHMMSS}-{git7}-{MODE}-{toolchain}-b{seq}
// semver comes from the component's own version file, git7 from the
// component's own repo, seq from a gitignored per-component .build_counter.
// Dev/watch builds (watch:ext, watch:webview) skip this and show "dev".
// Usage: npm run build

import { build, version as esbuildVersion } from "esbuild";
import { execSync } from "node:child_process";
import { copyFileSync, readFileSync, writeFileSync, chmodSync, existsSync, mkdirSync, readdirSync } from "node:fs";

const toolchain = `esb${esbuildVersion}`;

function git7(dir) {
  try {
    return execSync("git rev-parse --short=7 HEAD", { cwd: dir, stdio: ["pipe", "pipe", "ignore"] }).toString().trim();
  } catch { return "nogit"; }
}

function nextSeq(counterPath) {
  let n = 1;
  try { n = parseInt(readFileSync(counterPath, "utf8").trim(), 10) + 1 || 1; } catch { /* first build */ }
  try { writeFileSync(counterPath, `${n}\n`); } catch { /* counter is advisory only */ }
  return n;
}

// The standard OM build string (docs/versioning.md). `dir` is the component's
// repo root: its package.json supplies the semver, its .build_counter supplies
// the sequence, its HEAD supplies git7.
function omBuildString(dir, { semverFile = "package.json", counter = ".build_counter", mode = "REL" } = {}) {
  const semver = JSON.parse(readFileSync(`${dir}/${semverFile}`, "utf8")).version;
  const d = new Date();
  const p = (v, w = 2) => String(v).padStart(w, "0");
  const stamp = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  return `${semver}-${stamp}-${git7(dir)}-${mode}-${toolchain}-b${nextSeq(`${dir}/${counter}`)}`;
}

const extVersion = omBuildString(".");
const guiVersion = omBuildString("webview");
const guiDefine = { OM_GUI_VERSION: JSON.stringify(guiVersion) };

await build({
  entryPoints: ["src/extension.ts"], bundle: true, platform: "node", format: "cjs",
  external: ["vscode"], define: { OM_TOOLS_BUILD: JSON.stringify(extVersion) },
  // .md imports (the financial-model SKILL.md inlined into the MCP server) bundle as text.
  loader: { ".md": "text" }, outfile: "dist/extension.js",
});
await build({
  entryPoints: ["webview/main.ts"], bundle: true, platform: "browser", format: "iife",
  define: guiDefine, loader: { ".png": "dataurl" }, outfile: "dist/webview.js",
});
await build({
  // ESM variant of the om-gui library: exports mount()/transports, no self-mount.
  // Hosts that can import modules (om-tools-web, future embedders) use this.
  entryPoints: ["webview/index.ts"], bundle: true, platform: "browser", format: "esm",
  define: guiDefine, loader: { ".png": "dataurl" }, outfile: "dist/webview.mjs",
});
copyFileSync("webview/index.html", "dist/index.html");
// Bundled examples: repo-root examples/ + shared/catalog.json → dist/examples/.
// extension.ts resolves `om-example:<id>` refs against this directory; the
// root-anchored `examples/**` rule in .vscodeignore ships dist/ but not the source dir.
mkdirSync("dist/examples", { recursive: true });
for (const f of readdirSync("examples")) copyFileSync(`examples/${f}`, `dist/examples/${f}`);
copyFileSync("shared/catalog.json", "dist/examples/catalog.json");
await build({
  entryPoints: ["bridge/server.ts"], bundle: true, platform: "node", format: "cjs",
  external: ["ws"], outfile: "dist/bridge.js",
});
// TS runtime (canonical source: a sibling ts_runtime checkout). Bundled into dist/ so
// the vsix ships self-contained; OM_TS_RUNTIME_DIR overrides the checkout.
// Absent on machines without the checkout (e.g. CI): build a socket-only
// extension — embedded mode then needs omCore.tsRuntimePath at runtime.
const tsRuntimeDir = process.env.OM_TS_RUNTIME_DIR || "../ts_runtime";
const wasmSrc = [`${tsRuntimeDir}/assets/om_engine.wasm`, `${tsRuntimeDir}/dist/om_engine.wasm`, "engine/om_engine.wasm"].find(existsSync);
let tsBundled = false;
let tsrVersion = null;
if (existsSync(`${tsRuntimeDir}/src/engineWorker.ts`)) {
  // tsr gets its own build string stamped at compile time (TS_RUNTIME_BUILD);
  // semver/git7/counter come from the ts_runtime checkout itself.
  tsrVersion = omBuildString(tsRuntimeDir);
  const tsrDefine = { TS_RUNTIME_BUILD: JSON.stringify(tsrVersion) };
  await build({
    entryPoints: [`${tsRuntimeDir}/src/engineWorker.ts`], bundle: true, platform: "node", format: "cjs",
    define: tsrDefine, outfile: "dist/engineWorker.cjs",
  });
  await build({
    entryPoints: [`${tsRuntimeDir}/src/tsEngineServer.ts`], bundle: true, platform: "node", format: "cjs",
    define: tsrDefine, banner: { js: "#!/usr/bin/env node" }, outfile: "dist/tsEngineServer.cjs",
  });
  chmodSync("dist/tsEngineServer.cjs", 0o755);
  tsBundled = true;
} else if (existsSync(`${tsRuntimeDir}/dist/engineWorker.cjs`)) {
  // Checkout without sources — reuse its prebuilt artifacts.
  copyFileSync(`${tsRuntimeDir}/dist/engineWorker.cjs`, "dist/engineWorker.cjs");
  if (existsSync(`${tsRuntimeDir}/dist/tsEngineServer.cjs`)) {
    copyFileSync(`${tsRuntimeDir}/dist/tsEngineServer.cjs`, "dist/tsEngineServer.cjs");
    chmodSync("dist/tsEngineServer.cjs", 0o755);
  }
  tsBundled = true;
} else if (existsSync("engine/engineWorker.cjs")) {
  // No checkout (CI, contributors) — fall back to the vendored build in
  // engine/ (refresh it with tools/sync-engine.sh).
  copyFileSync("engine/engineWorker.cjs", "dist/engineWorker.cjs");
  if (existsSync("engine/tsEngineServer.cjs")) {
    copyFileSync("engine/tsEngineServer.cjs", "dist/tsEngineServer.cjs");
    chmodSync("dist/tsEngineServer.cjs", 0o755);
  }
  tsBundled = true;
  tsrVersion = readFileSync("engine/VERSION", "utf8").trim().replace(/^ts_runtime /, "");
} else {
  console.warn(`ts_runtime not found at ${tsRuntimeDir} and engine/ is empty — socket-only build (embedded mode will need omCore.tsRuntimePath)`);
}
if (wasmSrc) copyFileSync(wasmSrc, "dist/om_engine.wasm");
else if (tsBundled) console.warn("om_engine.wasm not found — embedded engine unavailable in this build");
// Ship binary terms and CORE-MATH attribution inside every VSIX. Do not
// assume the repository-wide AGPL licence applies to the separately licensed WASM.
copyFileSync("legal/ENGINE-BINARY-LICENSE.md", "dist/ENGINE-BINARY-LICENSE.md");
copyFileSync("legal/CORE-MATH-MIT.txt", "dist/CORE-MATH-MIT.txt");
copyFileSync("engine/PROVENANCE.json", "dist/engine-provenance.json");
console.log(`ext: ${extVersion}\ngui: ${guiVersion}\ntsr: ${tsBundled ? (tsrVersion ?? `${tsRuntimeDir} (prebuilt)`) : "not bundled"}`);
