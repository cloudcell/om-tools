# OM Core VSCode Extension — project notes

## What this is
A VSCode/VSCodium extension that replicates the OM Core GUI (originally a PySide6/Qt app in
om-core `lib_gui`) as a webview, and connects to the **real** om-core runtime
over its newline-delimited JSON envelope socket protocol.

## Architecture (web-portable)
- `src/` — extension host (Node). `engineClient.ts` speaks the wire protocol over `net.Socket`
  (Unix or TCP). `engineProcess.ts` launches `uv run python -O main.py --runtime`.
  `extension.ts` bridges webview postMessage <-> engine client.
- `src/backend.ts` — `EngineBackend` iface, `SocketBackend` (wraps `EngineClient`),
  `EmbeddedBackend` (spawns a `worker_threads` worker). `resolveTsRuntime()` finds the
  worker + wasm: `omCore.tsRuntimePath` setting > `OM_TS_RUNTIME_DIR` env > bundled dist/.
- TS runtime lives in a sibling `ts_runtime/` checkout (canonical source, the wasm/TS port of the engine): `omEngine.ts` hosts
  `om_engine.wasm`, `engineSession.ts` translates webview vocabulary to zig RPCs (port of
  om-tools-web's `om-web-backend.js`), `engineWorker.ts` is the worker host (sync `omz_rpc`
  must not block the extension thread), `tsEngineServer.ts` is the same engine behind the
  framed-RPC socket protocol — drop-in `OM_ENGINE_SERVER_BIN` for the remote test path
  (`./run_engine_tests.sh --ts-remote`). om-tools' build.mjs bundles it from
  `../ts_runtime` (`OM_TS_RUNTIME_DIR` override) into `dist/`, so the vsix ships
  self-contained.
- `omCore.engineMode`: `auto` (default — socket if an endpoint is configured, else embedded),
  `embedded`, `socket`. `omCore.engineStateBytes`/`engineScratchBytes` bound wasm arenas.
  `omCore.enginePreload` (default off) spawns on activate instead of first need.
- Lifecycle: the worker spawns lazily (first GUI/MCP/Start need — never on activate, every
  window activates this extension), survives GUI-tab close, dies on `deactivate()` or Stop.
  Crash → `send`/`query` auto-respawn: queries get `fresh_runtime: true` in the reply, a
  mutation errors "engine restarted — workspace empty" (never replayed), the status path
  emits `freshRuntime` so the webview reloads. Restricted Mode ignores external
  `omCore.tsRuntimePath`/`OM_TS_RUNTIME_DIR` (arbitrary code) — bundled worker only.
- Side panel is mode-adaptive (`StatusSnapshot.mode` → `buildStatusRows`): embedded shows
  Runtime+GUI only and skips all socket/fs probes; socket shows Runtime/GUI/Engine
  path/Dependencies/uv.
- `npm run test:respawn` — worker-kill/respawn smoke (needs a built ts_runtime).
- `webview/` — pure HTML/CSS/TS UI (no framework), the `om-gui` library
  (`webview/package.json`). `mount(root, { transport })` in `webview/app.ts` is the
  host contract — the host supplies a `Transport` (`transport.ts`):
  `VsCodeTransport` in the extension webview, `WebSocketTransport` in a browser
  (real ws url, or a ready-made `WebSocketLike` shim for in-process backends).
  Artifacts: `dist/webview.js` (iife, self-mounts via `main.ts` + `createTransport`
  auto-detect), `dist/webview.mjs` (ESM, exports `mount`/transports, side-effect
  free), `dist/webview.css`. om-tools-web vendors all three via `tools/sync.sh`
  and mounts the ESM build on its in-page `LocalSocket`.
- `shared/messages.ts` — host<->webview message protocol.

## om-core runtime connection
- Endpoint resolution (`findRuntime` in `src/extension.ts`), first match wins:
  1. `omCore.runtimeEndpoint` setting
  2. `OPENM_TRANSPORT_SOCKET`, or `OPENM_TRANSPORT_HOST`/`OPENM_TRANSPORT_PORT` env vars
  3. Probe `/tmp/openm-<user>.sock` (POSIX) then `tcp://127.0.0.1:17391` — first live wins
  4. Platform default for Start Runtime: unix socket `/tmp/openm-<user>.sock` on POSIX,
     TCP `127.0.0.1:17391` on Windows (mirrors om-core's own defaults)
- Starting and connecting are separate. **Start Runtime** (`startRuntimeProcess`, one launch at a time) is the only
  thing that launches the runtime; **Open GUI** and **Reconnect** (`connect`) only connect to one that answers, and
  say "disconnected" (with a hint for the page) when none does. A GUI tab that is open connects by itself when
  Start Runtime finishes. Stopping kills the whole process tree (`killProcessTree`): on Windows `uv run` is
  uv.exe → venv launcher → python.exe and `proc.kill()` ends only the first.
- `omCore.omCorePath` resolution (`resolveOmCorePath`): setting > `OM_CORE_PATH` env >
  workspace folder containing `main.py` + `lib_runtime/` + `lib_openm/` > folder-pick
  prompt (choice persisted to the setting). Required only for socket-mode Start Runtime.
- Start runtime manually: `cd <om-core root> && uv run python -O main.py --runtime`
  (binds `/tmp/openm-<user>.sock`), or set `OPENM_TRANSPORT_*` for TCP.
- Protocol: newline-delimited JSON envelopes. Topics: `request.transport.ping`,
  `request.session.open`, `request.command`, `request.query`, `request.poll_events`.
- Reply payload shape: `{status: "success"|"succeeded"|"error"|"failed", data, error}`.
  Commands return `status:"success"|"error"`; queries return `status:"succeeded"|"failed"`.

## om-core command/query gotchas (required params even when defaulted in Python)
- `create_dimension` requires `dim_type` ("set" or "seq").
- `create_dimension_item` uses `dim_id` (not `dimension_id`), `name`, `position`.
- `create_view` uses `row_dims`/`col_dims` (not `row_dimension_ids`).
- `set_rule` requires `is_anchored` (bool); `targets` is a list of `[dim_name, item_name]` pairs.
- `run_recalculation` requires `scope` (e.g. "all").
- `set_cell_hardvalue_by_addr` addr is a list of item IDs in dimension order, **including
  the `@` channel first** (e.g. `["at_value", month_item_id, metric_item_id]`).
- `delete_rule` uses `rule_id` only (no `cube_id`).

## Grid data flow
`view_row_keys`/`view_col_keys` -> `view_row_header`/`view_col_header` (per section index) ->
`cell_range` (row-major `cells`, index = `row * colKeys.length + col`).

## Build
```
npm install
npm run build        # builds dist/extension.js + dist/webview.js
```
Press F5 in VSCode (needs a launch config) or run the Extension Development Host.

## Standards source
Build conventions derived from the om-core source (`lib_gui`, `lib_gui_elements`,
`lib_contracts`, `lib_command`).
GUI layout/colors from `om-core/om-gui.conf`.

## Financial model requests
When a user asks to create, rebuild, repair, or extend a financial model in OM Core,
use `.devin/skills/financial-model/SKILL.md` before running any OM Core commands.

## Versioning
All components follow the OM build-string standard `docs/a-standards/a-11-versioning.md`:
`{semver}-{YYYYMMDD}-{HHMMSS}-{git7}-{MODE}-{toolchain}-b{seq}`, component tags
`eng`/`gui`/`ext`/`tsr`/`web`. Semvers are hand-maintained per component
(`package.json`, `webview/package.json`, engine `src/version-manual.zig`) —
never auto-bump. Display short form is always `{tag} {semver}·{git7}`.

## Design guidelines
All GUI work must follow `docs/design-guidelines.md` (derived from Apple HIG).
Quick-reference rules in `docs/design-rules.md`. Devin skill in `.devin/skills/hig-design/`.
Before writing or modifying any UI code, read the guidelines and run through the checklist
at the bottom of `docs/design-guidelines.md`.
