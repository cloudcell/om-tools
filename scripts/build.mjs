// Build script for the release bundle: stamps the build with "<version>+<git describe>" so a
// packaged vsix can be traced back to exact source ("-dirty" when built with uncommitted changes).
// Dev/watch builds (watch:ext, watch:webview) skip this and show "dev".
// Usage: npm run build

import { build, version as esbuildVersion } from "esbuild";
import { execSync } from "node:child_process";
import { copyFileSync, readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";

const version = JSON.parse(readFileSync("package.json", "utf8")).version;
let commit = "nogit";
try {
  commit = execSync("git describe --always --dirty", { stdio: ["pipe", "pipe", "ignore"] }).toString().trim();
} catch { /* not a git checkout (e.g. built from a tarball): commit stays "nogit" */ }
const buildInfo = `${version}+${commit}`;

// om-gui version — mirrors om-engine-zig-dev's gen_version.zig format:
// {semver}-{YYYYMMDD}-{HHMMSS}-{git7}-{mode}-{toolchain}-b{n}. The semver
// comes from webview/package.json (the library's own version line, not the
// extension's); the build counter persists in webview/.build_counter.
function guiVersionString() {
  const guiVer = JSON.parse(readFileSync("webview/package.json", "utf8")).version;
  const counterPath = "webview/.build_counter";
  let n = 1;
  try { n = parseInt(readFileSync(counterPath, "utf8").trim(), 10) + 1 || 1; } catch { /* first build */ }
  try { writeFileSync(counterPath, `${n}\n`); } catch { /* counter is advisory only */ }
  let git7 = "nogit";
  try { git7 = execSync("git rev-parse --short=7 HEAD", { stdio: ["pipe", "pipe", "ignore"] }).toString().trim(); } catch {}
  const d = new Date();
  const p = (v, w = 2) => String(v).padStart(w, "0");
  const stamp = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  return `${guiVer}-${stamp}-${git7}-REL-esb${esbuildVersion}-b${n}`;
}
const guiVersion = guiVersionString();
const guiDefine = { OM_GUI_VERSION: JSON.stringify(guiVersion) };

await build({
  entryPoints: ["src/extension.ts"], bundle: true, platform: "node", format: "cjs",
  external: ["vscode"], define: { OM_TOOLS_BUILD: JSON.stringify(buildInfo) }, outfile: "dist/extension.js",
});
await build({
  entryPoints: ["webview/main.ts"], bundle: true, platform: "browser", format: "iife",
  define: guiDefine, outfile: "dist/webview.js",
});
await build({
  // ESM variant of the om-gui library: exports mount()/transports, no self-mount.
  // Hosts that can import modules (om-tools-web, future embedders) use this.
  entryPoints: ["webview/index.ts"], bundle: true, platform: "browser", format: "esm",
  define: guiDefine, outfile: "dist/webview.mjs",
});
copyFileSync("webview/index.html", "dist/index.html");
await build({
  entryPoints: ["bridge/server.ts"], bundle: true, platform: "node", format: "cjs",
  external: ["ws"], outfile: "dist/bridge.js",
});
// TS runtime (canonical source: a sibling ts_runtime checkout). Bundled into dist/ so
// the vsix ships self-contained; OM_TS_RUNTIME_DIR overrides the checkout.
// Absent on machines without the checkout (e.g. CI): build a socket-only
// extension — embedded mode then needs omCore.tsRuntimePath at runtime.
const tsRuntimeDir = process.env.OM_TS_RUNTIME_DIR || "../ts_runtime";
const wasmSrc = [`${tsRuntimeDir}/assets/om_engine.wasm`, `${tsRuntimeDir}/dist/om_engine.wasm`].find(existsSync);
let tsBundled = false;
if (existsSync(`${tsRuntimeDir}/src/engineWorker.ts`)) {
  await build({
    entryPoints: [`${tsRuntimeDir}/src/engineWorker.ts`], bundle: true, platform: "node", format: "cjs",
    outfile: "dist/engineWorker.cjs",
  });
  await build({
    entryPoints: [`${tsRuntimeDir}/src/tsEngineServer.ts`], bundle: true, platform: "node", format: "cjs",
    banner: { js: "#!/usr/bin/env node" }, outfile: "dist/tsEngineServer.cjs",
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
} else {
  console.warn(`ts_runtime not found at ${tsRuntimeDir} — socket-only build (embedded mode will need omCore.tsRuntimePath)`);
}
if (wasmSrc) copyFileSync(wasmSrc, "dist/om_engine.wasm");
else if (tsBundled) console.warn("om_engine.wasm not found — embedded engine unavailable in this build");
console.log(`build: ${buildInfo}  gui: ${guiVersion}  ts_runtime: ${tsBundled ? tsRuntimeDir : "not bundled"}`);
