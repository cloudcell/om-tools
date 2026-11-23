#!/usr/bin/env bash
# sync-engine.sh — refresh the vendored engine artifacts in engine/ from a
# built ts_runtime checkout (default ../ts_runtime, OM_TS_RUNTIME_DIR override).
#
# engine/ exists so machines WITHOUT the ts_runtime checkout (CI, contributors)
# still build a complete vsix. Re-run this whenever the engine changes, then
# commit the result — engine/VERSION records which build it came from.
set -euo pipefail
cd "$(dirname "$0")/.."

TSR="${OM_TS_RUNTIME_DIR:-../ts_runtime}"
if [ ! -f "$TSR/src/engineWorker.ts" ]; then
  echo "error: no ts_runtime checkout at $TSR (set OM_TS_RUNTIME_DIR)" >&2
  exit 1
fi

# Build the checkout's own artifacts first so engine/ always matches a real
# build, not whatever happened to be in its dist/.
( cd "$TSR" && npm run build )

OUT=engine
mkdir -p "$OUT"
for f in engineWorker.cjs tsEngineServer.cjs; do
  cp "$TSR/dist/$f" "$OUT/$f"
  # esbuild embeds module paths from the source checkout — rewrite them to the
  # neutral ts_runtime/ convention (the sensitive-data gate bans private names).
  sed -i "s|// \.\./[^ ]*/ts_runtime/|// ts_runtime/|g" "$OUT/$f"
done
cp "$TSR/dist/om_engine.wasm" "$OUT/om_engine.wasm"
chmod 755 "$OUT/tsEngineServer.cjs"

# Record provenance: the checkout's package version + HEAD.
VER="$(node -p "require('$TSR/package.json').version" 2>/dev/null || echo unknown)"
GIT7="$(git -C "$TSR" rev-parse --short=7 HEAD 2>/dev/null || echo nogit)"
printf 'ts_runtime %s @ %s (synced %s)\n' "$VER" "$GIT7" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$OUT/VERSION"
# If a checked-out Zig source is available, update the downstream licence copies.
ZIG_DIR="${OM_ZIG_ENGINE_DIR:-../om-engine-zig-dev}"
if [ -f "$ZIG_DIR/BINARY-LICENSE.md" ]; then cp "$ZIG_DIR/BINARY-LICENSE.md" legal/ENGINE-BINARY-LICENSE.md; fi
if [ -f "$ZIG_DIR/vendor/core-math/LICENSE" ]; then cp "$ZIG_DIR/vendor/core-math/LICENSE" legal/CORE-MATH-MIT.txt; fi
node tools/write-engine-provenance.mjs "$ZIG_DIR"
node tools/verify-engine-artifacts.mjs
echo "engine/ synced from $TSR — $(cat "$OUT/VERSION")"
