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

Open a **new** terminal and check that it works: `uv --version` prints a version.

**Then close all VS Code windows and start VS Code again.** VS Code only picks up the new `PATH`
when it starts; **Reload Window** is not enough.

### 2. Get the engine

In a terminal, go to the folder where you want the engine to live (for example your home folder),
then run:

```bash
git clone https://github.com/cloudcell/om-core.git
cd om-core
git checkout 72a90ca
uv sync
```

- This creates an `om-core` folder there, for example `C:\Users\you\om-core` on Windows or <!-- check-sensitive: allow -->
  `/home/you/om-core` on Linux. Remember it: step 4 needs it. <!-- check-sensitive: allow -->
- `git checkout 72a90ca` is the om-core version this extension was tested with. Newer
  versions may work, but are not checked.
- Do not skip `uv sync`. It downloads the dependencies (several hundred MB, a few
  minutes the first time). If it has not been run, the first start of the runtime takes
  longer than the extension waits (20 seconds) and fails.

### 3. Install the extension

Download `om-tools-<version>.vsix` from the
[Releases](https://github.com/cloudcell/om-tools/releases) page, then in VS Code:
**Extensions** panel → **…** menu (top right of the panel) → **Install from VSIX…** → choose the file.

Or from a terminal, in the folder with the downloaded file:

```bash
code --install-extension om-tools-<version>.vsix
```

(On macOS, `code` works in a terminal only after **Shell Command: Install 'code' command in PATH**
in the VS Code command palette.)

### 4. Point the extension at the engine

Click the **OM Core** icon in the activity bar (the left edge of the window). In the side panel, press
**Settings**, then click **Choose folder…** above the **Om Core: Om Core Path** setting and choose the
`om-core` folder from step 2 (the one that contains `main.py`).

You can also skip this step: when the setting is empty, **Start Runtime** asks for the folder once and
saves it. Or type the path into the setting yourself, or put it in `settings.json`:

```json
"omCore.omCorePath": "path/to/om-core"
```

### 5. Check that everything is ready

The **OM Core** side panel shows one row per part the engine needs. Before the first start it should look
like this:

| Row | Should show |
|---|---|
| Runtime | `Not running` (it is started in the quick start below) |
| GUI | `Not open` |
| Engine path | the folder from step 2, green |
| Dependencies | `.venv found`, green |
| uv | the path to `uv`, green |

A row that is not green says what is wrong; hover over it for details. See also
[Troubleshooting](#troubleshooting).

## Quick start: a five-year financial model

The om-core folder you cloned in step 2 comes with example models in its `examples` folder.
This one is a five-year model of a fictional company (NZ Gadgets & Widgets), with views
for drivers, profit and loss, balance sheet, cash flow and valuation. The statements are
calculated by rules from the drivers, so changing a driver changes the results.

The menus and panels in the steps below (**File**, **Model Browser**, **Calculation Flow**) are inside the
**OM Core** tab, not the menus of VS Code itself.

1. In the **OM Core** side panel, press **Start Runtime** and wait until the **Runtime** row shows
   `Running` (a few seconds). Then press **Open GUI**: the **OM Core** tab opens and the **GUI** row shows
   `Connected`.
2. In the **File** menu at the top of the **OM Core** tab, choose **Open…** and pick
   `examples/DEMO-03--CALC-FLOW-20260623-0057-5Y-ONLY.json` inside the om-core folder.
3. In the **Model Browser** on the left of the tab, open **Views → Drivers**. These are the assumptions
   by year: prices, volumes, cost percentages and so on. **PriceGadgets** is **120** in every year.
4. Open **Views → PnL**. For 2028, **RevenueGadgets** is **624000** and **NetIncome** is **158112**.
5. Go back to **Drivers**, double-click **PriceGadgets** for **2028**, type `130`, press **Enter**.
   In **PnL**, 2028 **RevenueGadgets** becomes **676000** and **NetIncome** becomes **164851.2**.
   The other years do not change, because each year has its own price.
6. `Ctrl+Z` undoes the change, `Ctrl+Y` (or `Ctrl+Shift+Z`) redoes it.
7. Select a cell, for example **NetIncome** in **PnL**, and open the **Calculation Flow** tab in
   the bottom panel of the tab to see which cells it is calculated from.
8. **File → Save…** (the tab's menu) saves the model as a `.json` file. **File → Open…** loads it again.

The other files in `examples` open the same way. Some of them use features this preview
does not support yet, for example formatting.

When you are done, press **Stop Runtime** in the side panel. Closing VS Code also stops the engine
that the extension started. Either way, changes that were not saved with **File → Save…** are lost.

## The OM Core side panel

The rows at the top show the state; hover over a row for details. Some rows have a button that appears
when you hover over the row (for example Start or Stop on **Runtime**, **Open GUI** or **Reconnect** on
**GUI**, **Manage Workspace Trust** in Restricted Mode); the same actions, and more (choose or show the
om-core folder), are in the row's right-click menu. The panel header has a refresh button and, in its
**…** menu, **Reconnect**.

Below the rows, the **Actions** section has:

- **Start Runtime**, which becomes **Stop Runtime** while the engine OM Tools started is running.
- **Open GUI**, which becomes **Close GUI** while the tab is open.
- **Settings**, which opens the OM Core settings.

The runtime and GUI buttons are independent. **Open GUI** only opens the tab and connects it to an engine
that is running; it never starts one, and without an engine the tab says `disconnected` and what to do.
Closing the GUI does not stop the engine. Stopping the engine does not close the tab: it shows
`disconnected` and connects by itself when you press **Start Runtime** again, with a new, empty model.
An engine that was started outside OM Tools (a terminal, the om-core Qt GUI) has no Stop button: OM Tools
cannot stop it.

## Commands

All of these are in the command palette (`Ctrl+Shift+P`).

| Command | What it does |
|---|---|
| `OM Core: Start Runtime` | Starts the engine: `uv` runs om-core from `omCore.omCorePath`. Does not open the GUI; a GUI tab that is already open connects to it. |
| `OM Core: Stop Runtime` | Stops the engine that the extension started, with everything it started. The model in it is lost unless it was saved. |
| `OM Core: Open GUI` | Opens the grid GUI in an editor tab and connects it to a running engine. Does not start the engine. |
| `OM Core: Close GUI` | Closes the GUI tab. The engine keeps running and keeps the model. |
| `OM Core: Reconnect to Runtime` | Reconnects the GUI to a running engine if it shows `disconnected`. |
| `OM Core: Refresh Status` | Re-checks the state shown in the side panel (it also updates by itself). |
| `OM Core: Choose om-core Folder…` | Picks the om-core folder and saves it to `omCore.omCorePath` in User settings. |
| `OM Core: Open Settings` | Opens the OM Core settings. |
| `OM Core: Reveal om-core Folder in File Explorer` | Shows the om-core folder in your file manager. |

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `omCore.omCorePath` | empty | Folder of the om-core clone (the one with `main.py`). Required by **Start Runtime**; when empty, it asks for the folder once. |
| `omCore.runtimeEndpoint` | empty | Address of the engine, e.g. `tcp://127.0.0.1:17391`. Empty means the default: local TCP port 17391 on Windows, the socket `/tmp/openm-<user>.sock` on macOS and Linux. |
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
- The engine starts with a small placeholder model; **File → Open…** in the OM Core tab replaces it.
- `.openm` script files cannot be opened from **File → Open…** in the OM Core tab. It reads `.json`
  models only. Run `.openm` scripts with the om-core command line (`uv run python main.py --batch file.openm`).

## Troubleshooting

**Engine path: "Not set".** Press **Settings** in the side panel and click **Choose folder…** (step 4), or
just press **Start Runtime**: it asks for the folder. Canceling that dialog gives
"om-core path is not set".

**"omCore.omCorePath does not exist: … — trying auto-detect".** The folder in the setting is gone or
mistyped. OM Tools then asks for the folder; choose the om-core clone.

**Engine path: "… — not an om-core folder".** The setting points to a folder without `main.py` (for
example the parent folder). Choose the `om-core` folder itself.

**Dependencies: ".venv missing — run uv sync".** Run `uv sync` in the om-core folder (step 2), then
press **Start Runtime**.

**uv: "Not found" or "Not on PATH — restart VS Code".** Install uv (step 1). If it is installed, close
all VS Code windows and start VS Code again.

**"This workspace is not trusted (Restricted Mode)…".** You opened a folder that VS Code does not trust,
and OM Tools does not run code from there. Press **Manage Workspace Trust** on the **Runtime** row and trust
the folder, or open VS Code without a folder.

**"Failed to start runtime: …".** The message ends with the engine's error output.
The usual causes are the ones above: `uv` is not found, `uv sync` was not run, or the folder is not om-core.

**The GUI shows "disconnected".** If the engine is not running, press **Start Runtime** in the side panel: the tab
connects by itself. If it is running, press **Reconnect** on the GUI row (or run `OM Core: Reconnect to Runtime`).

**Another engine is already running.** If an engine is already running at the same address (on Windows,
port 17391), for example the om-core Qt GUI or an earlier run, **Open GUI** connects to it and you see
that engine's model, and **Start Runtime** does not start a second one. Stop that process where it was
started: **Stop Runtime** only stops an engine that OM Tools started itself.

## Links

- OM Core engine and documentation: <https://github.com/cloudcell/om-core>,
  <https://cloudcell.github.io/om-docs/>
- Issues: <https://github.com/cloudcell/om-tools/issues>

## Development

```bash
npm install
npm run build
npm run compile
npm test
```

`npm test` talks to a running OM Core runtime and changes the model in it: use a throwaway runtime, not one with your own model.

The runtime configuration and integration notes are in [AGENTS.md](AGENTS.md). To use the extension, a compatible OM Core runtime is required.

## Community and governance

- [Contributors and acknowledgements](CONTRIBUTORS.md)
- [Contribution guidelines](CONTRIBUTING.md)
- [Contributor sign-off and license grant](legal/CONTRIBUTOR-SIGNOFFS.md)
- [Formal contributor license agreement](legal/CONTRIBUTOR-CLA.md)
- [Code of conduct](legal/CODE_OF_CONDUCT.md)
- [Security policy](SECURITY.md)
- [Brand and trademark guidance](legal/TRADEMARKS.md)
- [Third-party notices](legal/THIRD-PARTY-NOTICES.md)

## License

OM Tools is distributed under the GNU Affero General Public License, version 3 or later (`AGPL-3.0-or-later`), as declared in `package.json`, except for separately licensed materials. See [LICENSE](LICENSE), [NOTICE](NOTICE), and [third-party notices](legal/THIRD-PARTY-NOTICES.md).

OM Core is a separate repository with its own contributor policies and notices; signing an OM Tools agreement does not automatically sign an agreement for OM Core.
