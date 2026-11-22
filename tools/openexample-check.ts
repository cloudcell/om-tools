// tools/openexample-check.ts — resolveExampleRef unit checks (plain node, no vscode).
// Run: npm run test:openexample
import * as path from "path";
import { resolveExampleRef, type ExampleCatalog } from "../src/fileParams";
import catalogData from "../shared/catalog.json";

const catalog = catalogData as ExampleCatalog;
const DIR = "/ext/dist/examples";
let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra = "") => { if (cond) { pass++; console.log(`ok   ${name} ${extra}`); } else { fail++; console.log(`FAIL ${name} ${extra}`); } };

// Valid ids resolve inside the examples dir.
for (const e of catalog.examples) {
  const p = resolveExampleRef(`om-example:${e.id}`, catalog, DIR);
  ok(`om-example:${e.id}`, p === path.join(DIR, e.file), p);
}

// Malformed refs and non-allowlisted ids are rejected before any fs use.
const bad: Array<[string, RegExp]> = [
  ["om-example:../package.json", /invalid example reference/],
  ["om-example:a/b", /invalid example reference/],
  ["om-example:UPPER", /invalid example reference/],
  ["om-example:", /invalid example reference/],
  ["om-example:not-in-catalog", /unknown example/],
  ["om-example:three-statement/x", /invalid example reference/],
];
for (const [ref, pat] of bad) {
  try { resolveExampleRef(ref, catalog, DIR); ok(`rejects ${ref}`, false, "accepted"); }
  catch (e: any) { ok(`rejects ${ref}`, pat.test(e?.message || ""), e?.message); }
}

// A catalog entry whose file escapes the dir is rejected too.
const evil: ExampleCatalog = { examples: [{ id: "x", title: "t", description: "", category: "", file: "../evil.json" }] };
try { resolveExampleRef("om-example:x", evil, DIR); ok("rejects traversal in catalog file", false, "accepted"); }
catch (e: any) { ok("rejects traversal in catalog file", /bad catalog file/.test(e?.message || ""), e?.message); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
