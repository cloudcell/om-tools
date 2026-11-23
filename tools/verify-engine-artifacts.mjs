#!/usr/bin/env node
// Verify the bundled engine's exact pinned bytes and required legal material.
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

function digest(data, alg) { return createHash(alg).update(data).digest('hex'); }
function die(msg) { throw new Error('[engine-verify] ' + msg); }
const m = JSON.parse(readFileSync('engine/PROVENANCE.json', 'utf8'));
const wasm = readFileSync('engine/om_engine.wasm');
if (wasm.subarray(0, 4).toString('hex') !== '0061736d') die('invalid WASM magic');
if (wasm.length !== m.size_bytes) die('WASM byte count does not match pinned provenance');
const blob = digest(Buffer.concat([Buffer.from('blob ' + wasm.length), Buffer.from([0]), wasm]), 'sha1');
if (blob !== m.git_blob_sha1) die('WASM Git blob hash does not match pinned provenance');
const sha256 = digest(wasm, 'sha256');
if (m.sha256 && m.sha256 !== sha256) die('WASM SHA-256 does not match pinned provenance');
if (process.env.OM_REQUIRE_ENGINE_SOURCE_VERIFIED === '1' && (!m.engine_commit_verified || !/^[a-f0-9]{40}$/.test(m.engine_commit ?? '') || !m.sha256)) die('engine source provenance not verified; run tools/sync-engine.sh with matching Zig source checkout');
for (const p of ['legal/ENGINE-BINARY-LICENSE.md', 'legal/CORE-MATH-MIT.txt']) {
    if (!existsSync(p) || readFileSync(p).length < 100) die('missing required licence notice: ' + p);
}
if (existsSync('dist/om_engine.wasm')) {
    const dist = readFileSync('dist/om_engine.wasm');
    if (digest(dist, 'sha256') !== sha256) die('packaged engine differs from pinned engine');
    for (const p of ['ENGINE-BINARY-LICENSE.md', 'CORE-MATH-MIT.txt', 'engine-provenance.json']) {
        if (!existsSync(join('dist', p))) die('missing dist legal/provenance file: ' + p);
    }
}
console.log('[engine-verify] OK', { blob, sha256, sourceVerified: m.engine_commit_verified });
