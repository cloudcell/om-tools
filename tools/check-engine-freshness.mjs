// tools/check-engine-freshness.mjs — fail packaging when the vendored
// engine/ copy is stale relative to a present ts_runtime checkout.
// Skips cleanly when ../ts_runtime (or OM_TS_RUNTIME_DIR) is absent —
// CI/contributors build the vsix from the vendored copy by design.
// Exit 0 = fresh or not checkable; exit 1 = stale vendored engine.
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tsr = resolve(root, process.env.OM_TS_RUNTIME_DIR || '../ts_runtime');

if (!existsSync(join(tsr, 'src/engineWorker.ts'))) {
    console.log(`engine freshness: no ts_runtime checkout at ${tsr} — skipping (vendored engine is the source)`);
    process.exit(0);
}

const versionFile = join(root, 'engine', 'VERSION');
if (!existsSync(versionFile)) {
    console.error('engine freshness: engine/VERSION missing — run tools/sync-engine.sh');
    process.exit(1);
}

// VERSION format: "ts_runtime <ver> @ <git7> (synced <iso>)"
const m = readFileSync(versionFile, 'utf8').match(/@ (\S+)/);
if (!m) {
    console.error('engine freshness: unparseable engine/VERSION — run tools/sync-engine.sh');
    process.exit(1);
}
const vendored = m[1];
const head = execFileSync('git', ['-C', tsr, 'rev-parse', '--short=7', 'HEAD'], { encoding: 'utf8' }).trim();

// The vendored git7 may be an ancestor while the checkout has moved on
// without engine-affecting changes — so compare exact HEAD match only,
// but also accept when the vendored commit is still HEAD-reachable AND
// the diff since then touches nothing under src/ or assets/.
if (vendored === head) {
    console.log(`engine freshness: vendored engine matches ts_runtime HEAD ${head}`);
    process.exit(0);
}
let engineDiff = '';
try {
    engineDiff = execFileSync('git', ['-C', tsr, 'diff', '--name-only', `${vendored}..HEAD`, '--', 'src/', 'assets/', 'package.json'], { encoding: 'utf8' }).trim();
} catch {
    // vendored commit not in this history (e.g. fresh clone) — treat as stale
    console.error(`engine freshness: vendored engine @ ${vendored} is not an ancestor of ${tsr} HEAD ${head} — run tools/sync-engine.sh`);
    process.exit(1);
}
if (engineDiff) {
    console.error(`engine freshness: vendored engine @ ${vendored} is stale — ts_runtime HEAD ${head} has engine changes:\n${engineDiff}\nrun tools/sync-engine.sh`);
    process.exit(1);
}
console.log(`engine freshness: vendored engine @ ${vendored} older than HEAD ${head} but no engine-source changes — OK`);
