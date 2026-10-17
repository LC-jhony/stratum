#!/usr/bin/env python3
"""Improve Carbon themes: visible borders, data-grid/table keys, chart palette.

Only touches `colors`; tokenColors / semanticTokenColors are preserved verbatim.
Usage: improve-themes.py <in.json> <out.json>
"""
import collections
import json
import sys

src, dst = sys.argv[1:3]
theme = json.load(open(src), object_pairs_hook=collections.OrderedDict)
c = theme["colors"]
dark = theme["type"] == "dark"
accent = c["focusBorder"]

if dark:
    subtle, strong, header, zebra = "#2A2A2A", "#3A3A3A", "#202020", "#1B1B1B"
    charts = dict(red="#E5484D", orange="#C4895C", yellow="#B5A15C", green="#4FBFA0",
                  blue="#5C9EAD", purple="#8C7BC9", pink="#C46B9B")
    hover = "#FFFFFF10"
    input_border = "#333333"
else:
    subtle, strong, header, zebra = "#E2E8F0", "#CBD5E0", "#EDF2F7", "#F7FAFC"
    charts = dict(red="#C53030", orange="#A65D3D", yellow="#A68A3D", green="#6BA63D",
                  blue="#3D6EA6", purple="#6B3DA6", pink="#A63D6B")
    hover = "#0000000A"
    input_border = strong

changed, added = [], []


def setk(k, v, only_if_missing=False):
    if k in c:
        if only_if_missing or c[k] == v:
            return
        changed.append(k)
    else:
        added.append(k)
    c[k] = v


# 1. Borders that were indistinguishable from their own background -> visible hairlines.
if dark:
    for k in ["activityBar.border", "statusBar.border", "editorGroup.border",
              "editorGroupHeader.tabsBorder", "tab.border", "sideBar.border",
              "sideBarSectionHeader.border", "notificationCenter.border",
              "notificationToast.border", "notifications.border", "titleBar.border",
              "editorWidget.border", "editorSuggestWidget.border", "panel.border",
              "peekView.border", "editorOverviewRuler.border", "debugToolBar.border"]:
        setk(k, subtle)
    setk("panelTitle.activeBorder", accent)
    setk("tab.unfocusedActiveBorderTop", strong)
    setk("editor.lineHighlightBorder", "#00000000")
    setk("editorIndentGuide.background1", subtle)
    setk("editorRuler.foreground", subtle)

# 2. Separators and surfaces every platform needs, derived from the existing palette.
setk("sideBarSectionHeader.border", subtle)
setk("tab.lastPinnedBorder", strong, True)
setk("menu.border", subtle, True)
setk("widget.border", subtle, True)
setk("terminal.border", subtle, True)
setk("checkbox.border", strong, True)
setk("sash.hoverBorder", accent, True)
setk("sideBarStickyScroll.border", subtle, True)
setk("editorStickyScroll.background", c["editor.background"], True)
setk("keybindingTable.headerBackground", header, True)
setk("keybindingTable.rowsBackground", zebra, True)
setk("settings.headerForeground", c["foreground"], True)
setk("toolbar.hoverBackground", hover, True)
setk("input.border", input_border)
setk("dropdown.border", input_border)

# 3. Table / data-grid keys (VS Code 'tree.table*' are what a grid should consume).
setk("tree.tableColumnsBorder", subtle, True)
setk("tree.tableOddRowsBackground", zebra, True)
setk("tree.indentGuidesStroke", strong, True)

# 4. Chart palette -> consumed by ERD diagrams, result charts and status badges.
setk("charts.foreground", c["foreground"], True)
setk("charts.lines", c["descriptionForeground"], True)
for name, v in charts.items():
    setk(f"charts.{name}", v, True)
setk("symbolIcon.keyForeground", charts["yellow"], True)

json.dump(theme, open(dst, "w"), indent=2, ensure_ascii=False)
print(f"{theme['name']}: {len(changed)} keys fixed, {len(added)} keys added")
