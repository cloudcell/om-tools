# Changelog

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
