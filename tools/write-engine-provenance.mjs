#!/usr/bin/env node
// Recompute provenance from the exact bundled bytes; verify against a local
// Zig build when available. Does not assert legal copyright ownership.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
const sourceDir = process.argv[2] || process.env.OM_ZIG_ENGINE_DIR || '../om-engine-zig-dev';
const data = readFileSync('engine/om_engine.wasm');
const hex = (b, algo) => createHash(algo).update(b).digest('hex');
const sha256 = hex(data, 'sha256');
const gitBlob = hex(Buffer.concat([Buffer.from('blob ' + data.length), Buffer.from([0]), data]), 'sha1');
const git = (...args) => { try { return execFileSync('git', args, { encoding:'utf8', stdio:['ignore','pipe','ignore'] }).trim(); } catch { return null; } };
const commit = existsSync(join(sourceDir, '.git')) ? git('-C', sourceDir, 'rev-parse', 'HEAD') : null;
const sourceBinary = join(sourceDir, 'zig-out/bin/om_engine.wasm');
const clean = commit && git('-C', sourceDir, 'status', '--porcelain') === '';
const sourceManifest = join(sourceDir, 'zig-out/bin/om_engine.provenance.json');
let attested = null;
try { attested = JSON.parse(readFileSync(sourceManifest, 'utf8')); } catch {}
const matched = !!(clean && existsSync(sourceBinary) &&
    hex(readFileSync(sourceBinary), 'sha256') === sha256 &&
    attested?.sha256 === sha256 && attested?.engine_commit === commit);
const m = {
    schema: 'cloudcell.om-engine-artifact.v1',
    component: 'om-engine-zig',
    artifact: 'engine/om_engine.wasm',
    size_bytes: data.length,
    git_blob_sha1: gitBlob,
    sha256,
    engine_repository: 'cloudcell/om-engine-zig-dev',
    engine_commit: matched ? commit : null,
    engine_commit_verified: matched,
    source_provenance: matched ? 'Matched local clean Zig repository build and git commit' : 'NOT VERIFIED: rebuild the matching Zig source to verify',
    ts_runtime_version: readFileSync('engine/VERSION','utf8').trim(),
    binary_license: 'legal/ENGINE-BINARY-LICENSE.md',
    third_party_notices: ['legal/CORE-MATH-MIT.txt'],
    released_as_part_of: 'official Cloudcell OM Tools distribution only'
};
writeFileSync('engine/PROVENANCE.json', JSON.stringify(m,null,2)+'\n');
console.log('engine provenance', {sha256, gitBlob, sourceVerified: matched, commit:m.engine_commit});
