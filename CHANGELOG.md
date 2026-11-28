# Changelog

## 0.1.26

- Model Browser: cube nodes expand to show attached dims (Qt parity).
- Rules panel: correct empty-state when no view is open.
- **Engine**: vendored wasm resynced to zig `4fe516e` — create_view
  fill test + helper refactor; provenance verified.

## 0.1.25

- `launch-dev.sh`: the Extension Development Host now gets its own
  extensions dir — a locally installed vsix can no longer collide with
  the dev-path extension (the duplicated sidebar sections symptom).

## 0.1.24

- **Dependency-tracking visibility**: recalc live/off pill in the status
  bar plus an Options-dialog toggle; `dep_tracking` now boots on so the
  pill reads live on a fresh engine (engine @`d9df0a3`); `set_engine`
  echoes refetch tracking state deterministically.
- Skill: bulk-load batch guidance; MCP discovery notes.
- About dialog: personal name dropped.

## 0.1.23

- Status-bar version chip now shows the host repo's git7 source commit;
  full sha in the tooltip and click-to-copy payload, `+dirty` stamped
  when the tree isn't clean at build time.
- `check:sensitive` extended to block OM model/workspace files.
- Grid no longer blanks to "Loading view…" on reload.

## 0.1.22

- Grid: selection restored after a row/column drag now persists through
  the store — a subsequent refresh no longer loses it.

## 0.1.21

- **Engine**: vendored wasm resynced to zig `1734a32` — persisted
  `col_widths` follow the column on reorder; provenance verified.
- Grid: `colWidths` re-seeds when the engine's persisted map changes.

## 0.1.20

- **Engine**: vendored wasm resynced to zig `68ea4b8` —
  `serializeSnapshot` corruption fix; provenance verified.

## 0.1.19

- `TS_RUNTIME_BUILD` is now stamped in the vendored/prebuilt fallback
  build paths too — every vsix reports which engine its bundled runtime
  came from, closing the unstamped-`tsr` gap the diagnostics report
  exposed.
- Help menu: Privacy Settings item restored in source (was a vendored
  hand-patch).

## 0.1.18

- **Engine**: vendored wasm resynced to ts_runtime `158b952f` (zig
  `f233771`) — eval-state resilience and dep-graph fixes that the 0.1.17
  package missed; provenance verified.
- **Packaging**: `vscode:prepublish` now runs
  `check-engine-freshness.mjs` — the vendored engine must match
  `ts_runtime` HEAD (skips when the checkout is absent), so a release
  can no longer ship a stale engine. Diagnostics reports annotate an
  unstamped `tsr` component accordingly.

## 0.1.17

- **Diagnostics report** (Developer → Save Diagnostics Report): gathers
  engine diagnostics, host lifecycle events, and bounded engine log into
  a scrubbed report — names are salted hashes, values are type tags,
  paths masked, settings whitelisted.
- `connect()` is now idempotent while connected — a second connect (Open
  GUI after Start Runtime, an MCP call, a second Start click) no longer
  disposes a healthy embedded engine and silently loses the workspace.

## 0.1.16

- **Engine**: vendored wasm resynced to zig `1460e04` — quadratic-memory
  fix and unsigned wasm pointer corrections, provenance verified.

## 0.1.15

- Docs: `cloudcell.om-tools` on both the VS Code Marketplace and Open VSX
  (identical vsix); exercised daily on Devin Desktop/Windsurf, verified
  on VS Code. Per-editor MCP discovery documented, plus the fixed-port /
  shared-runtime caveat.
- First release published to Open VSX via OIDC trusted publishing — no
  stored token.

## 0.1.14

- **Per-window MCP discovery**: on bind, each window writes its own
  server URL into `<workspace>/.devin/mcp_config.local.json` — Devin and
  Windsurf agents (which read project-scoped MCP config, not VS Code's
  provider API) reach their own window's embedded runtime instead of
  racing for one fixed port. The entry is removed on stop/deactivate and
  the file is gitignored.
- Releases now publish to **Open VSX** alongside the VS Marketplace —
  PAT publish when `OVSX_PAT` is set, OIDC trusted publishing once a
  trusted publisher is registered (step is non-blocking).
- README links to the browser-based Open Modeling application.

## 0.1.13

- **Tour feedback dialog**: opt-in post-tour feedback form posting to
  Google Forms — isolated `webview/vscodeFeedback.ts` (no engine access,
  no external scripts), Help menu entry, build commit embedded via
  `OM_FEEDBACK_COMMIT`.
- `.omz` hardening: import-boundary caps (entry/member/total limits),
  usize verification, compressed-size bounds (a-08-0d D.3.3).
- CSP `style-src` tightening: `cssText` strings replaced with
  `Object.assign(style, …)`; `.npmrc` audit allows token-free files,
  `min-release-age=7` added.

## 0.1.12

- **Contextual first-use tips + guided tour**: tips (`webview/tips.ts`)
  and a step-by-step tour (`webview/tour.ts`) — anchored callouts with
  arrows, a cream bubble, explainers for dims/cubes/views, pivot chips,
  rules + calc flow, @ channels, hard-value precedence, and set vs
  sequence dims. The tour re-invites on each new version and opens the
  DCF example live; privacy step covers the marketplace link and the
  local-model assistant option.
- **About dialog**: OM Core logo (CSP `img-src` unblocked), copyright +
  licence lines matching Qt, clickable om-docs link, centred layout,
  version line.
- Toolbar: inactive recalc/format clusters hidden behind feature flags.
- Paste: empty cells send `null` instead of `""` — Qt coercion parity.
- **Engine**: vendored wasm resynced to zig `156ca49` (persistent
  unseeded PRNG for RAND/RANDBETWEEN) with verified provenance, so the
  release gate passes.

## 0.1.11

- **Engine licensing + provenance**: the vendored WASM is pinned by
  `engine/PROVENANCE.json` (size, git blob SHA-1, SHA-256) and every vsix
  ships the engine binary licence, CORE-MATH attribution, and the
  provenance manifest inside `dist/`. `tools/verify-engine-artifacts.mjs`
  checks fingerprint + notices on every PR; `tools/sync-engine.sh`
  refreshes licence copies from the source checkout when available.
  README gains "Source, licensing and the bundled engine" and a
  Commercial Licensing note.

## 0.1.10

- **MCP: financial-model skill built in.** The MCP server now advertises the
  financial-modeling playbook — server instructions describe it, an
  `om-skill://` resource serves the full text, and a prompt entry point lets
  agents load it on demand. AI clients get correct modeling conventions
  (separate statement cubes, explicit formulas, scenarios, checks) without
  any local setup.

## 0.1.9

- **Delete dimension items from the grid**: select items and delete them,
  with an `item_deletion_impact` query showing which cells and rules the
  deletion would touch. The vendored engine was re-synced for deletion
  parity (cascade-guard removal).
- **`.omz` everywhere**: Save now suggests a real `OM_Workspace_<ts>.omz`
  filename (was `*.json`), and the two heaviest bundled examples —
  Valuation and Three-Statement Model — ship as `.omz` bundles that open
  the **whole workspace** (model + session), not just the model.
- **Per-pane lower panel**: each view pane remembers its own lower-panel
  tab (Rules / Calc flow / Format) — one pane's choice no longer flips
  another's.
- Webview creation is deferred during workbench startup; a filename-regex
  bug that broke activation was repaired.

## 0.1.8

- **Sessions restore the lower panel**: applying a session descriptor now
  brings back which lower-panel tab (Rules / Calc flow / Format) was open
  and whether the pane was collapsed.

## 0.1.7

- **Calc flow cross-cube navigation**: rule-panel calc-flow references now
  navigate — click opens the target view, slices page dimensions to the
  context, and selects the referenced cell.
- CI: `actions/checkout`/`actions/setup-node` bumped to the Node 24 releases
  (clears the Node 20 deprecation warning).

## 0.1.6

- **Fixed: embedded engine missing from the Marketplace build.** The CI
  package for 0.1.5 was built without the ts_runtime checkout, so the
  published vsix fell back to a socket-only bundle and Start Runtime failed
  with "ts_runtime not bundled". The engine artifacts (worker, wasm, engine
  server) are now vendored in `engine/` — refreshed from a checkout via
  `tools/sync-engine.sh` — so every build ships self-contained, and a
  checkout-free build only warns when the vendored copy is also absent.

## 0.1.5

- **Embedded engine**: the OM Core engine is now bundled inside the extension
  as WebAssembly and runs in-process — no Python, no uv, no install step.
  `omCore.engineMode` picks the backend: `auto` (default — embedded unless a
  runtime endpoint is explicitly configured), `embedded`, `socket`. The worker
  spawns lazily on first need and respawns automatically after a crash (open
  views reload; in-flight mutations error instead of replaying).
  `omCore.tsRuntimePath`/`OM_TS_RUNTIME_DIR` point at an external runtime
  build — ignored in Restricted Mode. **Install Engine and its commands are
  removed** — an external Python om-core runtime is still supported via
  `engineMode: "socket"`, `omCore.runtimeEndpoint`, and `omCore.omCorePath`.
- **Sessions and sharing**: session descriptor files capture the full UI state
  (open views, layout, options) and link back to their model; share-session
  links are self-hosted session files; `.omz` bundles zip model + session into
  one shareable file. The Share dialog owns the model-reachability question,
  and the File menu was consolidated around Open / Open Example / Save / Share.
- **File > Open Example**: a bundled catalog of demo models (three-statement,
  budget vs actual, payroll, valuation, formatting and more) opens read-only
  via the `om-example:` scheme.
- **om-gui**: the webview is now a host-agnostic library (`mount(root,
  { transport })`) shipped as `webview.js` (self-mounting iife) and
  `webview.mjs` (ESM) + `webview.css`. `WebSocketTransport` accepts a real URL
  or a `WebSocketLike` shim, so in-process backends can drive the same GUI —
  this is the seam the standalone web build mounts on.
- **Model browser**: alphabetical sort within groups ("Col 2" < "Col 10"),
  hand-drawn kind icons for dimensions/cubes/views, sequential-dimension link
  marks.
- **Community**: Feedback button in the top toolbar (GitHub Discussions →
  Ideas), GitHub / Discord / Docs links in the menubar, Help > Welcome Screen.
- **Build stamps**: every component (extension, om-gui, ts_runtime) is stamped
  at build time with `{semver}-{date}-{time}-{git7}-{mode}-{toolchain}-b{n}`;
  the status-bar version chip shows the GUI + engine builds and copies all
  four full strings for bug reports.
- **Fixes**: the views area no longer flashes on Save (save_workspace events
  skip the model refresh), accounting-formatted columns pad the missing `)`
  so digits align with parenthesized negatives, the Circular References tab
  is hidden.
- **MCP server**: the extension now exposes the connected om-core runtime to AI
  agents over MCP Streamable HTTP at `http://127.0.0.1:<port>/mcp`. Two tools —
  `om_query` and `om_command` — forward any om-core query/command through the
  same session the GUI uses, so an agent's edits refresh open views and its
  reads see your live workspace. VS Code ≥ 1.102 picks the server up
  automatically via the MCP definition provider; other clients register the URL
  manually — **OM Core: MCP Server Info** copies the URL or a `mcp.json`
  snippet. Localhost-only on an ephemeral port; the tools return a clean
  "not connected" error while the runtime is down. Settings: `omCore.mcp.enabled`
  (default on) and `omCore.mcp.port` (default `0` = ephemeral). Relative paths in
  `save_workspace`/`load_workspace` resolve against the workspace folder.
  End-to-end check: `npm run test:mcp` spawns a throwaway runtime and drives the
  tools through the real MCP client transport.
- **Fixed: raw `item_…` ids on stacked axes after external edits.** Item adds,
  renames, or recreations made by another client (an MCP agent, a second GUI)
  only re-ran `refreshModel`, which never re-fetched a cached dimension — so
  stacked row/column headers fell back to truncated item ids. `refreshModel`
  now reconciles the dimension cache against `dimension_list` (dropping stale
  or deleted entries), `event.dimension.*`/`event.workspace.*` invalidate the
  cache outright, and the stacked-axis renderer falls back to the
  server-resolved `view_*_header` labels. Check: `npm run test:dimcache`.

## 0.1.4

- **MCP server**: the extension now exposes the connected om-core runtime to AI
  agents over MCP Streamable HTTP at `http://127.0.0.1:<port>/mcp`. Two tools —
  `om_query` and `om_command` — forward any om-core query/command through the
  same session the GUI uses, so an agent's edits refresh open views and its
  reads see your live workspace. VS Code ≥ 1.102 picks the server up
  automatically via the MCP definition provider; other clients register the URL
  manually — **OM Core: MCP Server Info** copies the URL or a `mcp.json`
  snippet. Localhost-only on an ephemeral port; the tools return a clean
  "not connected" error while the runtime is down. Settings: `omCore.mcp.enabled`
  (default on) and `omCore.mcp.port` (default `0` = ephemeral). Relative paths in
  `save_workspace`/`load_workspace` resolve against the workspace folder.
  End-to-end check: `npm run test:mcp` spawns a throwaway runtime and drives the
  tools through the real MCP client transport.
- **Fixed: raw `item_…` ids on stacked axes after external edits.** Item adds,
  renames, or recreations made by another client (an MCP agent, a second GUI)
  only re-ran `refreshModel`, which never re-fetched a cached dimension — so
  stacked row/column headers fell back to truncated item ids. `refreshModel`
  now reconciles the dimension cache against `dimension_list` (dropping stale
  or deleted entries), `event.dimension.*`/`event.workspace.*` invalidate the
  cache outright, and the stacked-axis renderer falls back to the
  server-resolved `view_*_header` labels. Check: `npm run test:dimcache`.

## 0.1.4

- **Install Engine**: the extension can now download and install om-core itself —
  a managed clone in extension storage at the tested commit, verified, with `uv sync`
  run for you. New entry points: the **Install Engine** button under Settings in the
  Actions section, the Engine path row, and the prompt shown when Start Runtime finds
  no engine. Blocked in Restricted Mode; never overwrites a configured `omCorePath`.
  Manual setup (own clone + `omCore.omCorePath`) still works and takes precedence.


## 0.1.3

- Adopt the OM Core logo: the vectorised hexagon+cube mark now drives the activity
  bar button and view icons (`media/button.svg`, `media/icon.svg`), a square render
  is the Marketplace listing icon (`media/om-core-icon.png`), and the full lockup
  appears at the top of the README / Marketplace page.
- No changes to the OM Core extension functionality since 0.1.0.

## 0.1.2

- Correct the extension publisher identifier to `cloudcell` for Visual Studio Marketplace publishing.
- No changes to the OM Core extension functionality since 0.1.0.

## 0.1.0 (preview)

First public preview.

- Opens the om-core grid GUI inside a VS Code editor tab; connects to a running om-core
  runtime or starts one with `uv`.
- Model Browser, multi-level grid, pivot (page selection, moving dimensions between axes), cell
  editing with recalculation, rule bar, Rules tab, Calculation Flow tab (list and graph),
  Undo / Redo, creating dimensions, items, cubes and views.
- File → New / Open / Save through system dialogs (`.json` models).
- Resizable and collapsible left column and bottom panel.
- Everything outside this scope is visible but disabled.

Tested with om-core commit `72a90ca`.
