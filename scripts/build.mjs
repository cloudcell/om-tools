// Build script for the release bundle: stamps the build with "<version>+<git describe>" so a
// packaged vsix can be traced back to exact source ("-dirty" when built with uncommitted changes).
// Dev/watch builds (watch:ext, watch:webview) skip this and show "dev".
// Usage: npm run build

import { build } from "esbuild";
import { execSync } from "node:child_process";
import { copyFileSync, readFileSync, chmodSync } from "node:fs";

const version = JSON.parse(readFileSync("package.json", "utf8")).version;
let commit = "nogit";
try {
  commit = execSync("git describe --always --dirty", { stdio: ["pipe", "pipe", "ignore"] }).toString().trim();
} catch { /* not a git checkout (e.g. built from a tarball): commit stays "nogit" */ }
const buildInfo = `${version}+${commit}`;

await build({
  entryPoints: ["src/extension.ts"], bundle: true, platform: "node", format: "cjs",
  external: ["vscode"], define: { OM_TOOLS_BUILD: JSON.stringify(buildInfo) }, outfile: "dist/extension.js",
});
await build({
  entryPoints: ["webview/main.ts"], bundle: true, platform: "browser", format: "iife", outfile: "dist/webview.js",
});
copyFileSync("webview/index.html", "dist/index.html");
await build({
  entryPoints: ["bridge/server.ts"], bundle: true, platform: "node", format: "cjs",
  external: ["ws"], outfile: "dist/bridge.js",
});
// TS runtime (canonical source: a sibling ts_runtime checkout). Bundled into dist/ so
// the vsix ships self-contained; OM_TS_RUNTIME_DIR overrides the checkout.
const tsRuntimeDir = process.env.OM_TS_RUNTIME_DIR || "../ts_runtime";
await build({
  entryPoints: [`${tsRuntimeDir}/src/engineWorker.ts`], bundle: true, platform: "node", format: "cjs",
  outfile: "dist/engineWorker.cjs",
});
await build({
  entryPoints: [`${tsRuntimeDir}/src/tsEngineServer.ts`], bundle: true, platform: "node", format: "cjs",
  banner: { js: "#!/usr/bin/env node" }, outfile: "dist/tsEngineServer.cjs",
});
chmodSync("dist/tsEngineServer.cjs", 0o755);
try { copyFileSync(`${tsRuntimeDir}/assets/om_engine.wasm`, "dist/om_engine.wasm"); }
catch { console.warn(`${tsRuntimeDir}/assets/om_engine.wasm missing — run its tools/sync-wasm.sh`); }
console.log(`build: ${buildInfo}  ts_runtime: ${tsRuntimeDir}`);
