#!/usr/bin/env bash
# Launch Extension Development Host with the OM Core extension loaded.
set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec code --extensionDevelopmentPath="$DIR" "$DIR"
