#!/usr/bin/env bash
# build.sh — build the installable extension package.
#
# Usage:
#   ./build.sh                  # full build -> om-tools-<version>+<git describe>.vsix
#   code --install-extension om-tools-<version>+<git describe>.vsix   # install it (any VS Code fork's CLI works)
#
# The name carries <version>+<commit> ("-dirty" when built with uncommitted changes) so a
# vsix can be traced back to exact source; the same stamp is baked into the bundle and shown
# in the status-bar tooltip (scripts/build.mjs).
#
# The vsix is a build artifact: it is gitignored and must never be committed.
# Releases attach it to a GitHub release (see MARKETPLACE-PUBLISHING.md), not to the repo.

set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d node_modules ]; then
  echo "node_modules missing — running npm install"
  npm install
fi

npm run package

VERSION="$(node -p "require('./package.json').version")"
DESCRIBE="$(git describe --always --dirty 2>/dev/null || echo nogit)"
VSIX="om-tools-$VERSION+$DESCRIBE.vsix"
mv -f "om-tools-$VERSION.vsix" "$VSIX"

echo
echo "Built: $VSIX"
echo "Install: code --install-extension $VSIX"
