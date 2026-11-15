# Changelog

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
