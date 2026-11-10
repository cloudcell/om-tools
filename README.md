# OM Core for VS Code

A grid GUI for [OM Core](https://github.com/cloudcell/om-core), a multidimensional
modeling engine (dimensions, cubes, rules, views), inside VS Code.

> **Preview.** This is an early version. Only the core workflow works: open a model,
> browse it, edit values and see the results recalculate, save. Everything else is
> visible but disabled (see [Not available in this preview](#not-available-in-this-preview)).

The extension is only the interface. The engine (om-core, Python) runs as a separate
local process, and you install it once, as described below.

## Requirements

- VS Code 1.80 or newer
- [Git](https://git-scm.com/downloads)
- [uv](https://docs.astral.sh/uv/), which manages Python for om-core. It downloads
  the Python version om-core needs (3.12 or newer), so you do not need to install Python yourself.

## Install

### 1. Install uv

Windows (PowerShell):

```powershell
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
```

macOS / Linux:

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

**Close and reopen VS Code afterwards.** VS Code only picks up the new `PATH` on start.

### 2. Get the engine

```bash
git clone https://github.com/cloudcell/om-core.git
cd om-core
git checkout 72a90ca
uv sync
```

- `git checkout 72a90ca` is the om-core version this extension was tested with. Newer
  versions may work, but are not checked.
- Do not skip `uv sync`. It downloads the dependencies (several hundred MB, a few
  minutes the first time). If it has not been run, the first start of the runtime takes
  longer than the extension waits (20 seconds) and fails.

### 3. Install the extension

Download `om-tools-<version>.vsix` from the
[Releases](https://github.com/cloudcell/om-tools/releases) page, then either:

```bash
code --install-extension om-tools-<version>.vsix
```

or in VS Code: **Extensions** panel → **…** menu → **Install from VSIX…**

### 4. Point the extension at the engine

Open **Settings** (`Ctrl+,`), search for `omCore`, and set **Om Core: Om Core Path** to the
folder you cloned in step 2, for example `/home/you/om-core`. <!-- check-sensitive: allow -->

Or in `settings.json`:

```json
"omCore.omCorePath": "path/to/om-core"
```

## Quick start: the coffee shop model

A three-month coffee shop model: cups sold, price, revenue, rent and profit. Revenue and profit
are calculated by rules, so changing the price changes the profit.

1. Download the example file
   ([`examples/coffee.json`](https://github.com/cloudcell/om-tools/blob/main/examples/coffee.json)),
   for instance:

   ```powershell
   Invoke-WebRequest https://raw.githubusercontent.com/cloudcell/om-tools/main/examples/coffee.json -OutFile coffee.json
   ```

2. Click the **OM Core** icon in the activity bar → **Open GUI** (or `Ctrl+Shift+P` →
   `OM Core: Open GUI`). The extension connects to the engine, or starts it for you.
3. **File → Open…** and choose `coffee.json`.
4. In the **Model Browser** on the left, open **Views → ShopView**. You get a grid with
   Cups, Price, Revenue, Rent and Profit in rows and Jan, Feb, Mar in columns.
   Profit for January is **700**.
5. Double-click **Price** for **Jan**, type `4`, press **Enter**. Revenue becomes 1600 and
   Profit becomes **1100**.
6. `Ctrl+Z` undoes the change, `Ctrl+Y` (or `Ctrl+Shift+Z`) redoes it.
7. **File → Save…** to save the model as a `.json` file. **File → Open…** loads it again.

## Commands

| Command | What it does |
|---|---|
| `OM Core: Open GUI` | Opens the grid GUI in an editor tab. Connects to a running engine, or starts one. |
| `OM Core: Start Runtime` | Starts the engine without opening the GUI. |
| `OM Core: Stop Runtime` | Stops the engine that the extension started. |
| `OM Core: Reconnect to Runtime` | Reconnects the GUI if it shows `disconnected`. |

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `omCore.omCorePath` | empty | Folder of the om-core clone. Required to start the engine from VS Code. |
| `omCore.autoStartRuntime` | `true` | Start the engine on **Open GUI** if none is running. |
| `omCore.runtimeEndpoint` | empty | Address of the engine, e.g. `tcp://127.0.0.1:17391`. Empty means the default, local port 17391. |
| `omCore.showSystemElements` | `false` | Show system elements (names starting with `%`) in the Model Browser, tabs and selectors. |

## Not available in this preview

These items are visible but disabled, with the hint "Not available in this preview version":

- Edit: Paste as New Cube, Convert Selection to Dimension Labels, Assign Item Labels from
  Selection, Delete Selected Dimension Items
- Model: Add Group to Row/Col Dim; Add Group, Move Selection To Group, Ungroup, Add Aggregate
  Item in the grid context menu
- View: Format Toolbox, Performance Watch, Timeline
- Tools: Calculation Engine, Options
- Window: New Window, Close Window
- Formatting buttons in the toolbar (Bold, Italic, Underline, Fill, Font, Format)
- Circular References tab in the bottom panel

## Known limitations

- Changes to rules and to the dimensions placed on the grid axes cannot be undone with
  `Ctrl+Z`. `Ctrl+Z` after such a change reverts the previous value edit instead. This comes
  from the engine, not from the extension.
- Number formats are not applied in the grid yet.
- The engine starts with a small placeholder model; **File → Open…** replaces it.
- `.openm` script files cannot be opened from **File → Open…**. It reads `.json` models only.
  Run `.openm` scripts with the om-core command line (`uv run python main.py --batch file.openm`).

## Troubleshooting

**"om-core path is not set" or "om-core path not found".** Set `omCore.omCorePath` (step 4) to
the folder that contains `main.py`.

**"Failed to start runtime: …".** The message ends with the engine's error output.
The usual causes:
- `uv` is not found. Install it (step 1) and restart VS Code.
- `uv sync` was not run (step 2). Run it in the om-core folder, then try again.

**The GUI shows "disconnected".** Run `OM Core: Reconnect to Runtime`.

**Another engine is already running.** If something is already listening on port 17391
(for example the om-core Qt GUI or an earlier run), the extension connects to it and you see
that engine's model. Stop that process or use `OM Core: Stop Runtime`.

## Links

- OM Core engine and documentation: <https://github.com/cloudcell/om-core>,
  <https://cloudcell.github.io/om-docs/>
- Issues: <https://github.com/cloudcell/om-tools/issues>

## License

AGPL-3.0-or-later, see [LICENSE](LICENSE).
