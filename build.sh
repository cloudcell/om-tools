#!/usr/bin/env bash
# build.sh — build the installable extension package (om-tools-<version>.vsix).
#
# Usage:
#   ./build.sh                  # full build -> om-tools-<version>.vsix
#   code --install-extension om-tools-<version>.vsix      # install it yourself (any VS Code fork's CLI works)
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

VSIX="$(ls -t om-tools-*.vsix | head -1)"
echo
echo "Built: $VSIX"
echo "Install: code --install-extension $VSIX"
