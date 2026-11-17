// Build script for the release bundle: stamps the build with "<version>+<git describe>" so a
// packaged vsix can be traced back to exact source ("-dirty" when built with uncommitted changes).
// Dev/watch builds (watch:ext, watch:webview) skip this and show "dev".
// Usage: npm run build

import { build } from "esbuild";
import { execSync } from "node:child_process";
import { copyFileSync, readFileSync } from "node:fs";

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
console.log(`build: ${buildInfo}`);
