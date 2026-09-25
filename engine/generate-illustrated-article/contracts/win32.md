### Win32 mockup contract (win32 projects ONLY — replaces the web rules above)

> Extracted verbatim from `generate-illustrated-article/SKILL.md` (Phase 3) on 2026-09-07 so the skill body stays under cursor-agent's ~100k-character inline cap. SKILL.md's Phase 3 gate for `app_type: "win32"` points here; this file **is** the contract — follow it exactly as if it were printed there. Keep it in sync with the lint (`scripts/lint_mockup_fidelity.js`) like any other contract text.

For `app_type: "win32"` projects every screenshot is a native Windows window, authored with the 7.css widget classes, `[role=…]` attributes, and `desktop-*`/`win32-*` frame classes already shipped in `branding.css`. The generic contract still holds — verbatim copy from the `.rc` resources, realistic populated content, no invented colours, no annotations, chrome-once/clone-and-edit across steps — but the web rules about layouts, responsive state, and app CSS do not apply. Instead:

- **`view_sources.json` for win32:** `framework: "win32"`; per step, `url_or_route` = the dialog id (or `""` for the main window), `primary_view` = the dialog's `definition_file` from `dialog_index` (a real `.rc` path opened with Read), **omit the `layout` key**, `partials_expanded` = the main `.rc` (when the main window is visible) + related source files, `verbatim_evidence` = ≥3 real strings from the `.rc` — **choose strings without `&` accelerator marks** (`CAPTION` values, `&`-free control labels): the mockup renders labels with `&` stripped, and the lint asserts evidence appears verbatim in both the source and the mockup. **No emoji.** Persist newly-resolved dialogs to `project_map.dialog_index`.
- **Skeleton** (chrome authored once, then cloned per step):

  ```html
  <!doctype html>
  <html>
  <head><meta charset="utf-8"><!-- INJECT_CSS --></head>
  <body class="desktop-stage" data-viewport="windows">
    <div class="desktop-window desktop-window--win">
      <div class="desktop-titlebar">
        <div class="desktop-window-title">new 1 - Notepad++ …real title pattern…</div>
        <div class="desktop-caption-buttons"><span class="desktop-caption-min"></span><span class="desktop-caption-max"></span><span class="desktop-caption-close"></span></div>
      </div>
      <div class="desktop-window-content">
        <ul role="menubar"> <li role="menuitem" tabindex="0">File</li> …every app_shell.nav_items entry… </ul>
        <div class="win32-toolbar"> <button class="win32-toolbar-button"><svg …></svg></button> <span class="win32-toolbar-sep"></span> … </div>
        <menu role="tablist"> <button aria-selected="true">document tab</button> … </menu>
        <div class="win32-editor">
          <div class="win32-editor-gutter">1
  2
  3</div>
          <div class="win32-editor-code"><div class="win32-editor-line">…</div>…</div>
        </div>
        <div class="status-bar"><p class="status-bar-field">…</p><p class="status-bar-field">…</p></div>
      </div>
    </div>
  </body>
  </html>
  ```
  `data-viewport="windows"` always (never the legacy `desktop` preset). The client area between the tab strip and status bar is whatever `win32_metadata.client_area` says — the `.win32-editor` block above is for editor apps; a list-view app renders a 7.css table/`.tree-view` instead. One window size, light theme only.
- **Shell-first, from `app_shell`.** Titlebar (real window-title pattern) → menu bar with **every** `nav_items` entry in real order (`&` stripped) → toolbar (when `app_shell.toolbar`) → doc tabs (when `app_shell.doc_tabs`) → client area → status bar (when `app_shell.statusbar`, with realistic `.status-bar-field` values). Dropping the menu bar or status bar fails realism the same way dropping a mobile tab bar does.
- **Open menus render `app_shell.menus`, one row per item.** A step showing a menu adds `class="win32-menu-open"` to exactly one `[role=menuitem]` and nests `<ul role="menu"><li role="menuitem">Label<span class="win32-menu-shortcut">Ctrl+…</span></li></ul>` with **each entry of `app_shell.menus["<that menu>"]`, in order, one row each** — accelerators from each entry's `accel` in `.win32-menu-shortcut` (never hand-floated), `.has-divider` where `divider_before` says so. A `submenu` entry is a **single row with class `win32-menu-sub`** (the frame draws the cascade arrow) — **never inline a submenu's children into the parent list**; a menu taller than the window is a structure failure. At most ONE submenu may additionally be shown open (nested `<ul role="menu">` inside its row) when the topic's action lives inside it. 7.css hides menus until hover — `.win32-menu-open` is the static-render escape hatch; never force them visible any other way.
- **Dialogs float, nothing dims — author widgets, not lists.** A dialog step shows the main window with the dialog floated over it: `<div class="desktop-window desktop-window--win win32-dialog" style="top: …; left: …; width: …;">` as a child of the main `.desktop-window`, with its own `.desktop-titlebar` (title + close button only) and a `.win32-dialog-body` of **real form widgets**: each `controls[]` entry renders as its element type — `checkbox`/`radio` → an `<input>` with its `<label>` (sibling `<input><label>` is the 7.css-drawn form; a wrapping `<label><input>…</label>` also paints via the frame fallback), `combobox` → `<select>`, `edit` → `<input type="text">`, `groupbox` → `fieldset`+`legend`, `button` → `<button>` (a `defpushbutton` highlighted as the default) — laid out in `.win32-field-row` rows, labels `&`-stripped. **`controls[]` is the completeness checklist, not the artifact**: every entry appears as its widget, none invented, but you are authoring a dialog, not printing the census. **Multi-panel dialogs** (a container DIALOGEX hosting a category list + panel area): render the container chrome with the topic's category selected, and fill the panel area from the topic panel's **own** `dialog_index` entry (e.g. an `IDD_*_SUB_*`), not the container's. Real Win32 dialogs do NOT dim their parent — no backdrop, ever.
- **Styled client content needs `win32_metadata.stylers_file`.** A step whose client area shows the app's own colouring (syntax highlighting, coloured markers) MUST list `stylers_file` in `partials_expanded` — the lint whitelists colours only from `branding.css` + listed sources, so with it listed you may use the app's real palette via inline `style="color: …"`, and without it the content stays monochrome. When `stylers_file` is null, monochrome is correct.
- **Widgets from provided classes/roles only.** 7.css styles plain `button`/`input`/`select`/`fieldset`/`table` — use bare elements; `[role=tablist]`/`[role=menubar]`/`[role=menu]`/`.tree-view`/`.searchbox`/`.status-bar` for the composites; `win32-*` frame classes for toolbar/editor/dialog scaffolding. **Never define classes in your own `<style>` block.** Inline `style=` for layout only; colours must be from `branding.css` or the step's listed source files — the app's real palette (e.g. syntax-highlight hexes in a theme XML) is usable **only** when that file is listed in `partials_expanded`. Neutrals always safe.
- **Editor content is text, not art.** Fill `.win32-editor-code` with a realistic file of the app's domain (plain lines; one `.win32-editor-line` per row, `.win32-editor-line--active` for the caret line, gutter numbers matching). No box-drawing, no ASCII art, no emoji. Syntax colouring via inline `style="color: …"` only with whitelisted hexes; plain black text is always acceptable.
- **Icons are inline SVG** (`currentColor`), never emoji, never icon-font classes.
