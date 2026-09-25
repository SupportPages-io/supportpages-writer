### Game mockup contract (game projects ONLY — wraps the web rules above)

> Extracted verbatim from `generate-illustrated-article/SKILL.md` (Phase 3) on 2026-09-07 so the skill body stays under cursor-agent's ~100k-character inline cap. SKILL.md's Phase 3 gate for `app_type: "game"` points here; this file **is** the contract — follow it exactly as if it were printed there. Keep it in sync with the lint (`scripts/lint_mockup_fidelity.js`) like any other contract text.

For `app_type: "game"` projects every screenshot is the game's playfield, wrapped in the `.game-*` frame classes already shipped in `branding.css`. The generic contract still holds — verbatim copy from source, realistic populated content, no invented colours, no annotations, chrome-once/clone-and-edit across steps — and the two screen kinds route differently: **`method: "UI"` screens** (DOM overlay menus) follow the web rules above — their markup is real HTML styled by the app's own compiled CSS — while **`method: "CANVAS"` states** have no DOM to copy and are authored as a self-contained SVG scene from the route's `scene_anatomy`. Both kinds live inside the same frame:

- **`view_sources.json` for game steps:** the real `framework` string from branding.json; per step, `url_or_route` = the state key, `primary_view` = the draw-code file (CANVAS) or the screen's markup file (UI) — a real path you opened with `Read` — **omit the `layout` key entirely**, `partials_expanded` always lists the draw-code file + the entry HTML + the stylesheet (**that listing is what whitelists the game's palette** — every colour you author must trace to a literal in a listed file or `branding.css`), `verbatim_evidence` = ≥3 real strings — HUD labels and `scene_anatomy.text_literals` fragments for CANVAS states, on-screen menu/button text for UI screens; never emoji-bearing strings — `default_user_assumptions` as usual. Persist resolved states back to `route_index` (including any `scene_anatomy` you had to derive at article time).
- **Document skeleton, CANVAS-state variant (mandatory):**
  ```
  <!doctype html>
  <html>
  <head><meta charset="utf-8"><!-- INJECT_CSS --></head>
  <body class="game-stage" data-viewport="game">
    <div class="game-screen" style="width: <display_size.width>px; height: <display_size.height>px;">
      <svg class="game-scene" viewBox="0 0 <logical_size.width> <logical_size.height>"
           preserveAspectRatio="xMidYMid meet" shape-rendering="crispEdges">
        <rect width="<logical_size.width>" height="<logical_size.height>" fill="<background.clear_color>"/>
        <defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><!-- background.gradient stops, verbatim --></linearGradient></defs>
        <g data-layer="<layers[0].name>"><!-- entities --></g>
        <g data-layer="<layers[1].name>"><!-- one <g> per scene_anatomy layer, IN ORDER --></g>
      </svg>
      <!-- hud_kind "dom": the app's REAL HUD markup (real ids/classes — its CSS is in branding.css) -->
      <!-- hud_kind "canvas": <div class="game-hud" style="top: 16px; left: 16px;"><div class="game-hud-item">…</div></div> -->
    </div>
  </body>
  ```
  `data-viewport="game"` always; `.game-screen` sized inline to `game_metadata.display_size`, verbatim, identical on every step. The SVG `viewBox` is `game_metadata.logical_size`, so **all scene coordinates stay in logical game units copied straight from the draw code** — the viewBox does the scaling; never a CSS `transform: scale`.
- **UI-screen variant:** same `<body class="game-stage">` + `.game-screen` shell; inside it the screen's real overlay markup from the entry HTML (real ids/classes — the compiled CSS paints it), positioned as the app's own CSS positions it. A menu the real game shows over the playfield uses `.game-overlay-menu` over a simplified scene (or the app's real backdrop element), with an inline neutral rgba dim if the real overlay has one.
- **Scene rules (CANVAS states).** `scene_anatomy` is the **completeness checklist, not the artifact** — author a living scene where every `layers[]` entry is present as a `<g data-layer>` in draw order (paint order is z-order) and every entity type is represented, at plausible **mid-game** counts per `count_hint`; never transcribe every instance, and never leave the scene in an empty attract-mode state (one lonely enemy and a zeroed score read as a broken screenshot — the article says "playing", so show play). Colours are **copied verbatim from the draw-code literals** (or `background.gradient` stops) — never approximated, never invented. An entity `catalog` names the source spec table — sample its variants. Text drawn on canvas uses the game's real font from branding.json.
- **HUD is mandatory** on every CANVAS step: every `app_shell.hud_fields` entry present, formats from `format`, **non-zero mid-game values**.
- **Glyphs:** geometric shapes (`◆ ● ▲ ►`), box/block elements, and `✓ ✗` are lint-safe; emoji and misc-symbol/dingbat characters (`★ ⚙ ⚡ ✨` and anything U+2600 and above) hard-fail **even when the real game draws them** — substitute a safe glyph or draw the shape in SVG.
- **Everything lives INSIDE `.game-screen`, anchored directly to it** — the screen IS the viewport; scene, HUD, and overlays all anchor within it (`position: relative`, and the frame contains fixed-position descendants, so copied markup using `position: fixed` cannot escape). **Skip the app's full-viewport wrapper containers** (a fixed-position container sized to the logical viewport): when `display_size` is smaller than the logical size, an oversized wrapper overhangs the screen and throws its edge-anchored children — a top-left HUD — outside the visible area. Parent each overlay/HUD element's own real markup straight to `.game-screen`. Never author new `position: fixed` elements yourself — use `absolute` against the screen. Frame classes are used, never defined; never resize `.game-screen` between steps.
- **Pre-render self-check, per step** (fix before writing the next file, not after the lint; Phase 4 re-checks the same items on the rendered PNG, and a self-check you skip here comes back as a polish ticket):
  1. Exactly one `.game-screen`, inline-sized to `display_size`, with every element inside it — no `position: fixed`, nothing outside the screen?
  2. CANVAS step: every `scene_anatomy` layer present as a `<g data-layer>` in draw order, background clear colour + gradient stops verbatim?
  3. HUD present with every recorded field at non-zero mid-game values?
  4. Every colour traceable to a draw-code literal, a gradient stop, `branding.css`, or a neutral?
  5. Only lint-safe glyphs?
