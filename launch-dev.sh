#!/usr/bin/env bash
# Launch Extension Development Host with the OM Core extension loaded.
#
# --extensions-dir isolates the dev host's installed extensions: a locally
# installed om-tools vsix in the normal profile would otherwise load in the
# dev host alongside the dev-path extension — same extension id contributes
# the omCore views twice (duplicated sidebar). Gitignored; VS Code populates
# it on first run.
set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec code --extensionDevelopmentPath="$DIR" --extensions-dir="$DIR/.dev-host-extensions" "$DIR"
