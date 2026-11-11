#!/usr/bin/env bash
# start.sh — build and launch the OM Core webview GUI in a browser.
#
# Usage:
#   ./start.sh                          # auto-detect runtime endpoint, GUI on 17392
#   ./start.sh --endpoint tcp://127.0.0.1:17393   # connect to a different runtime
#   ./start.sh --port 18000             # serve GUI on a different port
#   ./start.sh --no-build               # skip the build step
#   ./start.sh --no-open                # don't auto-open the browser
#
# The om-core runtime must already be running and listening
# on the endpoint. The GUI is served by the bridge over HTTP+WebSocket.

set -euo pipefail
cd "$(dirname "$0")"

ENDPOINT=""
PORT="17392"
DO_BUILD=1
DO_OPEN=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --endpoint) ENDPOINT="$2"; shift 2 ;;
    --port)     PORT="$2"; shift 2 ;;
    --no-build) DO_BUILD=0; shift ;;
    --no-open)  DO_OPEN=0; shift ;;
    -h|--help)
      echo "Usage: $0 [--endpoint tcp://HOST:PORT] [--port PORT] [--no-build] [--no-open]"
      exit 0 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# --- Resolve endpoint (unless --endpoint was given): OPENM_TRANSPORT_* env, then
# the user's default unix socket when one exists, else TCP. Mirrors the extension. ---
if [[ -z "$ENDPOINT" ]]; then
  if [[ -n "${OPENM_TRANSPORT_SOCKET:-}" ]]; then
    ENDPOINT="unix://${OPENM_TRANSPORT_SOCKET}"
  elif [[ -n "${OPENM_TRANSPORT_HOST:-}${OPENM_TRANSPORT_PORT:-}" ]]; then
    ENDPOINT="tcp://${OPENM_TRANSPORT_HOST:-127.0.0.1}:${OPENM_TRANSPORT_PORT:-17391}"
  elif [[ -S "/tmp/openm-${USER}.sock" ]]; then
    ENDPOINT="unix:///tmp/openm-${USER}.sock"
  else
    ENDPOINT="tcp://127.0.0.1:17391"
  fi
fi

# --- Build ---
if [[ "$DO_BUILD" -eq 1 ]]; then
  echo "Building webview + bridge..."
  npm run build:webview >/dev/null 2>&1
  npm run build:bridge >/dev/null 2>&1
  echo "Build complete."
fi

# --- Kill any existing bridge on this port ---
if command -v fuser >/dev/null 2>&1; then
  fuser -k "${PORT}/tcp" 2>/dev/null || true
elif command -v lsof >/dev/null 2>&1; then
  lsof -ti :"$PORT" | xargs -r kill 2>/dev/null || true
fi

# --- Start the bridge ---
echo "Starting bridge on http://127.0.0.1:${PORT} -> ${ENDPOINT}"
node dist/bridge.js --endpoint "$ENDPOINT" --port "$PORT" &
BRIDGE_PID=$!

# --- Wait for the bridge to be ready ---
for i in $(seq 1 20); do
  if curl -s "http://127.0.0.1:${PORT}/" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

URL="http://127.0.0.1:${PORT}"
echo ""
echo "  GUI is running at: ${URL}"
echo "  Bridge PID: ${BRIDGE_PID}"
echo ""

# --- Open the browser ---
if [[ "$DO_OPEN" -eq 1 ]]; then
  xdg-open "$URL" >/dev/null 2>&1 || true
fi

# --- Keep the bridge in the foreground so Ctrl-C kills it cleanly ---
trap "kill ${BRIDGE_PID} 2>/dev/null || true; exit 0" INT TERM EXIT
wait "$BRIDGE_PID"
