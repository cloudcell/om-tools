# OM Tools Third-Party Notices

Original OM Tools code is licensed under `AGPL-3.0-or-later`, except where an individual file or bundled component states otherwise. Third-party materials are governed by their own licenses, and those licenses are **not replaced by the OM Tools license**.

The entries below are based on `om-tools` source references and `package-lock.json` inspected on 2026-11-12. For exact versions and transitive dependency licenses, consult `package-lock.json` and each dependency's distributed license file. This document should be reviewed when dependencies or assets change; it is not an exhaustive license audit.

## Embedded icon assets

| Material | License | Source in OM Tools | Provenance |
| --- | --- | --- | --- |
| Google Material Symbols, Outlined, weight 400 (`@material-symbols/svg-400@0.23.0`) | Apache-2.0 | `webview/menuIcons.ts` (inlined SVG path data) | Google Material Symbols; see source header and [Google Material Symbols](https://github.com/google/material-design-icons) |

Apache License 2.0 text: <https://www.apache.org/licenses/LICENSE-2.0>. The source code header identifying the icon provenance should be retained.

## JavaScript and TypeScript dependencies

The following packages appear in the checked-in package lock; several are development dependencies rather than runtime-distributed components.

| Package | Locked version | License |
| --- | --- | --- |
| `ws` | 8.21.3 | MIT |
| `esbuild` | 0.20.2 | MIT |
| `typescript` | 5.9.3 | Apache-2.0 |
| `simple-git-hooks` | 2.11.1 | MIT |
| `@types/node` | 20.19.43 | MIT |
| `@types/vscode` | 1.137.0 | MIT |
| `@types/ws` | 8.18.1 | MIT |

Some transitive and platform-specific packages are also present in `package-lock.json`. Distribution must preserve any notices and license texts required by each applicable third-party license. Before publishing a VSIX, review the **actual packaged artifacts** and bundled code, rather than assuming all development dependencies ship.

## Relationship to OM Core

OM Core has its own dependencies and third-party notices. Do not copy OM Core's Lucide and Tabler icon notices into OM Tools unless those exact assets are incorporated in this repository.
