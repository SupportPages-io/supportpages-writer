### Mobile mockup contract (mobile projects ONLY — replaces the web rules above)

> Extracted verbatim from `generate-illustrated-article/SKILL.md` (Phase 3) on 2026-09-07 so the skill body stays under cursor-agent's ~100k-character inline cap. SKILL.md's Phase 3 gate for `app_type: "mobile"` points here; this file **is** the contract — follow it exactly as if it were printed there. Keep it in sync with the lint (`scripts/lint_mockup_fidelity.js`) like any other contract text.

For `app_type: "mobile"` projects every screenshot is a phone rendered inside the vendored device frame, authored with the Framework7 + `device-*` classes already shipped in `branding.css`. The generic contract still holds — verbatim copy from source, realistic populated content, no invented colours, no annotations, chrome-once/clone-and-edit across steps — but the web rules about layouts and desktop shells do not apply. Instead:

- **`view_sources.json` for mobile steps:** `framework: "mobile"`; per step, `url_or_route` = the screen's route (from `screen_index`), `primary_view` = the screen's `definition_file` (a real path you opened with `Read`), **omit the `layout` key entirely**, `partials_expanded` = the shell definition file (`app_shell.definition_file`), the child components/widgets the screen composes, **`mobile_metadata.theme_module` (mandatory when non-null — open it: it tells you which surfaces the app tints, and mockups authored without it come out grey)**, and any localisation files the screen's strings live in (Flutter `.arb`, RN i18n JSON — listing them is what puts them in the lint's source corpus). `verbatim_evidence` = ≥3 real strings per step; for a string that lives in a l10n file rather than the widget, use the object form `{"string": "…", "found_in": "lib/l10n/app_en.arb"}` so the lint checks the right file — **never strings containing emoji**. `default_user_assumptions` as usual (signed-in default user; no debug banners or dev menus). Persist resolved screens back to `project_map.screen_index`, not `route_index`.
- **Document skeleton (mandatory):**
  ```
  <!doctype html>
  <html class="<platform_attr from branding.json>">          <!-- "ios" or "md" -->
  <head><meta charset="utf-8"><!-- INJECT_CSS --></head>
  <body class="device-stage" data-viewport="<platform from branding.json>">   <!-- "ios" or "android" -->
    <div class="device device--ios">                         <!-- or device--android -->
      <div class="device-screen">
        <div class="device-statusbar">
          <span class="device-statusbar-time">9:41</span>
          <span class="device-statusbar-icons"><span class="device-signal"></span><span class="device-wifi"></span><span class="device-battery"></span></span>
        </div>
        <div class="device-dynamic-island"></div>            <!-- Android: <div class="device-camera-dot"></div> -->
        <div class="framework7-root"><div class="view"><div class="page">
          <div class="navbar"><div class="navbar-bg"></div><div class="navbar-inner"><div class="title">Screen title</div></div></div>
          <div class="page-content">…this step's screen content…</div>
          <div class="toolbar toolbar-bottom tabbar tabbar-icons"><div class="toolbar-inner">
            <a class="tab-link tab-link-active"><i class="f7-icons">house_fill</i><span class="tabbar-label">Home</span></a>
            …one tab-link per app_shell.nav_items entry…
          </div></div>
        </div></div></div>
        <div class="device-home-indicator"></div>            <!-- Android: <div class="device-gesture-pill"></div> -->
      </div>
    </div>
  </body>
  ```
  The `<html>` platform class is required — without it neither theme's widget styles apply. `data-viewport` must be `ios` or `android` matching `branding.json.platform`; **never `data-viewport="mobile"`** (a legacy 375px responsive-web preset that clips the frame). One platform, one theme (light), one device per article — never mix frames across steps.
- **Shell-first, from `app_shell`.** Statusbar → navbar → content → tab bar, in that order, before any leaf content. **The screen's title appears exactly once** — as the navbar `.title`, or as an in-body heading when `app_shell.app_bar.pattern` says the app renders titles in the body; a screen with no title region at all fails realism. The tab bar renders **every** `app_shell.nav_items` entry with its real label and icon in real order, `tab-link-active` on the current screen's tab. A genuinely standalone screen (login, onboarding, a full-screen modal flow) omits the tab bar but keeps the frame, statusbar, and home indicator. If `app_shell.type` is `"none"`, the app has no tab bar — that's recorded, not your call to re-make per step.
- **Widgets from provided classes only.** Build content from Framework7's classes (they're all in `branding.css`): lists are the real skeleton `.list > ul > li > .item-content > .item-media? + .item-inner > .item-title (+ .item-after)`, with `.item-after` carrying the row's trailing control (chevron `<i class="f7-icons">chevron_right</i>`, a `.toggle`, a `.badge`); buttons are `.button` / `.button-fill`; segmented controls, searchbars, cards, chips, sheets, dialogs likewise. **Primary buttons: match the app's real CTA shape from its source component** — full-width vs compact, corner radius, text case — with inline sizing on the F7 `.button` (Framework7's compact uppercase default is rarely what the app actually ships). On `.page-content`, never override the `padding` **shorthand** (it wipes the computed navbar/safe-area top offset) — set `padding-left`/`-right`/`-bottom` individually. **Never define classes in your own `<style>` block** (the lint hard-fails any class absent from `branding.css`/source). Inline `style=` is allowed for content *layout* (flex, spacing, sizes) — but every **colour** must be `var(--f7-theme-color)` / `var(--brand-…)` / a hex present in `branding.css` or the step's listed source files; neutrals are always safe. **Flutter caveat:** a `Color(0xFF…)` literal in a `.dart` file does NOT whitelist its hex — use the CSS variables, which detect-project seeded from the app's real palette.
- **Icons.** `<i class="f7-icons">name</i>` ligatures from the vendored font — names MUST come from `detect-project/assets/mobileui/f7-icons-names.json` (the lint validates; an invented name renders as raw text) — or inline `<svg>` with `currentColor`. Never emoji (including in the statusbar), never `fa-*`/`material-icons` font classes (they trigger a network fetch the render container blocks).
- **Overlays.** A bottom sheet is `class="sheet-modal modal-in"`, an alert/confirm is `class="dialog modal-in"`, an action sheet is `class="actions-modal modal-in"` — author them as a direct child of `.device-screen`, preceded by their **matching** backdrop (`<div class="sheet-backdrop backdrop-in"></div>` / `dialog-backdrop` / `actions-backdrop` — a mismatched backdrop stacks ABOVE the overlay and dims it). F7 positions all of these `absolute`, so they anchor to the device screen, not the page. **JS-measured widget states must be authored inline**: a `.range-bar-active`'s width, a segmented-strong highlight's position — set the inline `width`/`left` yourself.
- **Sizing.** The screen is a fixed canvas (393×852 iOS / 412×915 Android); after statusbar, navbar, and tab bar roughly 650px remains — author what realistically fits (~7–8 list rows). A screen backed by a long list shows a **clipped viewport**: let the last row run under the tab bar / screen edge (`.device-screen`'s `overflow: hidden` does the cropping) — never stretch or shrink the frame to fit content, never let content overflow the bezel. Do not render the soft keyboard.
- **Realism.** Statusbar reads 9:41 with the standard indicators. Populate every data region with realistic values from the source's fields. Dark theme, tablets, and landscape are out of scope — light phone portrait only.
