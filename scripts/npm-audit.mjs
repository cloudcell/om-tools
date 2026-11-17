// Audit gate for CI: fails on high/critical vulnerabilities, except advisories in WAIVED —
// each with the reason it does not apply to this repo. Waiving is per-advisory: a new one fails the gate.
// Usage: node scripts/npm-audit.mjs

import { spawnSync } from "node:child_process";

const WAIVED = new Map([
  // picomatch ReDoS via crafted extglob patterns (<= 4.0.7, no patched release). Reachable only through
  // @vscode/vsce's .vscodeignore matching of our own build files — a packaging tool, never shipped in the
  // vsix (extension is bundled, packaged --no-dependencies). Downgrading vsce is not an option:
  // OIDC marketplace publishing (--oidc) exists only in vsce 4.x.
  ["GHSA-fc5q-39xc-vjpf", "dev-only packaging tool; patterns come from our own .vscodeignore; nothing shipped"],
]);

// npm audit exits nonzero when anything is flagged: the JSON is still on stdout either way.
const audit = spawnSync("npm", ["audit", "--json"], { encoding: "utf8" });
if (audit.error || !audit.stdout) {
  console.error(`npm audit could not run: ${audit.error?.message || audit.stderr}`);
  process.exit(1);
}
const report = JSON.parse(audit.stdout);
const FAIL_AT = new Set(["high", "critical"]);

const problems = [];
for (const [name, vuln] of Object.entries(report.vulnerabilities ?? {})) {
  if (!FAIL_AT.has(vuln.severity)) continue;
  const sources = (vuln.via ?? []).filter((v) => typeof v === "object" && v.url);
  const unwaived = sources.filter((v) => ![...WAIVED.keys()].some((id) => v.url.includes(id)));
  if (unwaived.length) problems.push(`  ${name} (${vuln.severity}): ${unwaived.map((v) => v.url).join(", ")}`);
}

if (problems.length) {
  console.error(`npm audit: ${problems.length} unwaived high/critical vulnerabilit${problems.length === 1 ? "y" : "ies"}:`);
  for (const p of problems) console.error(p);
  process.exit(1);
}
const waived = [...WAIVED.keys()].filter((id) => JSON.stringify(report).includes(id));
if (waived.length) console.log(`npm audit: clean except waived advisories: ${waived.join(", ")}`);
else console.log("npm audit: clean");
