### Desktop mockup contract (desktop projects ONLY — supplements the web rules above)

> Extracted verbatim from `generate-illustrated-article/SKILL.md` (Phase 3) on 2026-09-07 so the skill body stays under cursor-agent's ~100k-character inline cap. SKILL.md's Phase 3 gate for `app_type: "desktop"` points here; this file **is** the contract — follow it exactly as if it were printed there. Keep it in sync with the lint (`scripts/lint_mockup_fidelity.js`) like any other contract text.

For `app_type: "desktop"` projects every screenshot is the app inside an OS window frame, authored with the `desktop-*` classes already shipped in `branding.css`. Unlike terminal and mobile this does NOT replace the web rules — the window content is real web UI styled by the app's own compiled CSS, so **everything above applies unchanged** (containing-chain from the renderer's components, chrome-once/clone-and-edit, populated data regions, overlay positioning, filled CTAs, inline-SVG icons, light mode, no invented classes/colours). The frame wraps it:

- **Skeleton** (chrome authored once, then cloned per step):

  ```html
  <!doctype html>
  <html>
  <head><meta charset="utf-8"><!-- INJECT_CSS --></head>
  <body class="desktop-stage theme-light" data-viewport="macos"> <!-- theme-light = the app's LIGHT theme class when its CSS is theme-class-scoped (use the app's real class name); only use a dark class if the app ships no light theme; omit entirely if the CSS isn't theme-scoped -->
    <div class="desktop-window desktop-window--mac">
      <!-- window_chrome fork — see below -->
      <div class="desktop-window-content">
        <!-- MACRO LAYOUT — exactly one of two variants; the choice is DATA-GATED, not stylistic
             (see the "Macro layout is data-gated" rule below):
             (A) DEFAULT — project_map.css_build records a working recipe (the render JIT compiles
                 every utility class you write): author the shell with the app's OWN layout classes,
                 copied from the real shell source. NO desktop-app-*/desktop-pane-* bones anywhere. -->
        <div class="…real app root classes… (e.g. flex h-screen)">
          …app titlebar/toolbar row(s) (hybrid: from chrome_component)…
          <aside class="…real sidebar classes… (e.g. w-64 flex-shrink-0 flex flex-col)">
            <!-- tree/list rows: ALWAYS .desktop-tree-row, one per item, populated -->
            <div class="desktop-tree-row desktop-tree-row--active"><svg …>…</svg> <span>ItemName</span></div>
            <div class="desktop-tree-row">…</div>
          </aside>
          <main class="…real main-pane classes… (e.g. flex-1 min-w-0 overflow-hidden)">
            <!-- control strips (search/filter/actions): ALWAYS .desktop-toolbar -->
            <div class="…real toolbar classes… desktop-toolbar">…controls…</div>
            …page from real renderer templates…
            <!-- tabular data: ALWAYS a semantic table, populated rows -->
            <table class="desktop-table"><thead><tr><th>col</th>…</tr></thead><tbody><tr><td>…</td></tr>…</tbody></table>
            <!-- code/query editors: gutter numbers + mono lines -->
            <div class="desktop-code-editor"><div class="desktop-code-gutter">1<br>2</div><div class="desktop-code-lines">SELECT …</div></div>
          </main>
          <!-- when the real app has a bottom status bar, it's the app root's LAST child -->
          <div class="…real statusbar classes… desktop-statusbar">…status fields…</div>
        </div>
        <!-- (B) DEGRADED PATH ONLY — no css_build recipe, or the shell's pane-sizing CSS genuinely
             cannot work statically (unbuilt component package, JS-measured panel widths): layer the
             bone ASSEMBLY onto the real classes, EXACTLY this nesting — the bones are one assembly,
             never à la carte:
               <div class="…real app root classes… desktop-app-rows">
                 …titlebar/toolbar row(s)…
                 <div class="desktop-app-columns">
                   <aside class="…real sidebar classes… desktop-pane-fixed" style="width: 320px">…</aside>
                   <main class="…real main-pane classes… desktop-pane-fill">…</main>
                 </div>
                 <div class="…real statusbar classes… desktop-statusbar">…</div>
               </div>
             No toolbar rows and no status bar? Then the app root carries desktop-app-columns ITSELF
             (no desktop-app-rows at all). desktop-pane-fixed / desktop-pane-fill are legal ONLY as
             direct children of desktop-app-columns. A sidebar that sits BESIDE its main pane NEVER
             goes directly inside desktop-app-rows — "rows" means stacked rows (a toolbar ABOVE the
             content, flex-direction: column), and putting a sidebar+main pair in it renders the main
             pane at ZERO HEIGHT: the screenshot shows chrome next to a blank pane. -->
        <!-- modals/dialogs: .desktop-modal over .desktop-modal-backdrop, anchored to the window -->
        <div class="desktop-modal-backdrop"></div>
        <div class="desktop-modal" style="width: 560px">…dialog from real templates…</div>
      </div>
    </div>
  </body>
  </html>
  ```
  **Macro layout is data-gated — the app's own classes are the default; the bones are the degraded path.** Frame classes exist to REPLACE missing CSS, never to override working CSS: the bones' `!important` direction/sizing beats the app's real classes wherever the two disagree, so layering them where they aren't needed can only lose fidelity (a one-word mismatch — `desktop-app-rows` around a sidebar+main pair — collapses the main pane to zero height and blanks every screenshot). When `project_map.css_build` records a working recipe, the render JIT compiles every utility class the mockup uses, so the shell's real layout classes (`flex h-screen`, `w-64`, `flex-1`) are guaranteed to render — author variant (A) with NO `desktop-app-*`/`desktop-pane-*` bones. Author variant (B) ONLY when the shell's pane sizing genuinely cannot work statically: no `css_build` recipe, pane classes from an unbuilt component package, or runtime-dependent flex bases (the `flex-basis:100%` sidebar that swallows the window; the JS-measured panel) — then the bones pin the proportions deterministically while the app's own CSS paints everything inside each pane, layered onto the real classes (`class="sidebar connection-sidebar desktop-pane-fixed"`). Take the sidebar width from the source when it's stated; otherwise use a realistic desktop proportion (~260–360px).
  `data-viewport` must be `macos` or `windows` matching `branding.json.platform` (with the matching `.desktop-window--mac`/`--win` variant) — **never `data-viewport="desktop"`** (a legacy 800×600 responsive-web preset that clips the frame). One platform, one window size, one theme per article.
- **The `window_chrome` fork** (from `project_map.desktop_metadata`; per-window values win over the top-level default). Exactly one of:
  - `"native"` → `<div class="desktop-titlebar">` as the window's first child: `.desktop-traffic-lights` (three empty `<span>`s) + `.desktop-window-title` on mac; `.desktop-window-title` + `.desktop-caption-buttons` (`<span class="desktop-caption-min">`/`-max`/`-close`) on windows.
  - `"hybrid"` → NO `.desktop-titlebar`. The app's own header bar, authored from `desktop_metadata.chrome_component` (list it in `partials_expanded`), plus `.desktop-traffic-lights desktop-traffic-lights--overlay` (mac) or `.desktop-caption-buttons desktop-caption-buttons--overlay` (windows) as a direct child of `.desktop-window`.
  - `"custom"` → NO frame chrome at all — the app's chrome component draws everything, including its window controls, per the containing-chain rule.
  Never render both a `.desktop-titlebar` and the app's own titlebar — the double-titlebar is this mode's signature failure. Likewise never mix platforms' controls: mac traffic lights and windows caption buttons are mutually exclusive (match `branding.json.platform`).
- **Frame classes are used, never defined.** Only `desktop-*` classes from `branding.css`; never redefine them in a `<style>` block; never stretch/shrink `.desktop-window` (its fixed 1480×900 is what the render presets and crop are built around).
- **Overlays position against the window, not the viewport.** Inside a framed mockup use `position: absolute` containers anchored to `.desktop-window-content` (it is `position: relative`) for modals/dropdowns/backdrops — `position: fixed` escapes the window and dims the whole stage canvas. Dialogs use the frame's `.desktop-modal` (opaque themed surface, centered, bordered) over `.desktop-modal-backdrop` — never a bare app modal class whose surface CSS may not exist, which renders transparent with the page bleeding through.
- **A step about choosing an option renders its dropdown OPEN.** A native `<select>` cannot render open — author the open state as an absolutely-positioned option list (high z-index, not inside an `overflow:hidden` ancestor) with the described option highlighted; same for menus a step tells the reader to open.
- **Pre-render self-check — verify EVERY mockup before the post-process block** (Phase 4 re-checks the same items on the rendered PNG; a self-check you skip here comes back as a polish ticket):
  1. Every sidebar tree/list is `.desktop-tree-row` per item (bare app list classes render jammed inline), and **`project_map.app_shell` is the completeness checklist**: every shell region it records (icon rail, primary sidebar — including the controls its `content` names, e.g. a search field or connection/database picker — secondary panels, status bar, titlebar) appears in the mockup with the content the map describes, whenever that region is visible on the real screen. Author them as real widgets; never skip a region the map lists.
  2. Tabular data is a `<table class="desktop-table">` with populated `<th>`/`<td>` rows; code/query editors are `.desktop-code-editor` with gutter numbers and **realistic syntax tinting from the app's real editor theme** — the entry stylesheet names it (a `codemirror`/`monaco`/`shiki` theme import: monokai ⇒ pink/magenta keywords, dracula ⇒ purple, etc.); use that palette via inline-styled spans, never a generic blue or a monochrome block.
  3. Control strips use `.desktop-toolbar`; a real bottom status bar is present as `.desktop-statusbar` (last child of the app root).
  4. Exactly one window-control set, matching `branding.json.platform` — never mac traffic lights AND windows caption squares.
  5. Dialogs are `.desktop-modal` over `.desktop-modal-backdrop`, **with the app's real dialog/surface class (or an inline canvas colour) layered on** so the surface matches the app theme — the frame only guarantees a fallback; a white card in a dark app is a defect. Any dropdown/menu the step tells the reader to open is rendered OPEN with the target option visible.
  6. The app root fills the window (no dead strip below), and the `<body>` theme class matches every other step's.
  7. No two illustrated steps depict the **same action-ready state** when one screenshot can carry all of their `data-rtfm-action-target` markers. Keep the state that exposes the controls the reader must use; a result screen never replaces an uncovered start/type/submit target. The illustrated set is the minimum that covers every action, not the minimum PNG count at the expense of a control.
  8. Macro layout matches its data gate: `css_build` recipe live ⇒ **zero** `desktop-app-*`/`desktop-pane-*` bones anywhere in the mockup (the app's own classes lay the shell out); degraded path ⇒ `desktop-pane-fixed`/`desktop-pane-fill` appear ONLY as direct children of a `desktop-app-columns`, and no sidebar sits directly inside a `desktop-app-rows` (that renders the main pane zero-height and invisible — the lint hard-fails it).
  9. The step's subject is INSIDE the visible window: every control/section the step names — and the evidence strings that anchor it — sits above the window's bottom clip edge. If it would sit below the fold, depict the scrolled state (trim the content above it inside the scroll container). The renderer verifies evidence visibility after capture and a clipped subject fails the step.
- **Sizing.** The content area is ~1480×860 (mac) — a real desktop viewport, so render the desktop layout exactly as the web rules describe. Content realistically taller than the window shows a clipped viewport (`.desktop-window`'s `overflow: hidden` crops it) — let it clip; never grow the window. **But the step's SUBJECT must be inside the visible region:** anything below the window's bottom edge does not exist in the screenshot. When the control/section the step is about sits below the fold on a faithful top-of-page copy (a settings section far down a scrollable column), depict the **scrolled state** the real user would see — trim/condense the content ABOVE the target inside the scroll container (it scrolled out of view; that is the faithful state) so the target sits fully inside the window. A step whose own subject is clipped out of frame has failed regardless of how faithful the markup is.
- **The app root fills the window.** Author ONE root element inside `.desktop-window-content` and let it fill (`height: 100%` or flex) — **never hard-code a guessed pixel height on it**: a short root leaves a dead strip of frame background below the app. (The frame stretches a lone root automatically; don't fight it with fixed heights.)
- **Trees, data grids, and code editors use the `desktop-*` data widgets.** These components are usually JS widgets (grid libraries, editor components, design-system packages) whose CSS is runtime-generated or lives in an unbuilt package — it is NOT in `branding.css`, so their real DOM renders as stacked unstyled lines. Author self-contained stand-ins instead: sidebar tree/list rows as `.desktop-tree-row` (+ `--active`), tabular data as a semantic `<table class="desktop-table">` with real `<th>`/`<td>` rows (populated, per the data-region rule), and query/code editors as `.desktop-code-editor` > `.desktop-code-gutter` (line numbers) + `.desktop-code-lines`. Depict the state the step describes — a results step shows populated result rows, never an empty/"no data" placeholder.
- **Theme class on `<body>`.** If the app's compiled CSS scopes its rules under a theme class on body (selectors like `body.theme-… .component`), add exactly one such theme class to the mockup `<body>` alongside `desktop-stage`, and keep it identical across every step. **Prefer the light variant when the app ships one** (matching the light-mode rule in the web rules above); use a dark class only when the app has no light theme. Without a theme class the app's own component rules never match; with different ones across steps the article mixes themes.
