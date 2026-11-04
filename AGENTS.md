# OM Core VSCode Extension — project notes

## What this is
A VSCode/VSCodium extension that replicates the OM Core GUI (originally a PySide6/Qt app in
om-core `lib_gui`) as a webview, and connects to the **real** om-core runtime
over its newline-delimited JSON envelope socket protocol.

## Architecture (web-portable)
- `src/` — extension host (Node). `engineClient.ts` speaks the wire protocol over `net.Socket`
  (Unix or TCP). `engineProcess.ts` launches `uv run python -O main.py --runtime`.
  `extension.ts` bridges webview postMessage <-> engine client.
- `webview/` — pure HTML/CSS/TS UI (no framework). `transport.ts` is the only VSCode coupling
  point; swap `VsCodeTransport` for a `WebSocketTransport` to run the same UI in a browser.
- `shared/messages.ts` — host<->webview message protocol.

## om-core runtime connection
- Default endpoint: TCP `127.0.0.1:17391` (env `OPENM_TRANSPORT_HOST`/`OPENM_TRANSPORT_PORT`),
  or Unix socket `OPENM_TRANSPORT_SOCKET` (default `/tmp/openm-<user>.sock`).
- Start runtime: `cd <om-core root> && OPENM_TRANSPORT_HOST=127.0.0.1 OPENM_TRANSPORT_PORT=17391 uv run python -O main.py --runtime`
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

## Design guidelines
All GUI work must follow `docs/design-guidelines.md` (derived from Apple HIG).
Quick-reference rules in `docs/design-rules.md`. Devin skill in `.devin/skills/hig-design/`.
Before writing or modifying any UI code, read the guidelines and run through the checklist
at the bottom of `docs/design-guidelines.md`.
