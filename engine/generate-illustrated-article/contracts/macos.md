### Macos mockup contract (macos projects ONLY — replaces the web rules above)

> Extracted verbatim from `generate-illustrated-article/SKILL.md` (Phase 3) on 2026-09-07 so the skill body stays under cursor-agent's ~100k-character inline cap. SKILL.md's Phase 3 gate for `app_type: "macos"` points here; this file **is** the contract — follow it exactly as if it were printed there. Keep it in sync with the lint (`scripts/lint_mockup_fidelity.js`) like any other contract text.

For `app_type: "macos"` projects every screenshot is a native Mac window, authored with the Puppertino widget classes (`p-*`), the `desktop-*` mac chrome, and the `macos-*` frame classes already shipped in `branding.css`. The generic contract still holds — verbatim copy from the `.xib` sources, realistic populated content, no invented colours, no annotations, chrome-once/clone-and-edit across steps — but the web rules about layouts and app CSS do not apply. Instead:

- **`view_sources.json` for macos:** `framework: "macos"`; per step, `url_or_route` = the view's key (`""`, `"preferences/transfers"`, …), `primary_view` = the view's `definition_file` from `view_index` (a real `.xib`/`.storyboard` path opened with Read), **omit the `layout` key**, `partials_expanded` = the entry's `controller` when its labels are code-defined + the main xib when the main window is visible, `verbatim_evidence` = ≥3 real strings from the xib — **no `&`, `<`, `>`, or `"` characters** (xib XML entity-encodes them, so `Support & Development` fails the source check) **and never composed accelerator strings** ("⌘," exists in no source file — labels only; `.strings`-file strings use the `{"string": …, "found_in": …}` form). **No emoji.** Persist newly-resolved views to `project_map.view_index`.
- **Skeleton** (chrome authored once, then cloned per step):

  ```html
  <!doctype html>
  <html>
  <head><meta charset="utf-8"><!-- INJECT_CSS --></head>
  <body class="desktop-stage" data-viewport="macos">              <!-- menu step: add macos-stage--menubar -->
    <!-- MENU-NAVIGATION STEP ONLY (invoked_from names a menu): strip BEFORE the window -->
    <div class="macos-menubar">
      <span class="macos-menubar-apple"></span>
      <span class="macos-menubar-item macos-menubar-item--app">AppName</span>
      <span class="macos-menubar-item macos-menu-open">Edit
        <ul class="macos-menu">
          <li class="macos-menu-item macos-menu-item--hover">Target Item…<span class="macos-menu-shortcut">⌘K</span></li>
          <li class="macos-menu-item">Other Item</li>
        </ul>
      </span>
      <span class="macos-menubar-item">View</span> <!-- …every app_shell.menus key in order… -->
    </div>
    <div class="desktop-window desktop-window--mac">
      <div class="desktop-titlebar desktop-titlebar--macos-unified">
        <div class="desktop-traffic-lights"><span></span><span></span><span></span></div>
        <div class="desktop-window-title">App name</div>
        <div class="macos-toolbar-items"> <button class="macos-toolbar-item"><svg …></svg></button> … </div>
      </div>
      <div class="desktop-window-content">
        …source list / filterbar per app_shell…
        <!-- list-based client areas: one .macos-list-cell per row, sub-elements = the view's row_anatomy.
             .macos-table-header/.macos-table-row are ONLY for real column grids. -->
        <div class="macos-list-cell">
          <div class="macos-list-cell-title">item name</div>
          <div class="macos-list-progress"><div class="macos-list-progress-fill" style="width: 64%;"></div></div>
          <div class="macos-list-cell-status">secondary status line</div>
        </div>
        <div class="macos-statusbar">…</div>
      </div>
    </div>
  </body>
  </html>
  ```

  **Pane-host steps** (Preferences/Settings pane, Inspector tab) use the compact-window skeleton — the tab strip is `.macos-tab-strip`, never text chips, and the window title is the **selected pane's title** (macOS convention), not the window's generic name:

  ```html
  <body class="desktop-stage" data-viewport="macos">
    <div class="desktop-window desktop-window--mac macos-window--compact" style="width: 700px;">
      <div class="desktop-titlebar">
        <div class="desktop-traffic-lights"><span></span><span></span><span></span></div>
        <div class="desktop-window-title">Bandwidth</div>
      </div>
      <div class="desktop-window-content">
        <div class="macos-tab-strip">
          <span class="macos-tab"><svg …></svg>General</span>
          <span class="macos-tab macos-tab--selected"><svg …></svg>Bandwidth</span>
          <!-- …every pane tab in order… -->
        </div>
        <div style="padding: 20px 26px;"> …controls[] top-to-bottom AS RECORDED — the xib order IS the layout… </div>
      </div>
    </div>
  </body>
  ```
  `data-viewport="macos"` always. The titlebar forks on `app_shell.titlebar_style` — `"unified"` uses the modifier above with toolbar items from `app_shell.toolbar` (icons = simple inline-SVG approximations of the recorded SF Symbol name hints, **never the symbol name as text**; `toolbar: []` ⇒ traffic lights + title only); `"classic"` uses the plain 38px `.desktop-titlebar`. Exactly one `.desktop-titlebar` either way. One window size, light appearance only.
- **A step that navigates via a menu SHOWS the open menu.** When the step's instruction is "choose X from the Y menu" (the view's `invoked_from` names a menu path), that step's screenshot IS the menubar strip with Y open and X in the `--hover` state — a bare window for a menu-navigation step fails chrome. Add class `macos-stage--menubar` to `<body>` (it stacks strip-then-window; without it the strip sits beside the window) and author `<div class="macos-menubar"><span class="macos-menubar-apple"></span><span class="macos-menubar-item macos-menubar-item--app">AppName</span><span class="macos-menubar-item">File</span>…</div>` **before** the window, with every top-level menu from `app_shell.menus` in order. The open menu: `class="macos-menubar-item macos-menu-open"` + nested `<ul class="macos-menu"><li class="macos-menu-item">Label<span class="macos-menu-shortcut">⌘O</span></li>…</ul>` — each entry of `app_shell.menus["<menu>"]`, one row per item, accelerator glyphs from `accel` (⌘⇧⌥⌃ are lint-safe), `.macos-menu-divider` rows where `divider_before` says so, a `submenu` entry as a **single row with `macos-menu-sub`** (drawn cascade arrow) — never inline its children. **The dropdown hangs from the menubar strip and must never be inside `.desktop-window`** (the window's `overflow: hidden` clips it). Non-menu steps omit the strip and the body class.
- **Sheets attach, panes host, nothing dims the screen.** A dialog invoked from a window is a **sheet**: `<div class="macos-sheet">` as a child of `.desktop-window-content`, top-anchored under the titlebar, `.macos-sheet-buttons` right-aligned (`.p-btn` default + primary) — never `position: fixed`, no backdrop. A **pane** step (`kind: "pane"`) renders its HOST window's chrome with the pane's tab/category selected and the panel content from the pane's own `view_index` entry — not the host's `controls[]`. Secondary windows (Preferences, About, utility panels) add `macos-window--compact` to `.desktop-window` so they size to content instead of the fixed main-window geometry, and stand alone in the stage (a real Preferences window is its own window, not an overlay). Popovers use `.macos-popover` anchored near their control.
- **Widgets: author real controls; `controls[]` is the completeness checklist, not the artifact.** Puppertino's patterns must be printed exactly — checkbox/radio are **label-wrapped**: `<label class="p-form-checkbox-cont"><input type="checkbox" checked><span></span>Label</label>` (the `<span>` paints the box; a bare sibling-style `<input><label>` renders as an unstyled native box here — the inverse of the win32 trap); selects are `<div class="p-form-select"><select>…</select></div>`; switches `<label class="p-form-switch"><input type="checkbox"><span></span></label>`; buttons `.p-btn` (default button gets the accent). Every `controls[]` entry appears as its widget type, **in the recorded order** (the census is ordered because the xib is — reordering sections reads as a different dialog), none invented. Sectioned panes render each `groupBox` census entry as a `fieldset`+`legend` **in census order** — the census is visually ordered at detect time, so top-to-bottom transcription IS the layout. Tables use `.macos-table` (header + rows, `--alt` stripes, `--selected` on the acted-on row) and **every row renders the view's recorded `row_anatomy`** — when it says title + progress bar + secondary status line, a bare title+status row fails structure; sidebars `.macos-source-list`; pane-host tab rows use `.macos-tab-strip` with `.macos-tab` icon+label entries (`--selected` on the current pane) — never text-only chips for icon+label tab controls.
- **Never define classes in your own `<style>` block**; inline `style=` for layout only; colours via `var(--macos-accent)` / whitelisted hexes / neutrals.
- **Icons are inline SVG** (`currentColor`), never emoji, never icon-font classes. **Realism:** populate rows with plausible app-domain data; the statusbar shows realistic totals; menu bar clock/status icons are out of scope (right side of the strip may stay empty).
- **Pre-render self-check, per step** (fix before writing the next file, not after the lint; Phase 4 re-checks the same items on the rendered PNG, and a self-check you skip here comes back as a polish ticket):
  1. If this view's `invoked_from` names a menu — is the menubar strip present with that menu open and the target item hovered?
  2. Does my section/field order equal the census order top-to-bottom? (The census is visually ordered at detect time; the xib's raw XML order is NOT the layout — when they disagree, the census wins.)
  3. Does every list row render the recorded `row_anatomy` via `.macos-list-cell` sub-elements — no bare title+status rows, no invented column grids?
  4. Does each container match its `view_index.kind` — `sheet` attached under the titlebar via `.macos-sheet` (never a centered floating modal), `window`/`panel` as its own `.desktop-window` (compact for secondary), `pane` inside its host with `.macos-tab-strip`?
