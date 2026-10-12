# Viewer plugins

This folder holds the viewer plugin contract (`types.ts`), the shared overlay layer (`overlay.ts`)
and the built-in plugins:

- `measure/`: `measurePlugin()`, distance measurement with snapping (tool, overlay, toolbar toggle,
  context menu entry);
- `color/`: `colorPlugin()`, "Change colour" submenu of named colours / "Reset colour" context menu entries (the worked example);
- `status/`: `statusPlugin()`, a legend of statuses and states built from pasted or dropped
  (`.csv` / `.tsv` / `.txt`) `Tag  Status  State  Colour` rows, matched against node names
  (toolbar toggle, panel, async resolution, selection and colour overrides per state, files claimed
  through `ui.models.addFileHandler`; `parse.ts` holds the row, file name and colour parsing);
- `sets/`: `setsPlugin()`, a list of saved property searches: a key and typed or pasted values,
  matched with `viewer.findObjects` (toolbar toggle, panel with per-set select / isolate / remove,
  missing values, async resolution; no colours).

How to write a viewer plugin (lifecycle, everything a plugin can use, rules, walkthrough) is
documented in [`docs/PLUGIN_API.md`](../../docs/PLUGIN_API.md). Built-in plugins follow the same
rule as third-party ones: they use only the public `ViewerApi` and the plugin context, never
`src/core`, `src/gl`, `src/render` or `@internal` members.
