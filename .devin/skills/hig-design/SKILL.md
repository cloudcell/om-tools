---
name: hig-design
description: Apply Apple Human Interface Guidelines principles when designing or modifying any GUI element in the OM Core webview. Always consult docs/design-guidelines.md before writing UI code.
---

# HIG Design Skill

When designing, building, or modifying any GUI element or interaction in this project,
follow the design guidelines in `docs/design-guidelines.md`.

## When to invoke

Invoke this skill before:
- Creating a new component (panel, dialog, menu, grid, chip, etc.)
- Modifying an existing component's appearance or behaviour
- Adding a new interaction (drag-drop, keyboard shortcut, context menu, etc.)
- Changing colours, fonts, spacing, or layout
- Writing CSS

## Core principles (from Apple HIG)

1. **Purpose** — Every element serves the user's modelling task. The grid is the hero.
2. **Agency** — Stay out of the way. Every action is reversible. Never lock the user in a mode.
3. **Responsibility** — Always show current state. Never lose data silently.
4. **Familiarity** — Use spreadsheet conventions. Be consistent across the entire UI.
5. **Flexibility** — Keyboard access for everything. Respect system preferences.
6. **Simplicity** — Just what's necessary. Concise labels. Clear hierarchy.

## Quick reference

### Colours (never deviate)
- Grid lines: `#d0d0d0`
- Header bg: `#f2f4f8`, fg: `#202020`
- Selection: `rgba(42, 118, 210, 0.55)` bg, `#ffffff` fg
- Hardnumber: `#ffff99` bg, `#ff0000` triangle
- Current cell: `rgb(80, 80, 80)` 2px border
- Group outline: `rgb(25, 118, 210)` 2px
- Error: `#c00`
- Accent: `#2a76d2`

### Typography
- Font: `-apple-system, system-ui, sans-serif`
- Grid/headers: 11px regular
- Menus: 13px regular
- Panel titles: 11px semibold
- No light weights. Min size 11px.

### Interaction
- Click = select. Double-click = edit. Right-click = context menu. Drag = move.
- Every action is keyboard-reachable.
- Escape always cancels/dismisses.
- Destructive actions confirm first.
- No animation unless it communicates something essential.
- Hover state on every interactive element (`#e8eaf0`).

### Grid-specific
- Headers use `position: absolute` + CSS `transform` on scroll (NOT `position: sticky`).
- Bands merge consecutive same-label entries. Empty placeholders fill gaps.
- Group bands: ▼/▶ collapse toggle, diagonal stripe shading.
- Aggregate items: Σ symbol top-right.
- Hardnumber cells: yellow bg + red triangle.
- Z-index: data(1) < row-headers(4) < col-headers(5) < corner(10) < editor(1000) < menu(10000).

### Portability
- No VSCode/Electron APIs in webview. Only use `transport.ts` for host communication.
- Use `navigator.clipboard` with `document.execCommand` fallback.
- System font stack only (no bundled fonts).

## Checklist (run through before completing any UI change)

- [ ] Serves the user's task (Purpose)
- [ ] Doesn't obstruct the grid (Agency)
- [ ] Reversible or confirmable (Agency — forgiveness)
- [ ] Shows current state (Responsibility)
- [ ] Follows existing conventions (Familiarity)
- [ ] Keyboard-reachable (Flexibility)
- [ ] Visually minimal (Simplicity)
- [ ] Uses established colour palette
- [ ] Uses system font stack
- [ ] Provides immediate feedback
- [ ] Has hover state if interactive
- [ ] No unnecessary animation
- [ ] No VSCode-specific APIs (Portability)

If any checklist item fails, fix it before considering the work complete.
