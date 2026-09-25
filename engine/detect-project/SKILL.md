---
name: detect-project
description: One-shot project setup for the mockup tools (generate-illustrated-article, generate-walkthrough). Detects the CSS framework, design tokens, brand colours, and fonts, compiles or synthesises a CSS bundle, maps the project structure (framework, routes/controllers/views locations, layouts, shared chrome), and recommends a provider-agnostic low/medium/high mockup model tier so generated output visually matches the real app without overspending on straightforward projects. Terminal (CLI/TUI) apps get a vendored WebTUI terminal stylesheet and a command index instead; mobile apps (React Native incl. Expo, and Flutter) get a vendored Framework7 device-frame stylesheet re-tinted to the app's brand, and a screen index; desktop apps (Electron, Tauri) keep their real compiled CSS and gain a vendored OS-window frame stylesheet; web/canvas games (vanilla canvas, Phaser, PixiJS) keep their real compiled CSS and gain a vendored playfield frame plus a per-scene draw anatomy extracted from the game's render code. The app type is auto-classified from the repo when no app_type hint is given (an explicit hint always wins; on ambiguous multi-surface repos the model adjudicates the product's primary surface from in-repo evidence, diverting from the classifier only when the evidence is one-sided). Use when the user asks to set up / detect / refresh the project's branding or structure, choose an appropriate model tier for mockup generation, or when mockup output doesn't look like the real app. One run per project — result cached in `./.rtfm/`. (Formerly named detect-branding.)
allowed-tools: Read Glob Grep Bash Write
arguments:
  - name: codebase_path
    description: Path to the codebase to analyse. Defaults to the current working directory.
  - name: app_type
    description: 'Optional hint from the user about what kind of app this is: "web", "terminal" ("cli" and "tui" are accepted synonyms), "mobile" ("ios", "android", "react-native", "rn", "flutter", "expo" are accepted synonyms), "desktop" ("electron" and "tauri" are accepted synonyms), "win32" ("winapi" accepted) for native Windows GUI apps, "macos" ("mac", "appkit", "cocoa", "swiftui" accepted) for native Mac apps, or "game" ("canvas", "phaser", "pixi" accepted) for web-rendered games. An explicit hint always wins. When omitted, STEP 0 auto-classifies the repo from its root manifests; a multi-surface repo prints `note=` lines and the model then adjudicates the product''s primary surface from in-repo evidence (conservative: divert from the classifier only when the evidence is one-sided). Terminal projects get a vendored WebTUI terminal stylesheet instead of CSS detection, and a command index instead of a route index. Mobile projects get a vendored Framework7 device-frame stylesheet re-tinted to the app''s brand, and a screen index. Desktop projects keep their real compiled CSS and gain a vendored OS-window frame stylesheet. Win32 projects get a vendored 7.css widget stylesheet and a dialog index built from their .rc resources. macOS projects get a vendored Puppertino widget stylesheet and a view index built from their .xib/.storyboard files. Game projects (web-rendered only — native engines like Godot/Unity/Unreal are not supported) keep their real compiled CSS and gain a vendored playfield frame stylesheet plus a scene anatomy extracted from the render code.'
  - name: theme
    description: 'Optional, terminal apps only. Terminal colour theme: catppuccin (default) | gruvbox | nord | vitesse | everforest. Dark variants only in v1.'
  - name: platform
    description: 'Optional, mobile and desktop apps only. Mobile device frame: "ios" | "android" | "auto" (default — derived from the repo; an "ios"/"android" app_type synonym also sets it). Desktop window frame: "macos" | "windows" | "auto" (default — macos unless the repo is Windows-only).'
---

You are detecting and compiling the visual identity AND structure of the software project at the path the user invoked this skill for (default: cwd). The output is a unified project-level cache at `./.rtfm/` that the article + walkthrough skills consume to make their mockups look like the actual product and to skip re-discovering the project's layout on every run.

CODEBASE: `$codebase_path` (defaults to `.` if blank)

## STEP 0 — Bootstrap

```bash
echo "rtfm-skills v$(cat ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/VERSION 2>/dev/null || echo '?') — detect-project"
RTFM_WORKSPACE="${RTFM_WORKSPACE:-$(${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/generate-illustrated-article/scripts/resolve_workspace.sh)}"
cd "$RTFM_WORKSPACE" || exit 1
echo "workspace=$RTFM_WORKSPACE"
echo "related_repos:"; bash ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/generate-illustrated-article/scripts/related_repos.sh
CODEBASE="${codebase_path:-.}"
if [ ! -d "$CODEBASE" ]; then
  echo "ERROR: codebase path does not exist: $CODEBASE" >&2
  exit 1
fi

BRAND_DIR="$CODEBASE/.rtfm"
mkdir -p "$BRAND_DIR"

# Migrate a legacy cache from the old per-skill dir, if one exists.
if [ -d "$CODEBASE/.rtfm-branding" ]; then
  for f in branding.json branding.css branding.css.method.txt branding-detect.json card_bg.png card_bg.meta.json; do
    [ -f "$CODEBASE/.rtfm-branding/$f" ] && [ ! -f "$BRAND_DIR/$f" ] && cp "$CODEBASE/.rtfm-branding/$f" "$BRAND_DIR/$f"
  done
  echo "(migrated legacy .rtfm-branding/ contents into .rtfm/ — the old dir can be deleted)"
fi

# .gitignore for the cache dir: ignore the big/derived artefacts; keep the
# small committable ones (branding.json, project_map.json) visible so
# teammates can inherit them.
cat > "$BRAND_DIR/.gitignore" <<EOF
branding.css
branding-detect.json
brand-overrides.css
*.method.txt
images_base64.json
card_bg.png
css_health.json
EOF

# App type: an explicit hint always wins — web, terminal (cli/tui are
# synonyms), or mobile (ios/android/react-native/rn/flutter/expo are synonyms).
# With no hint, a deterministic classifier infers the type from the repo's
# root manifests (unambiguous signals only; multi-surface repos default to web
# and print note= lines). APP_TYPE_SOURCE records how the type was decided:
# hint | auto (classifier made a positive ID) | default (nothing matched).
RAW_APP_TYPE=$(echo "${app_type:-}" | tr '[:upper:]' '[:lower:]')
APP_TYPE=""
APP_TYPE_SOURCE=hint
case "$RAW_APP_TYPE" in
  cli|tui|terminal) APP_TYPE=terminal ;;
  mobile|ios|android|react-native|reactnative|rn|flutter|expo) APP_TYPE=mobile ;;
  desktop|electron|tauri) APP_TYPE=desktop ;;
  win32|winapi) APP_TYPE=win32 ;;
  macos|mac|appkit|cocoa|swiftui) APP_TYPE=macos ;;
  game|canvas|phaser|pixi) APP_TYPE=game ;;
  web) APP_TYPE=web ;;
  "") ;;  # no hint — classify below
  *) APP_TYPE=web; APP_TYPE_SOURCE=default
     echo "WARNING: unrecognised app_type '$RAW_APP_TYPE' — taking the web path. Valid: web | terminal (cli/tui) | mobile (ios/android/react-native/rn/flutter/expo) | desktop (electron/tauri) | win32 (winapi) | macos (mac/appkit/cocoa/swiftui) | game (canvas/phaser/pixi)." >&2 ;;
esac
if [ -z "$APP_TYPE" ]; then
  CLASSIFY=$(bash ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/classify_app_type.sh "$CODEBASE")
  printf '%s\n' "$CLASSIFY"
  APP_TYPE=$(printf '%s\n' "$CLASSIFY" | sed -n 's/^type=//p' | head -1)
  APP_TYPE_SOURCE=$(printf '%s\n' "$CLASSIFY" | sed -n 's/^source=//p' | head -1)
  [ -z "$APP_TYPE" ] && { APP_TYPE=web; APP_TYPE_SOURCE=default; }
fi
TERM_THEME=$(echo "${theme:-catppuccin}" | tr '[:upper:]' '[:lower:]')

# Mobile/desktop platform: explicit arg wins; an ios/android app_type synonym
# is a bias; otherwise "auto" (resolved from the repo in STEP M1 / STEP D1).
PLATFORM=$(echo "${platform:-auto}" | tr '[:upper:]' '[:lower:]')
case "$PLATFORM" in ios|android|macos|windows) ;; *) PLATFORM=auto ;; esac
if [ "$PLATFORM" = auto ] && { [ "$RAW_APP_TYPE" = ios ] || [ "$RAW_APP_TYPE" = android ]; }; then PLATFORM="$RAW_APP_TYPE"; fi

# A mobile repo taking the web path produces garbage mockups. The unhinted
# case is covered by the classifier above; this warns when an EXPLICIT web (or
# unrecognised) hint contradicts the repo (never fail: an RN-Web/Expo-web
# hybrid may legitimately want the web path).
if [ "$APP_TYPE" = web ] && [ -n "$RAW_APP_TYPE" ]; then
  if [ -f "$CODEBASE/pubspec.yaml" ] && grep -q 'sdk:\s*flutter' "$CODEBASE/pubspec.yaml" 2>/dev/null; then
    echo "WARNING: pubspec.yaml with a Flutter SDK dependency found — this looks like a Flutter app taking the WEB path. If this is a mobile app, re-run: /detect-project app_type=mobile" >&2
  elif [ -f "$CODEBASE/package.json" ] && grep -q '"react-native"' "$CODEBASE/package.json" 2>/dev/null && ! grep -q '"react-dom"' "$CODEBASE/package.json" 2>/dev/null; then
    echo "WARNING: react-native dependency found (and no react-dom) — this looks like a React Native app taking the WEB path. Did you mean: /detect-project app_type=mobile ?" >&2
  elif [ -f "$CODEBASE/package.json" ] && grep -Eq '"electron"[[:space:]]*:' "$CODEBASE/package.json" 2>/dev/null; then
    echo "WARNING: electron dependency found — this looks like an Electron app taking the WEB path. Did you mean: /detect-project app_type=desktop ?" >&2
  elif [ -d "$CODEBASE/src-tauri" ]; then
    echo "WARNING: src-tauri/ found — this looks like a Tauri app taking the WEB path. Did you mean: /detect-project app_type=desktop ?" >&2
  fi
fi

echo "CODEBASE=$CODEBASE"
echo "BRAND_DIR=$BRAND_DIR"
echo "APP_TYPE=$APP_TYPE"
echo "APP_TYPE_SOURCE=$APP_TYPE_SOURCE"
echo "PLATFORM=$PLATFORM"
echo "RTFM_ANALYZE=${RTFM_ANALYZE:-}"
```

**Routing.** If `APP_TYPE` printed `web`, run STEPS 1–5 below exactly as written and ignore the Terminal, Mobile, Desktop, Win32, macOS, and Game branches entirely. If it printed `terminal`, **skip STEPS 1–5** and run the Terminal branch (STEPS T1–T4) instead, then rejoin at STEP 6. If it printed `mobile`, **skip STEPS 1–5 and T1–T4** and run the Mobile branch (STEPS M1–M5) instead, then rejoin at STEP 6. If it printed `desktop`, run the Desktop branch (STEP D1, then STEPS 1–4 as written, then D2–D3 — **not** 4.5–5), then rejoin at STEP 6. If it printed `win32`, **skip STEPS 1–5** and run the Win32 branch (STEPS W1–W4) instead, then rejoin at STEP 6. If it printed `macos`, **skip STEPS 1–5** and run the macOS branch (STEPS C1–C4) instead, then rejoin at STEP 6. If it printed `game`, run the Game branch (STEP G1, then STEPS 1–4 as written, then G2–G3 — **not** 4.5–5), then rejoin at STEP 6.

**Ambiguous repos — adjudicate the surface yourself.** `note=` lines mean the classifier has reached the limit of what root manifests can prove (e.g. react-native + react-dom, CLI + web framework, an app in a monorepo subdirectory). When ANY `note=` printed — regardless of `source=` — do a bounded evidence pass (a few quick reads, no builds, ≤2 minutes) and decide which surface is the PRODUCT'S PRIMARY UI before proceeding past STEP 0:

1. **Product identity:** README / docs head — is the product described as a mobile app, CLI, desktop app, web app, or a game? App Store / Play Store badges? "runs in your browser"? For a possible-canvas-game note: a game loop (`requestAnimationFrame` + state machine), score/lives/wave mechanics, and no routes/pages is one-sided evidence for `game`; a canvas used for charts/viz inside a routed app is not.
2. **Are the web-positive deps product UI or scaffolding?** `react-dom`/`react-native-web` can be only an Expo web preview; `vite`/`next` may build a `landing/`-style marketing dir or Storybook, not the product; `express`/`fastify` may serve only JSON/tRPC (a backend, not a web frontend). Check: is `react-dom` imported by product source (not node_modules)? Do the server routes render views/HTML or only APIs?
3. **Are the native/CLI signals product UI?** e.g. `app.json`/`app.config.*` with ios/android config, an `expo-router/entry`-style main, `android/`/`ios/` dirs, screens built from RN primitives; or a real binary entry for CLIs.
4. **Where does the UI source actually live?** Screen/tab/navigator components vs `pages/`/`views/` of HTML templates.

**Decision rule (conservative):** divert from the classifier's printed type ONLY when the evidence is one-sided — every contradicting signal is explainable as non-product scaffolding AND there is affirmative evidence the primary UI is the other surface. If two surfaces both look like real product UIs (a repo that genuinely ships a native app and a first-class web client), keep the classifier's answer. Do NOT adjudicate when no notes printed — unambiguous repos stay deterministic.

Record the adjudication: pass `llm` as the `app_type_source` argument to the structure-skeleton call (instead of the classifier's `auto`/`default`), and state the deciding evidence in one line of the final summary alongside the verbatim `note=` lines. In an **interactive** session where the classifier fell through to web-by-default with notes, still ask the user — but lead with your recommendation and its evidence. In a **non-interactive** run (`claude -p` — a question just stalls the pipeline), proceed with your adjudicated type.

**If `RTFM_ANALYZE` printed `full`, STEP 6 (codebase analysis) is MANDATORY — the run is incomplete and will be rejected until `summary.md` and `overview.txt` exist.** Note that now so you don't stop after STEP 5 (or T4).

**Related repositories.** If STEP 0 listed anything under `related_repos:`, this product spans several repositories checked out side by side: the working directory is the one whose UI and branding you detect, and each listed `../<dir>` is another repository of the same product (an API, a mobile app, a shared library). STEPS 1–5 are about the working directory only — never `cd` into a sibling or point `codebase_path` at one, and keep every `project_map.json` path relative to the working directory. The siblings matter only in STEP 6. If nothing was listed, ignore this.

## STEP 1 — Static baseline detection

Run the static detector — finds the framework, source CSS files, design tokens, brand colours, fonts. Pure regex; ~100ms.

```bash
node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/detect_static.js "$BRAND_DIR" "$CODEBASE"
# Output: $BRAND_DIR/branding.json with all detected fields
# (renamed to branding-detect.json; STEP 4 merges it back into branding.json)
mv "$BRAND_DIR/branding.json" "$BRAND_DIR/branding-detect.json"
```

## STEP 2 — In-session refinement (YOU do this, not a subprocess)

Read `$BRAND_DIR/branding-detect.json`. Inspect it for the following conditions and do the indicated work. After each resolution, update the JSON file in place. **Do not run `claude -p` or any subprocess for this** — you, Claude, in this session, have all the tools needed (Read, Glob, Grep).

**a. SCSS variable chains.** If any value in `scss_vars` looks like a reference (`$identifier` instead of `#hex`), follow the chain:
- Open the SCSS file(s) listed in `sources`
- Find where the referenced variable is defined
- If THAT is also a reference, recurse
- Replace the chain with the final literal hex value
- Note the resolution in `branding-detect.json.refinements[]`

**b. Tailwind config with imports.** If `tailwind.config.{js,ts,cjs,mjs}` exists and the static detector's `tailwind_extend_raw` is null (regex couldn't parse it) or references imports like `import { colors } from './palette'`:
- Open the config file
- Follow the imports — open the imported palette files
- Inline the resolved theme.extend object as JSON into `branding-detect.json.tailwind_extend`
- Also record any `plugins: [...]` array entries in `tailwind_plugins`

**c. @apply component classes.** Grep CSS sources for `@apply` directives. If found, note the dependent component classes in `apply_components` so STEP 3's source-compile path knows to expect them.

**d. Brand-colour usage validation.** Spot-check that the detected `default_colors` actually appear in the project's templates. Grep templates (`*.erb`, `*.jsx`, `*.tsx`, `*.html`, `*.heex`) for the colour names as classes (`bg-primary`, `text-accent`) or as CSS-var references (`var(--brand-primary)`). If the brand colours never appear in templates, lower the confidence — set `default_colors.confidence: "low"`. Don't remove them.

**e. Tailwind plugins.** If the config has a `plugins` array, list them in `branding-detect.json.tailwind_plugins` so downstream synthesis knows what to expect (typography, forms, line-clamp, daisyui, etc.).

**f. Backend-loaded branding (use the defaults!).** Many apps load brand colours dynamically — from a database column, an ENV var, an admin-configured settings panel, or a multi-tenant theme system. The static detector picks up many such patterns (`*.presence || "#hex"`, `ENV.fetch('FOO', '#hex')`, schema column defaults, top-level constants), but it can miss others. Read `branding-detect.json.branding_sources` for what was already found, then audit:

- `app/helpers/*.rb` — grep for methods named `current_brand_color`, `theme_color`, `current_tenant_color`, `*_or_default`. Trace what default they fall back to when the dynamic value is missing.
- `db/schema.rb` — scan for columns named `primary_color`, `accent_color`, `brand_color`, `theme_color`, `gradient_*`, etc. on any table. The column's `default:` argument is what a fresh tenant sees.
- `app/views/layouts/*.{erb,haml,slim}` — grep for `style="…var(--…)…"` or ERB `<%= … %>` interpolations that read from a model/helper. If the layout writes `<style>:root { --primary: <%= current_brand_color %> }</style>`, the default fallback is what we want for mockups.
- `config/initializers/*.rb`, `config/settings.yml`, `config/credentials*` — grep for branding-flavoured constants with hex literals.

For every backend-loaded brand value you find:
1. Record its **default** (the literal hex used when the DB column is null / ENV is unset / tenant is unconfigured) — this is what the mockup should show, since the mockup is implicitly for the "default tenant" state.
2. Update `branding-detect.json.default_colors` if the static detector missed a value.
3. Append to `branding-detect.json.branding_sources[]` describing where the value comes from: `{ key, hex, source_file, source_kind, snippet, dynamic: true }`.

This makes it explicit which brand values are baked-in vs runtime-configured. The mockups always render the default, since per-tenant runtime values are out of scope and the default represents what most users see.

Write the refined JSON back. Add `refined: true` and `refinements: [...]` listing what was resolved.

## STEP 3 — Compile the project's real CSS

Build the project's CSS using its own tooling — the highest-fidelity path, exactly what the production app serves. **Do not settle for `fallback_synthesis`** (a ~200-class approximation) if the real CSS can be produced: modern classes the mockups later use — arbitrary values (`size-[18px]`), responsive variants (`lg:grid-cols-3`), plugin/component classes — only exist in the real compiled CSS. A missing class silently no-ops, so unsized elements balloon and layouts collapse in the screenshots.

### 3.1 — Deterministic attempt
```bash
bash ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/compile_css.sh \
  "$CODEBASE" "$BRAND_DIR/branding-detect.json" "$BRAND_DIR/branding.css" || true
METHOD=$(cat "$BRAND_DIR/branding.css.method.txt" 2>/dev/null || echo none)
echo "compile method: $METHOD"
```
The script tries a committed build artefact (Rails/Phoenix/Vite/Next output dirs), then a source compile (`npx @tailwindcss/cli` / `npx tailwindcss` / `npx sass` / `npx postcss`), then `fallback_synthesis` (framework CDN + `assets/tailwind-fallback.css` + `theme_overrides.js`). It sanitises the output, prepends font `@import`s, and records the method in `branding.css.method.txt`.

### 3.2 — LLM build discovery (only when `$METHOD` is `fallback_synthesis`)
The deterministic script is Rails/simple-Tailwind shaped; it misses bundler-built, monorepo, Tailwind-v4-standalone, and non-npm (e.g. Phoenix/Mix) setups. When it fell back, **investigate this project's actual CSS build and run it yourself** — every shippable app has one:

1. **Find the build.** Read the build wiring — `package.json` `scripts`, `mix.exs` aliases, `Makefile`, `Procfile`, `bin/*`, CI configs — and the Tailwind setup: the entry CSS (the file with `@import "tailwindcss"` or `@tailwind` directives, often under `assets/`, `app/`, or `src/`), the Tailwind **major version** (v4 = `@import "tailwindcss"`; v3 = `@tailwind base/...`), the config file(s), the plugins (`@tailwindcss/forms`, `daisyui`, …), and the content/template globs.
2. **Prefer a minimal, node-only compile** (portable — no full app toolchain needed). Resolve `tailwindcss` (+ plugins), installing just those if absent (`cd <assets-dir> && npm install --no-save tailwindcss@<ver> @tailwindcss/cli <plugins>`), then run the CLI against the real entry + config with **explicit content globs** — v4's `source(none)` disables auto-detection, so you MUST pass the template globs or it emits almost nothing:
   ```bash
   bash ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/run_css_build.sh \
     "$CODEBASE" "$BRAND_DIR/branding.css" 180 -- \
     npx @tailwindcss/cli -i <entry> -o "$BRAND_DIR/branding.css" --content '<glob-1>' --content '<glob-2>'
   ```
   (v3: `npx tailwindcss -c <config> -i <entry> -o "$BRAND_DIR/branding.css"`.)
3. **Else run the project's own build** when its toolchain is present (`mix assets.build`, `npm run build:css`, …) via the same runner, then copy the built CSS to `$BRAND_DIR/branding.css`.
4. **Hand-assembling from committed stylesheets** (concatenating the project's own CSS files, method `prebuilt`) is legitimate for projects that ship plain CSS — but assemble from the pages' real *load* wiring, not from one bundle's import list. Many apps load stylesheets per page or per surface (separately-enqueued/linked files that no main bundle imports), and theme variables (`:root { --… }`) are often emitted by a build step or live in a separate tokens/scheme file — include the stylesheet every `route_index` surface actually loads AND whatever defines the custom properties the rules consume. STEP 4.7's health gate verifies both deterministically.
5. On success: `node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/sanitize_css.js "$BRAND_DIR/branding.css"` and record the real method — `printf tailwind_v4 > "$BRAND_DIR/branding.css.method.txt"` (or `tailwind_v3`/`prebuilt`). If it genuinely can't compile, leave `fallback_synthesis` — the guaranteed floor.

**Capture the recipe** for whatever worked (including the deterministic path). STEP 4.5 caches it in `project_map.json` as `css_build` so later runs and the render-time JIT can reuse it — record: `framework`, `tw_version`, `entry`, `config`, `plugins`, `content_globs`, `pkg_manager`, `compile_cmd` (with `{entry}`/`{out}`/`{globs}` placeholders), `method`.

## STEP 4 — Finalise `branding.json`

Build the canonical artefact the other skills will consume. Merge `branding-detect.json` with the compilation result:

```bash
METHOD=$(cat "$BRAND_DIR/branding.css.method.txt" 2>/dev/null || echo "manual")
CSS_BYTES=$(wc -c < "$BRAND_DIR/branding.css" 2>/dev/null || echo 0)

# Build branding.json from branding-detect.json + compilation metadata
node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/write_branding.js web "$BRAND_DIR" "$METHOD" "$CSS_BYTES"
```

## STEP 4.5 — Project structure map

Emit the structural skeleton that the article/walkthrough skills would otherwise re-derive on every run — the framework, where routes/controllers/views live, the layouts (one per area), and the shared chrome partials. This is the single biggest source of repeated work in those skills (a flurry of routes-grep + `ls`/`find` + chrome reads, identical across runs). Deterministic, no LLM needed here; the generators lazily fill `default_user_assumptions` and `route_index` on first use.

```bash
FRAMEWORK=$(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js "$BRAND_DIR/branding.json" framework unknown 2>/dev/null || echo unknown)
node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/detect_structure.js \
  "$BRAND_DIR/project_map.json" "$CODEBASE" "$FRAMEWORK" web "$APP_TYPE_SOURCE"
```

`project_map.json` has manual-only staleness, same as branding: re-run this skill when the project's routing/controllers/views/layouts move. The `git_sha` it stamps is informational, not enforced.

## STEP 4.6 — Mandatory structure enrichment

Before STEP 5, enrich `$BRAND_DIR/project_map.json` yourself. This is not optional in headless runs: the generator skills use this cache to avoid rediscovering routes, layouts, chrome, and feature areas. Do not leave `route_index` empty for projects with a route file.

Read `$BRAND_DIR/project_map.json`, then inspect the route/layout files it points to:

- Rails: read `config/routes.rb`; if `bin/rails routes` is cheap and works, you may use it, but do not depend on it. Manually extract the user-facing routes from `config/routes.rb` when the command is unavailable.
- Next/Phoenix/Django/Laravel: read the framework's router files/directories from `dir_map.routes`.
- Read `app/views/layouts/*` (or framework equivalent) enough to identify the purpose of each layout and shared chrome partials.

Update `project_map.json` in place with the fields below. Edit it directly, or write your additions to a patch file and run `node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/merge_json.js "$BRAND_DIR/project_map.json" <patch.json>` (objects merge key by key; arrays and scalars replace, and keys you omit are kept):

1. `dir_map` with the useful downstream directories, not just the minimum detector output. Include keys when they exist: `routes`, `controllers`, `views`, `layouts`, `components`, `modals`, `partials`, `stimulus_controllers`, `reflexes`, `models`.
2. `layouts[]` with stable objects shaped like `{ "name": "...", "path": "...", "area": "...", "chrome": [...] }` where possible. Use `area` to explain which product surface uses the layout, for example `auth / login / signup`, `account settings`, `live call UI`, or `platform admin`. **`chrome` = every file the layout unconditionally renders AROUND the page content** for a default authenticated user — the top toolbar/admin bar, nav/menu header, per-screen utility affordances (option/help tabs, breadcrumbs), and the footer. Record entries as **repo-relative file paths** (the generator skills treat this list as the layout's chrome checklist, and the fidelity lint requires shell-rendering mockups to expand every path entry); fall back to a component/partial name only when a chrome region has no dedicated file. **`chrome` and `area` describe what is VISIBLE in the layout's default state, not what markup is emitted** — per-layout accuracy matters: a full-screen editor layout that hides the app shell records `chrome: []` and says so in `area`, even when the shell markup technically renders hidden. Two optional per-layout fields when a layout diverges from the app default:
   - **`root_classes`** (same shape and resolution rules as `app_shell.root_classes`, item 4): the root/body tokens a page using THIS layout carries for the default user, when they differ from the app-shell defaults. Chase runtime/server conditionals to their source the same way — e.g. a "default to fullscreen" filter in the mount file is a **resolved default** and its class belongs here (and the offset class of a top bar that mode hides does NOT). The mockup contracts copy a claimed layout's `root_classes` in place of the app-shell defaults, and the fidelity lint enforces them.
   - **`runtime_chrome`** — when the surface mounts a **client-side runtime app** (block/rich-text editor, builder, embedded SPA region) whose visible chrome exists in no server template: resolve that chrome ONCE here so generation is a transcription job, not a per-article reconstruction. Inventory runtime mounts from EVERY route/controller and layout entry before writing recipes. A different mount/initializer entry file is a different surface even when it belongs to the same editor/product family; never map two mount files to one recipe merely because both are called “editor”. Record regions in **visual order**, each with its real controls and literal on-screen strings:
```json
"runtime_chrome": {
  "app": "<the runtime app/widget>",
  "mode_note": "<what the default mode shows/hides — one sentence>",
  "source_kind": "repo",
  "source_files": ["<repo-relative runtime entry/l10n/style file>"],
  "regions": [
    { "id": "navigation", "region": "navigation sidebar", "placement": "left", "required": false, "appearance": "dark, about one quarter of the viewport; compact unboxed icon rows", "items": [{"id":"identity","kind":"identity","description":"app/site identity","required_strings":[]},{"id":"destinations","kind":"navigation-list","description":"complete ordered destinations","required_strings":["Styles","Templates","Patterns"]}], "ui_strings": ["Styles", "Templates", "Patterns"], "required_strings": ["Styles"], "source_files": ["<repo-relative file>"] },
    { "id": "toolbar", "region": "editing toolbar", "placement": "top", "required": false, "appearance": "light compact toolbar, full width; borderless icon controls except the emphasized primary action", "items": [{"id":"back-identity","kind":"identity","description":"back/identity control","required_strings":[]},{"id":"editing-tools","kind":"control-group","description":"complete ordered editing tool group","required_strings":[]},{"id":"document-title","kind":"document-context","description":"concrete open document/template title, never the generic feature name","required_strings":["<real document title>"]},{"id":"view-options","kind":"control-group","description":"view, settings, and options controls","required_strings":[]},{"id":"primary-action","kind":"primary-action","description":"primary save action","required_strings":["Save"]}], "ui_strings": ["Save"], "required_strings": ["Save"], "source_files": ["<repo-relative file>"] },
    { "id": "canvas", "region": "content canvas", "placement": "canvas", "required": true, "appearance": "largest light region, populated with the real document/template anatomy; no skeleton blocks", "content_mode":"populated", "media_expectation":"required", "representative_assets":["<repo-relative image visible in representative content>"], "max_selected_outlines":1, "items": [{"id":"header","kind":"content-section","description":"real header structure from the underlying view","required_strings":[]},{"id":"main-content","kind":"content-section","description":"real populated content/list/query structure","required_strings":["<real content heading>"]},{"id":"footer","kind":"content-section","description":"real footer structure","required_strings":[]}], "ui_strings": ["<real content heading>"], "required_strings": ["<real content heading>"], "source_files": ["<repo-relative underlying document/template and recursively included files>"] },
    { "id": "styles-inspector", "region": "styles inspector", "placement": "right", "required": false, "appearance": "light right sidebar separated from the canvas by a border", "items": [{"id":"heading-tools","kind":"panel-heading","description":"panel heading and panel tools","required_strings":["Styles"]},{"id":"browse-styles","kind":"action-card","description":"style-variation browser card","required_strings":["Browse styles"]},{"id":"typography","kind":"panel-row","description":"typography settings row","required_strings":["Typography"]},{"id":"colors","kind":"panel-row","description":"colors settings row","required_strings":["Colors"]},{"id":"background","kind":"panel-row","description":"background settings row","required_strings":["Background"]},{"id":"shadows","kind":"panel-row","description":"shadows settings row","required_strings":["Shadows"]},{"id":"layout","kind":"panel-row","description":"layout settings row","required_strings":["Layout"]}], "ui_strings": ["Browse styles", "Typography", "Colors", "Background", "Shadows", "Layout"], "required_strings": ["Browse styles", "Colors"], "source_files": ["<repo-relative file>"] },
    { "id": "document-inspector", "region": "document inspector", "placement": "right", "required": false, "appearance": "light right sidebar separated from the canvas by a border", "items": [{"id":"tabs","kind":"tabs","description":"document/block tabs","required_strings":["Document","Block"]},{"id":"document-settings","kind":"settings-list","description":"complete ordered document settings","required_strings":[]}], "ui_strings": ["Document", "Block"], "required_strings": ["Document"], "source_files": ["<repo-relative file>"] },
    { "id": "confirm", "region": "save confirmation", "placement": "overlay-right", "required": false, "appearance": "light right-side panel over the still-visible editing canvas; flat rows rather than cards unless source says otherwise", "items": [{"id":"heading-close","kind":"panel-heading","description":"heading and close affordance","required_strings":["Are you ready to save?"]},{"id":"explanation","kind":"supporting-copy","description":"explanatory copy","required_strings":[]},{"id":"group-one","kind":"group-heading","description":"first changed-entity group heading","required_strings":["<real group heading>"]},{"id":"change-one","kind":"selection-row","description":"concrete changed entity with checkbox","required_strings":["<real changed entity>"]},{"id":"group-two","kind":"group-heading","description":"second changed-entity group heading","required_strings":["<real group heading>"]},{"id":"change-two","kind":"selection-row","description":"concrete changed entity with checkbox","required_strings":["<real changed entity>"]},{"id":"footer-actions","kind":"actions","description":"anchored secondary and primary actions","required_strings":["Cancel","Save"]}], "ui_strings": ["Are you ready to save?", "Cancel", "Save"], "required_strings": ["Are you ready to save?", "Cancel", "Save"], "source_files": ["<repo-relative file>"] }
  ],
  "states": [
    { "id": "overview", "name": "overview", "kind": "overview", "topic_tags":["open","find","navigate","overview"], "instructional_priority":"orientation", "canvas_presentation":"large docked scaled preview filling the workspace beside navigation", "screenshot_required": false, "entered_by": "open the surface", "shows": "navigation beside a populated live preview", "visible_regions": ["navigation", "canvas"], "required_regions": [], "required_strings": ["<real content heading>"], "source_files": ["<repo-relative underlying document/template file>"] },
    { "id": "styles-editing", "name": "editing visual styles", "kind": "action", "topic_tags":["design","styles","colors","typography"], "instructional_priority":"primary-action", "context_label":"<real open document/template title>", "canvas_presentation":"full editing canvas showing the populated underlying document", "screenshot_required": false, "entered_by": "open the visual styles controls", "shows": "the destination editor after the action: toolbar and style controls beside the populated preview", "visible_regions": ["toolbar", "canvas", "styles-inspector"], "required_regions": ["toolbar","styles-inspector"], "required_strings": ["Save", "<real open document/template title>", "Browse styles", "Colors", "<real content heading>"], "source_files": ["<repo-relative files>"] },
    { "id": "document-editing", "name": "editing a document/template", "kind": "action", "topic_tags":["template","document","layout","structure"], "instructional_priority":"secondary-action", "context_label":"<real open document/template title>", "canvas_presentation":"full editing canvas showing the populated underlying document", "screenshot_required": false, "entered_by": "open a document/template", "shows": "the real document open in the full editing canvas with toolbar and its state-specific inspector", "visible_regions": ["toolbar", "canvas", "document-inspector"], "required_regions": ["toolbar", "document-inspector"], "required_strings": ["Save", "<real open document/template title>", "<real content heading>"], "source_files": ["<repo-relative files>"] },
    { "id": "confirm-save", "name": "confirm save", "kind": "confirm", "topic_tags":["save","confirm","apply changes"], "instructional_priority":"terminal-action", "context_label":"<real open document/template title>", "canvas_presentation":"the preceding populated editing canvas remains undimmed and visible beneath the side panel", "screenshot_required": true, "entered_by": "press Save", "shows": "the populated confirmation panel over the edited document; list only concrete changed entities, never unchanged/no-change rows", "visible_regions": ["toolbar", "canvas", "confirm"], "required_regions": ["confirm"], "required_strings": ["<real open document/template title>", "Are you ready to save?", "Cancel", "Save"], "source_files": ["<repo-relative files>"] }
  ]
}
```
   `id` values are stable kebab-case identifiers. `placement` is one of `top`, `left`, `right`, `bottom`, `canvas`, `overlay-left`, `overlay-right`, `overlay-center`, or `overlay-bottom`. `appearance` records light/dark treatment, proportion, density, borders, and control treatment—the minimum needed to distinguish the real chrome from the right controls in a generic shell. `items` are ordered atomic objects (`id`, `kind`, `description`, `required_strings`), one visible widget or coherent control group each; every individually navigable panel row, group heading, selectable change row, and footer action group is its own item. Never compress an entire inspector or grouped review panel into one “complete sections/groups” item. The generator must mark each with `data-rtfm-item="<region-id>:<item-id>"`, which lint checks exactly once in order, and render each item's literal `required_strings`. Visually different panels at the same placement get distinct region IDs (for example `styles-inspector` and `document-inspector`); never overload one generic inspector whose contents change by state. `required: true` means the region is visible in EVERY recorded state; otherwise false. Every state carries `visible_regions`, the exact ordered screen skeleton for that state; regions absent from this list are hidden and must not be cloned forward. `required_regions` is the load-bearing subset of that skeleton. An action/confirm state with a toolbar records the concrete `context_label` shown in its document bar and includes it in `required_strings`; never use a generic feature name. Every canvas-visible state records `canvas_presentation`, including whether the preview is docked/scaled/full editing and whether an overlay dims it. `source_files` are repo-relative paths that you opened; every path must exist, and the top-level list always includes the surface's repo-backed mount/initializer entry when one exists. Canvas/source regions cite the underlying view plus its recursively expanded includes/patterns. A populated canvas records `content_mode`, a realistic `max_selected_outlines`, and `media_expectation`; when representative content normally contains media and suitable repo images exist, set `media_expectation: "required"` and list 1–3 existing `representative_assets`. For a famous embedded widget whose visual assets genuinely are not vendored, set `source_kind: "knowledge"`, retain the repo mount file in `source_files`, leave only genuinely unavailable chrome sources empty, and add a prose `source` note explaining the visual provenance. `required_strings` is the small load-bearing subset that must visibly appear; overlays include their heading, secondary action, and primary action—not just “Save”. `ui_strings` may be broader.

   Record the 3–5 states a user actually works through (root/overview, EACH major in-action family, and save/confirm). A navigation+canvas editor with several destinations and a confirmation flow has at least two distinct action states—for example visual-style editing and document/template editing—before confirm, but those are topic alternatives, not universally mandatory screenshots. `kind` is exactly `overview`, `action`, or `confirm`; each state has non-empty `topic_tags` and `instructional_priority` (`orientation`, `primary-action`, `secondary-action`, or `terminal-action`). `screenshot_required: true` is reserved for a state that is load-bearing across essentially every article using the flow (usually an act-on confirmation), not every recorded action branch; overview is always false. An action state describes the screen AFTER `entered_by` completes—if choosing a destination replaces navigation with an editing toolbar, record the destination toolbar, never a hybrid of the doorway and destination. Every `visible_regions`/`required_regions` ID must exist in `regions`; every named panel in `shows` has a corresponding visible region; and state/region sources stay within the runtime recipe. These fields are the machine-checkable contract used by the generator and fidelity lint; `shows` remains the human-readable description.
3. `global_chrome[]` with shared/header/nav partials and important inline chrome. Include the primary app navbar if it is defined inside a layout rather than a partial.
4. `app_shell` — the **concrete, renderable persistent shell** that wraps authenticated pages (a left sidebar / primary nav, top bar, user/account menu). Do NOT merely name the component: **resolve it to real content** so a mockup can reproduce the shell without re-deriving a deeply-composed component tree. When a thin layout delegates (e.g. `layout` renders `<Shell>` → `<SideBar>`/`<Navigation>` built from a nav-item config), follow the chain to the nav-item source and record the real items in order:
```json
"app_shell": {
  "type": "left-sidebar",
  "layout": "<the layout name that renders it>",
  "nav_items": [ { "label": "Event types", "href": "/event-types", "icon": "link" }, { "label": "Bookings", "href": "/bookings", "icon": "calendar" } ],
  "account_area": "user avatar + name, top-left of sidebar",
  "top_bar": { "selector": "<its root id/class>", "items_left": [ "logo menu", "site name", "notification badge" ], "items_right": [ "user menu + avatar" ] },
  "footer_items": [ { "label": "Settings", "href": "/settings", "icon": "cog" } ],
  "root_classes": { "html": [], "body": [] }
}
```
Use the real labels/hrefs/icons in their real order, and record each shell region at **item level** — a top bar is not "a top bar", it is its ordered items (logo/menu, badges, counters, bubbles, the account menu), because the mockup contracts render every item the map records and can't render one it doesn't. Omit `top_bar` only when the shell genuinely has none. **`root_classes`** = the class tokens the document's `<html>` and `<body>` elements carry on a standard authenticated app page for the DEFAULT user, with server-side conditionals **resolved** — root classes are often computed rather than literal (a layout may emit `<html class="<?php echo $computed; ?>">` via a helper in another file), so chase the emission to its source and record the resolved tokens. They are load-bearing: fixed-chrome offset rules (`html.<class> { padding-top: … }` keeping a fixed top toolbar off the content) and theme/dark-mode scoping hang on them, and the fidelity lint enforces the `html` tokens on every shell-rendering mockup. Use empty arrays when the app stamps nothing on the root. This is the single biggest thing that makes dashboard/list/settings mockups look right — capturing it once here saves every article from re-deriving it. Set `app_shell` to `null` only if the project genuinely has no persistent shell (every page standalone). This is worth a few extra reads at detect time; do them.
5. `route_index` with the main user-facing routes. Prefer a keyed object:

```json
{
  "contacts": {
    "method": "GET",
    "path": "/accounts/:account_id/contacts",
    "controller": "contacts#index",
    "layout": "application",
    "primary_view": "app/views/contacts/index.html.erb"
  }
}
```

`primary_view` is the file that renders the route's screen (the template, page component, or route component — repo-relative, a path you opened with Read), and it is mandatory on every entry: the chain resolver below keys on it, and the article skill treats it as the screen's source. Never guess it — a route whose view you could not locate is better recorded without it than with a wrong path.

Route-selection rules:
- Include enough routes to cover the main end-user product surfaces, not every internal route. Aim for 10-30 entries on a medium Rails app.
- Include login/signup/root, dashboard/landing, primary resources, reports, settings/team/API-key pages, live/session pages, and admin only when a visible admin area exists.
- Exclude purely internal webhooks, background job dashboards, health checks, asset endpoints, and developer-only routes.
- For Rails controller/layout mapping, infer layout from controller conventions and layout files when explicit layout declarations are not obvious. It is better to include a useful route with no `layout` than to omit it.

6. `css_build` — the **CSS build recipe** you established in STEP 3, so later runs skip rediscovery and the render-time JIT can regenerate the exact classes a mockup uses. Record the reproducible command with placeholders:
```json
"css_build": {
  "framework": "phoenix", "tw_version": 4,
  "entry": "assets/css/app.css", "config": null,
  "plugins": ["@tailwindcss/forms"],
  "content_globs": ["lib/**/*.heex", "lib/**/*.ex"],
  "pkg_manager": "npm",
  "compile_cmd": "npx @tailwindcss/cli -i {entry} -o {out} --content {globs}",
  "method": "tailwind_v4"
}
```
Set `css_build` to `null` only for non-Tailwind projects or when even the fallback couldn't identify a build. `{entry}`/`{out}`/`{globs}` are substituted at reuse time (`{out}` = the target CSS path, `{globs}` = the `--content` args joined). For a v3 project the command is the `npx tailwindcss -c {config} -i {entry} -o {out}` form.

7. `runtime_surface_coverage` — normally `{ "ignored": [] }`. The deterministic coverage gate below scans route/layout source files for high-confidence client-app initializers. Every detected mount must own its own `runtime_chrome` layout. Only a false-positive/progressive-enhancement initializer may be ignored, as `{ "source_file": "<repo-relative path>", "reason": "<specific evidence that this is not a distinct rendered app>" }`; never ignore a full editor, builder, SPA, or stateful widget.

Validation:

```bash
# Apply a reusable framework/runtime profile when the checkout contains a
# recognised unvendored client app. The profile supplies stable chrome anatomy;
# repo files still determine the concrete theme, document, content, and assets.
# Unknown runtimes are left untouched.
node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/apply_runtime_profiles.js \
  "$BRAND_DIR/project_map.json" "$CODEBASE" --json "$BRAND_DIR/runtime_profiles.json"

node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/check_project_map.js web "$BRAND_DIR/project_map.json" "$CODEBASE"
node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/check_runtime_coverage.js \
  "$BRAND_DIR/project_map.json" "$CODEBASE" --json "$BRAND_DIR/runtime_coverage.json"
node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/check_runtime_recipe_quality.js \
  "$BRAND_DIR/project_map.json" "$CODEBASE" --json "$BRAND_DIR/runtime_recipe_quality.json"
```

(`app_type`/`app_type_source` are stamped by the STEP 4.5 skeleton call — preserve them when you merge your enrichment in.)

If validation fails, fix `project_map.json` and re-run the complete validation block before continuing. For runtime coverage failures, add a distinct layout/recipe for the named mount file and point its route to that layout; do not silence it by attaching the file to an adjacent app's recipe. For runtime recipe-quality failures, replace generic feature labels with concrete source-backed context, expand runtime route partials to regular files, resolve populated-canvas anatomy/assets, and make fullscreen root classes, toolbar inventory, action states, and confirmation entities internally consistent. Passing the JSON shape while the semantic quality gate fails is still an incomplete detection. A Rails project with `config/routes.rb` and an empty `route_index` is an incomplete `/detect-project` run.

### Render chains (deterministic — run after validation passes)

The screen behind a route is rarely one file: on component-tree apps it is 30–50 components deep across packages, and an article run that has to rediscover that tree by grep spends its first ten minutes doing so. The chain is static per commit, so it belongs in the cache. Resolve it once, deterministically:

```bash
node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/resolve_route_chains.js \
  "$BRAND_DIR/project_map.json" "$CODEBASE" --json "$BRAND_DIR/route_chains.json"
```

For every route with a readable `primary_view` and every layout with a readable `path` it walks the include tree (ERB partials/ViewComponents, JSX/Vue/Svelte imports through tsconfig/vite aliases and workspace packages, Blade/Livewire, Django/Jinja/Twig, Razor, Angular selectors, PHP requires) and writes `render_chain: [{file, via, depth, kind}]` — `kind` ∈ `unconditional` (part of every screenshot of the view) | `overlay` (modal/drawer/menu; shown only by a step that opens it) | `conditional` (behind a guard; resolved per `default_user_assumptions`) — plus `render_chain_stats {files, unresolved, max_depth, truncated}`. An empty `partials_expanded` is filled with the unconditional files; a Rails route with no `primary_view` gets the `controller#action` convention view when it exists (`primary_view_source: "convention"`). It never fails the run. Read its summary line and repair the MAP, not the chains: a component-tree app whose main routes resolve to 0 chain files with many `unresolved` means the `primary_view` paths are wrong (or point at a router file rather than the screen) — fix them and re-run the line. Do not hand-author `render_chain`.

## STEP 4.7 — CSS health gate (deterministic — do not skip)

`branding.css` being large, valid, and assembled from the project's REAL stylesheets does not prove it styles the app: a per-page/per-surface stylesheet can be missing (unstyled surface), and rules can consume `var(--x)` custom properties that nothing defines (each such declaration is invalid at computed-value time — a themed button background silently vanishes while its `color: #fff` survives, rendering white-on-white). Verify both before the cache is trusted:

```bash
METHOD=$(cat "$BRAND_DIR/branding.css.method.txt" 2>/dev/null || echo none)
SOFT=""; [ "$METHOD" = "fallback_synthesis" ] && SOFT="--soft"
node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/check_css_health.js \
  "$BRAND_DIR/branding.css" \
  --project-map "$BRAND_DIR/project_map.json" --project-dir "$CODEBASE" \
  --json "$BRAND_DIR/css_health.json" $SOFT
```

The script samples class/id tokens from the structure map's real views (`route_index` primary views, layouts, `app_shell`) and checks they resolve to selectors in `branding.css`, checks every no-fallback `var(--x)` is defined, and checks **root offset classes**: an `html.<class>`/`body.<class>` rule setting a non-trivial `padding-top` is the CSS fingerprint of a fixed top toolbar's offset — if `app_shell` exists but `app_shell.root_classes` omits every such class, the gate fails (mockups built from that map render the fixed bar OVER the sidebar/content). It exits non-zero on failure (except on the known-degraded `fallback_synthesis` floor, where it only reports).

**When it fails, repair and re-run this block until it passes — do not proceed with a failing gate:**
- A `[FAIL]`-coverage view means that surface loads stylesheet(s) the bundle misses. Find what the view actually loads — its `<link>`/enqueue/import wiring, not the main bundle's import list — and append those files.
- Undefined vars mean a theme/scheme/tokens stylesheet (often build-emitted) is missing. Append the file that defines them; if they are genuinely runtime-injected, append a `:root { … }` block assigning the real values you detected in STEP 2.
- A root-offset-class failure is a **`project_map.json` repair, not a CSS repair**: chase the root-class emission (the layout, or the helper it calls) per STEP 4.6 and record the resolved default-user tokens in `app_shell.root_classes`.
- After appending CSS, re-run `sanitize_css.js` and this gate.

If a probed view is a false alarm (e.g. a template whose classes are generated at runtime by a JS framework), say so explicitly in your summary — but the gate itself already skips views with too few literal tokens, so treat failures as real by default.

## STEP 5 — Print a summary the user can sanity-check

```bash
FRAMEWORK=$(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js "$BRAND_DIR/branding.json" framework none)
COMPILE_METHOD=$(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js "$BRAND_DIR/branding.json" compilation_method)
CSS_KB=$(( $(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js "$BRAND_DIR/branding.json" compiled_css_bytes) / 1024 ))
PRIMARY=$(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js "$BRAND_DIR/branding.json" default_colors.primary "(none)")
ACCENT=$(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js "$BRAND_DIR/branding.json" default_colors.accent "(none)")
FONTS=$(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js --length "$BRAND_DIR/branding.json" google_fonts)

LAYOUTS=$(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js --length "$BRAND_DIR/project_map.json" layouts 2>/dev/null || echo 0)
ROUTES=$(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js --length "$BRAND_DIR/project_map.json" route_index 2>/dev/null || echo 0)
APP_SRC=$(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js "$BRAND_DIR/project_map.json" app_type_source default 2>/dev/null || echo default)
node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/recommend_model_tier.js "$BRAND_DIR/project_map.json" "$BRAND_DIR/branding.json"
MODEL_TIER=$(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js "$BRAND_DIR/project_map.json" mockup_model_recommendation.tier)
MODEL_REASONS=$(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js --join ", " "$BRAND_DIR/project_map.json" 'mockup_model_recommendation.reasons[].code')

cat <<EOF

✓ Project cache at $BRAND_DIR/

  App type:    web (source: $APP_SRC)
  Framework:   $FRAMEWORK
  Compilation: $COMPILE_METHOD ($CSS_KB KB)
  Primary:     $PRIMARY
  Accent:      $ACCENT
  Fonts:       $FONTS Google Font link(s)
  Structure:   project_map.json ($LAYOUTS layout(s) mapped)
  Routes:      $ROUTES route(s) indexed
  Model tier:  $MODEL_TIER ($MODEL_REASONS)

Generated content (article / walkthrough mockups) will now use these tokens
and skip per-run structure rediscovery.
Re-run /detect-project if the project's CSS or structure changes.
EOF

if [ "$APP_SRC" != "hint" ]; then
  echo "app_type=web was ${APP_SRC}-classified (no app_type hint given). If this project is actually a CLI/TUI or mobile app, re-run: /detect-project app_type=terminal (or mobile)."
fi

# Deterministic STEP-6 gate — headless callers REJECT the output while
# overview.txt is missing, so this summary must not read as "done" until it exists.
if [ "${RTFM_ANALYZE:-}" = "full" ] && [ ! -s "${RTFM_OUTPUT_DIR:-./output/detect-project}/overview.txt" ]; then
  echo ""
  echo "STOP: RUN INCOMPLETE — RTFM_ANALYZE=full but overview.txt has not been written."
  echo "STEP 6 (codebase analysis) is still REQUIRED. Do STEP 6 now, then finish."
fi
```

If STEP 0's classifier printed `note=` lines, repeat them verbatim after the summary — in a headless run this is the only place they reach the user.

**Do not finish here when `RTFM_ANALYZE=full` — STEP 6 below is still required.**

---

# Terminal branch (APP_TYPE=terminal only — CLI/TUI apps)

Run this instead of STEPS 1–5 when STEP 0 printed `APP_TYPE=terminal`. Terminal apps have no CSS to detect and no routes/views to map; instead they get a vendored terminal stylesheet (WebTUI + a terminal-window frame) and a **command index** so the article skill can ground each step in the real command definitions. **Never execute the target binary or its build** — everything in this branch is derived from reading source.

## STEP T1 — Identify the CLI surface (YOU do this; source-only)

Read the project's manifests and entry points to determine:

- **Language + CLI framework.** Check the ecosystem's usual suspects: Go — cobra, urfave/cli (`go.mod` imports, a `cmd/` dir); Rust — clap (incl. derive), structopt (`Cargo.toml`, `#[derive(Parser)]`); Python — argparse, click, typer (`pyproject.toml [project.scripts]`, `@click.command`, `add_parser(`); Node — commander, yargs, oclif (`package.json "bin"`); Ruby — thor, gli (gemspec `executables`). If none match, find whatever dispatches on `argv` and treat that as the framework.
- **Binary name** — the name users type: `[project.scripts]` key, Cargo `[[bin]] name` (or package name), Go `cmd/<name>/`, package.json `bin` key, gemspec executable.
- **TUI framework, if any** — bubbletea, ratatui, textual, ink, blessed, prompt_toolkit (full-screen use). Presence means some commands render full-screen TUI rather than line output; record which.

## STEP T2 — Assemble branding.css from the vendored WebTUI bundle

No compilation — the bundle ships with this skill. Concatenate core + the chosen theme + the terminal frame:

```bash
WEBTUI=${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/assets/webtui
# Unknown theme names fall back to catppuccin.
node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js --exists "$WEBTUI/themes.json" "$TERM_THEME" >/dev/null 2>&1 || TERM_THEME=catppuccin
THEME_FILE=$(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js "$WEBTUI/themes.json" "$TERM_THEME.file")
THEME_ATTR=$(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js "$WEBTUI/themes.json" "$TERM_THEME.attr")
THEME_BG=$(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js "$WEBTUI/themes.json" "$TERM_THEME.background")
THEME_ACCENT=$(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js "$WEBTUI/themes.json" "$TERM_THEME.accent")

cat "$WEBTUI/webtui-core.css" "$WEBTUI/$THEME_FILE" "$WEBTUI/terminal-frame.css" > "$BRAND_DIR/branding.css"
printf 'webtui_vendored' > "$BRAND_DIR/branding.css.method.txt"
CSS_BYTES=$(wc -c < "$BRAND_DIR/branding.css" | tr -d ' ')
echo "branding.css: $CSS_BYTES bytes (theme=$TERM_THEME attr=$THEME_ATTR)"
```

## STEP T3 — Write branding.json

Write it directly (no static detector, no merge):

```bash
node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/write_branding.js terminal "$BRAND_DIR/branding.json" "$THEME_ATTR" "$THEME_BG" "$THEME_ACCENT" "$CSS_BYTES"
```

Do NOT add `google_fonts`, `framework_cdn`, or `external_stylesheets` — their absence is what keeps the mockup render fully offline (the render container blocks all external requests). `framework: "terminal"` is what stops the asset injector from adding any CDN fallback.

## STEP T4 — Structure map: command_index instead of route_index

First write the deterministic skeleton (same command as STEP 4.5; it emits a harmless near-empty map for non-web repos):

```bash
node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/detect_structure.js "$BRAND_DIR/project_map.json" "$CODEBASE" "terminal" terminal "$APP_TYPE_SOURCE"
cat "$BRAND_DIR/project_map.json"
```

Then enrich `$BRAND_DIR/project_map.json` yourself (Read/Grep + a `merge_json.js` merge, same as STEP 4.6). This is the cache the article skill runs on — do not leave `command_index` empty. Add:

1. `app_type: "terminal"` + `app_type_source` at the top level — already stamped by the skeleton call above; preserve them in your merge. **`app_type` is the field `/generate-illustrated-article` and `/generate-walkthrough` gate on.**
2. `cli_metadata`: `{ "binary": "...", "language": "...", "cli_framework": "...", "has_tui": bool, "tui_framework": "...|null", "entrypoint": "path/to/main", "hint": "<raw app_type arg if it was cli or tui>" }`. A raw `tui` hint biases `has_tui` toward true, but the determination is source-derived (STEP T1).
3. `command_index` — the terminal analogue of `route_index`. Key = the subcommand path without the binary prefix (`"deploy"`, `"config set"`); the root/no-args surface goes under `""`. Value shape:

```json
"command_index": {
  "deploy": {
    "command": "<binary> deploy",
    "definition_file": "path/to/the/command/definition",
    "description": "one-line purpose, from the command's own help/short string",
    "flags": [ { "name": "--env", "type": "string", "default": "production", "help": "..." } ],
    "subcommands": ["deploy status"],
    "help_evidence": ["verbatim strings from the definition file — help text, printed output"]
  }
}
```

   Cover the 10–30 user-facing commands: the root help surface, the primary verbs, config/auth/setup commands. Exclude hidden, internal, and dev-only commands. `definition_file` must be a real path you opened with Read — it becomes the article skill's `primary_view`, and the fidelity lint fails the run if it doesn't exist. `help_evidence` strings must appear verbatim in that file — they become `verbatim_evidence` candidates. **Do not put emoji in `help_evidence`** even if the source prints them (the mockup lint rejects emoji, so evidence containing them would be unusable).
4. `css_build: null`; leave `route_index` as `{}` and `layouts` as `[]`.

Validation (replaces the web branch's — terminal repos legitimately have no layouts):

```bash
node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/check_project_map.js terminal "$BRAND_DIR/project_map.json"
```

## Terminal summary

```bash
BINARY=$(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js "$BRAND_DIR/project_map.json" cli_metadata.binary "?")
CLIFW=$(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js "$BRAND_DIR/project_map.json" cli_metadata.cli_framework "?")
HAS_TUI=$(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js "$BRAND_DIR/project_map.json" cli_metadata.has_tui false)
COMMANDS=$(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js --length "$BRAND_DIR/project_map.json" command_index)
APP_SRC=$(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js "$BRAND_DIR/project_map.json" app_type_source hint)
CSS_KB=$(( $(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js "$BRAND_DIR/branding.json" compiled_css_bytes) / 1024 ))
THEME=$(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js "$BRAND_DIR/branding.json" terminal_theme)
node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/recommend_model_tier.js "$BRAND_DIR/project_map.json" "$BRAND_DIR/branding.json"
MODEL_TIER=$(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js "$BRAND_DIR/project_map.json" mockup_model_recommendation.tier)
MODEL_REASONS=$(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js --join ", " "$BRAND_DIR/project_map.json" 'mockup_model_recommendation.reasons[].code')

cat <<EOF

✓ Terminal-app project cache at $BRAND_DIR/

  App type:    terminal (source: $APP_SRC — $BINARY via $CLIFW, TUI: $HAS_TUI)
  Styling:     WebTUI vendored bundle, theme $THEME ($CSS_KB KB)
  Commands:    $COMMANDS command(s) indexed
  Model tier:  $MODEL_TIER ($MODEL_REASONS)

/generate-illustrated-article will render terminal-window mockups for this
project. /generate-walkthrough does not support terminal apps yet.
Re-run /detect-project if the CLI's commands change.
EOF

if [ "$APP_SRC" != "hint" ]; then
  echo "app_type=terminal was ${APP_SRC}-classified (no app_type hint given). If this is wrong, re-run: /detect-project app_type=web (or mobile)."
fi

# Deterministic STEP-6 gate — headless callers REJECT the output while
# overview.txt is missing, so this summary must not read as "done" until it exists.
if [ "${RTFM_ANALYZE:-}" = "full" ] && [ ! -s "${RTFM_OUTPUT_DIR:-./output/detect-project}/overview.txt" ]; then
  echo ""
  echo "STOP: RUN INCOMPLETE — RTFM_ANALYZE=full but overview.txt has not been written."
  echo "STEP 6 (codebase analysis) is still REQUIRED. Do STEP 6 now, then finish."
fi
```

**Do not finish here when `RTFM_ANALYZE=full` — STEP 6 below is still required.**

---

# Mobile branch (APP_TYPE=mobile only — React Native / Flutter apps)

Run this instead of STEPS 1–5 when STEP 0 printed `APP_TYPE=mobile`. Mobile apps have no web CSS to compile and no HTTP routes to map; instead they get a vendored mobile-UI stylesheet (Framework7 widgets + a phone device frame, re-tinted to the app's real brand) and a **screen index** so the article skill can ground each step in real screen definitions. **Never execute the target app or its tooling — no Metro, Gradle, Xcode, CocoaPods, or `flutter` commands** — everything in this branch is derived from reading source.

## STEP M1 — Identify the mobile surface (YOU do this; source-only)

Read the manifests and entry points to determine (recorded in M5's `mobile_metadata`):

- **Framework.** Flutter: `pubspec.yaml` with `sdk: flutter` under `dependencies`. React Native: `package.json` with a `react-native` dependency. If a monorepo contains both, prefer the app directory the skill was invoked for and note the other in `hint`.
- **Expo (RN only).** `expo` in dependencies AND (`app.json` containing an `"expo"` key, or an `app.config.{js,ts}`).
- **Entrypoint.** RN: `package.json` `main` (`expo-router/entry` ⇒ Expo Router; otherwise follow `index.js` to the root `App` component). Flutter: `lib/main.dart` (the `runApp(...)` call).
- **Navigation library.** RN: `expo-router` | `@react-navigation/*` (note which navigators are installed: `bottom-tabs`, `native-stack`, `drawer`) | `react-native-navigation`. Flutter: `go_router` | `auto_route` | `beamer` from `pubspec.yaml`; none of those ⇒ `navigator-1.0` (`MaterialApp(routes:`, `onGenerateRoute:`, `Navigator.pushNamed` call sites).
- **Styling system.** RN: `nativewind` | `styled-components` | `tamagui` | `react-native-paper` | `restyle` | `stylesheet` (plain `StyleSheet.create`). Flutter: grep `lib/` for `MaterialApp(` / `CupertinoApp(` ⇒ `material` | `cupertino` (an app using both ⇒ `material`).
- **Platform default** (used only when STEP 0 printed `PLATFORM=auto`): Flutter — `cupertino` styling ⇒ `ios`, else `android` (Flutter is Material-first; Material widgets in an iOS frame read wrong). RN/Expo — `ios`, unless the repo is Android-only (`android/` exists, no `ios/` dir, no `expo.ios` key) ⇒ `android`.
- **App id.** Expo: `expo.ios.bundleIdentifier` or `expo.android.package`. Bare RN / Flutter: `applicationId` in `android/app/build.gradle`, or the iOS bundle id from `Info.plist`/`project.pbxproj`. First found wins; null is fine.

**NativeWind assist (optional, deterministic).** If a `tailwind.config.{js,ts,cjs,mjs}` exists (NativeWind), you MAY run the web static detector to extract the Tailwind palette for M2 — consume `tailwind_extend_raw` from its output and discard the rest (M4 writes the mobile branding.json fresh; never merge the detector output in):

```bash
node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/detect_static.js "$BRAND_DIR" "$CODEBASE"
mv "$BRAND_DIR/branding.json" "$BRAND_DIR/branding-detect.json"
```

## STEP M2 — Extract the app's brand (YOU do this; the mobile analogue of STEP 2)

Goal: a small palette of **`#RRGGBB` hex values** — `primary` and `background` required, plus `secondary`/`accent`/`surface`/`text` when clearly present. Look in priority order and stop when confident:

**React Native / Expo:**

1. Theme/token modules: `constants/Colors.ts` (Expo template), `src/theme/*`, files matching `colors|palette|tokens` — named hex constants.
2. NativeWind: `theme.extend.colors` in the Tailwind config (via the M1 assist, or read the config directly).
3. Provider themes: `react-native-paper` / `tamagui` / restyle theme objects passed to the app's root Provider.
4. Fallbacks: Expo config `expo.primaryColor`, `expo.splash.backgroundColor`, `expo.android.adaptiveIcon.backgroundColor`; bare RN — `android/app/src/main/res/values/colors.xml` (`colorPrimary`), iOS `Assets.xcassets/AccentColor.colorset/Contents.json` (RGB floats × 255 → hex).

**Flutter:**

1. `ThemeData(` / `ColorScheme.fromSeed(seedColor: Color(0xFF…))` / `primarySwatch:` / `primaryColor:` in `lib/main.dart` and `lib/**/{theme,colors,app_colors}*.dart`. **Convert `Color(0xAARRGGBB)` → `#RRGGBB`** (drop the leading alpha pair) — the mockup lint's colour whitelist reads hex tokens only, never Dart literals.
2. Fallbacks: `flutter_native_splash` config in `pubspec.yaml` (`color:`), `web/manifest.json` `theme_color`, `android/**/res/values/colors.xml`.

(Font declarations — `pubspec.yaml` `fonts:`, `google_fonts` usage, Expo font loading — are informational only: the render is offline and fonts come from the vendored bundle.)

If nothing is found, use the platform's stock palette from `platforms.json` and add `"confidence": "low"` inside `default_colors` in M4.

## STEP M3 — Assemble branding.css (vendored bundle + generated brand-overrides.css)

No compilation — the bundle ships with this skill. First generate the brand re-tint with Framework7's own theme-palette generator, seeded with the M2 primary:

```bash
MOBILEUI=${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/assets/mobileui

# If STEP 0 printed PLATFORM=auto, substitute your M1 platform_default here:
[ "$PLATFORM" = auto ] && PLATFORM=ios          # ← replace ios with M1's platform_default
# Unknown values fall back to ios.
node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js --exists "$MOBILEUI/platforms.json" "$PLATFORM" >/dev/null 2>&1 || PLATFORM=ios
PLAT_ATTR=$(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js "$MOBILEUI/platforms.json" "$PLATFORM.attr")

node "$MOBILEUI/f7-color-theme.mjs" '#0000ff' > "$BRAND_DIR/brand-overrides.css"   # ← replace #0000ff with the M2 primary hex
```

Then APPEND to `$BRAND_DIR/brand-overrides.css` (Edit tool) a `:root` block declaring every **other** colour M2 extracted as a `--brand-*` custom property. This block does double duty: the hexes become part of branding.css, which is what whitelists them for the mockup lint's invented-colour check, and mockups can use them as `var(--brand-…)`:

```css
/* extracted app palette — whitelists these hexes for the mockup lint and
   makes them usable as var(--brand-…) in mockups */
:root {
  --brand-background: #ffffff;
  --brand-secondary: #16a34a;
}
```

If M2 found explicit app-bar/tab-bar colours, also append `.ios, .md { --f7-bars-bg-color: …; --f7-bars-text-color: …; }` so Framework7's bars pick them up.

Then concatenate (brand-overrides.css LAST — Framework7 ships no `@layer`, so source order gives it precedence over the vendored defaults):

```bash
cat "$MOBILEUI/framework7-core.css" "$MOBILEUI/framework7-components.css" \
    "$MOBILEUI/md3-defaults.css" "$MOBILEUI/fonts.css" "$MOBILEUI/icons.css" \
    "$MOBILEUI/device-frame.css" "$BRAND_DIR/brand-overrides.css" > "$BRAND_DIR/branding.css"
printf 'framework7_vendored' > "$BRAND_DIR/branding.css.method.txt"
CSS_BYTES=$(wc -c < "$BRAND_DIR/branding.css" | tr -d ' ')
echo "branding.css: $CSS_BYTES bytes (platform=$PLATFORM attr=$PLAT_ATTR)"
```

## STEP M4 — Write branding.json

Write it directly (no static detector, no merge):

```bash
BRAND_PRIMARY='#0000ff'      # ← M2 primary hex
BRAND_BACKGROUND='#ffffff'   # ← M2 background hex (or platforms.json's stock background)
node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/write_branding.js mobile "$BRAND_DIR/branding.json" "$PLATFORM" "$PLAT_ATTR" "$BRAND_PRIMARY" "$BRAND_BACKGROUND" "$CSS_BYTES"
```

If M2 found `secondary`/`accent`/`surface`/`text`, add them into `default_colors` afterwards (Edit tool); when the palette is the stock one, add `"confidence": "low"` there too. Do NOT add `google_fonts`, `framework_cdn`, or `external_stylesheets` — their absence is what keeps the mockup render fully offline (fonts and icons are data URIs inside the vendored bundle), and the unknown `framework: "mobile"` string stops the asset injector from adding any CDN fallback.

## STEP M5 — Structure map: screen_index + app_shell instead of route_index

First write the deterministic skeleton (same command as STEP 4.5; it emits a harmless near-empty map for non-web repos):

```bash
node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/detect_structure.js "$BRAND_DIR/project_map.json" "$CODEBASE" "mobile" mobile "$APP_TYPE_SOURCE"
cat "$BRAND_DIR/project_map.json"
```

Then enrich `$BRAND_DIR/project_map.json` yourself (Read/Grep + a `merge_json.js` merge, same as STEP 4.6). This is the cache the article skill runs on — do not leave `screen_index` empty or `app_shell` absent. Add:

1. `app_type: "mobile"` + `app_type_source` at the top level — already stamped by the skeleton call above; preserve them in your merge. **`app_type` is the field `/generate-illustrated-article` and `/generate-walkthrough` gate on.**
2. `mobile_metadata`:

```json
"mobile_metadata": {
  "framework": "react-native",
  "expo": true,
  "navigation_library": "expo-router",
  "styling_system": "nativewind",
  "theme_module": "src/theme/colors.ts",
  "platform_default": "ios",
  "app_id": "com.example.app",
  "entrypoint": "app/_layout.tsx",
  "hint": "<raw app_type arg if it was a synonym like ios/flutter, else null>"
}
```

   `theme_module` = the path of the theme/colour module M2's palette actually came from (null only when the palette came exclusively from config fallbacks like splash colours). This is a lookup the article skill depends on: it lists `theme_module` in every step's `partials_expanded` so mockups are authored with the app's real surface tints in view — a step this crucial must not depend on the generating model re-finding the file.

3. `screen_index` — the mobile analogue of `route_index`. Key = a route-ish slug: Expo Router — the file-derived path with route groups stripped (`app/(tabs)/settings.tsx` → `"settings"`, dynamic segments kept as `[id]`); React Navigation — the `Screen` `name` prop, lowercased; Flutter — the route `path` without its leading slash. The root/home screen goes under `""`. Value shape:

```json
"screen_index": {
  "settings": {
    "screen": "SettingsScreen",
    "route": "/settings",
    "definition_file": "app/(tabs)/settings.tsx",
    "navigator": "tabs",
    "title": "Settings",
    "tab": "Settings",
    "params": [],
    "ui_evidence": ["verbatim strings from the definition file — screen title, section labels, button text"]
  }
}
```

   `navigator` ∈ `tabs | stack | drawer | modal | root`; `tab` = the hosting tab's label (null when the screen is not under the tab bar); `title` = the app-bar/header title string from source (null if headerless). How to find the screens, by navigation library: **Expo Router** — list the `app/` tree; every non-`_layout`, non-`+`-prefixed file is a route, each `_layout.tsx` names its navigator (`<Tabs>`, `<Stack>`, `<Drawer>`), tab labels/icons come from `Tabs.Screen options`. **React Navigation** — grep `create(BottomTab|NativeStack|Stack|Drawer|MaterialTopTab)Navigator`, then each `<X.Screen name= component=` and follow the import to the component file; titles from `options.title`/`tabBarLabel`. **Flutter** — `GoRoute(` tables (`path:` + `builder:`/`pageBuilder:` → widget class → its file; `StatefulShellRoute`/`ShellRoute` marks the tab shell), else `MaterialApp(routes: {` and `onGenerateRoute`, plus `Navigator.pushNamed(` call sites; auto_route — `@RoutePage()` classes + the `AutoRoute(page:` table.

   Cover the **10–30 user-facing screens**: the tab roots, the primary flows they push to, settings/profile/auth. Exclude dev/debug/storybook screens. `definition_file` must be a real path you opened with Read — it becomes the article skill's `primary_view`, and the fidelity lint fails the run if it doesn't exist. `ui_evidence` strings must appear verbatim in that file — they become `verbatim_evidence` candidates. When a screen's strings live in localisation files (Flutter `.arb` under `lib/l10n/`, RN i18n JSON), record the English string and note the l10n file path — the article skill must list that file in `partials_expanded`. **Do not put emoji in `ui_evidence`** even if the app renders them (the mockup lint rejects emoji, so evidence containing them would be unusable).

4. `app_shell` — **mandatory** (resolving the persistent chrome once here is what stops mockups dropping it): the tab bar / drawer / app-bar pattern, with real labels and icons in real order from the shell's definition source (`Tabs.Screen` options, `BottomNavigationBar items:`, `NavigationBar destinations:`):

```json
"app_shell": {
  "type": "bottom-tabs",
  "definition_file": "app/(tabs)/_layout.tsx",
  "nav_items": [
    { "label": "Home", "icon": "house", "route": "index", "screen_key": "" },
    { "label": "Search", "icon": "search", "route": "search", "screen_key": "search" }
  ],
  "app_bar": { "pattern": "per-screen title, back chevron on pushed screens", "shows_title": true },
  "account_area": null
}
```

   `type` ∈ `bottom-tabs | drawer | none`. Use `"type": "none"` (not a missing key) only when the app genuinely has no persistent chrome, so the article skill knows the omission was deliberate.
5. `css_build: null`; leave `route_index` as `{}` and `layouts` as `[]`.

Validation (replaces the web branch's — mobile repos legitimately have no layouts):

```bash
node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/check_project_map.js mobile "$BRAND_DIR/project_map.json"
```

## Mobile summary

```bash
MFW=$(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js "$BRAND_DIR/project_map.json" mobile_metadata.framework "?")
IS_EXPO=$(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js "$BRAND_DIR/project_map.json" mobile_metadata.expo false)
[ "$IS_EXPO" = true ] && MFW="$MFW + expo"
NAV=$(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js "$BRAND_DIR/project_map.json" mobile_metadata.navigation_library "?")
SCREENS=$(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js --length "$BRAND_DIR/project_map.json" screen_index)
SHELL_TYPE=$(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js "$BRAND_DIR/project_map.json" app_shell.type none)
APP_SRC=$(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js "$BRAND_DIR/project_map.json" app_type_source hint)
PLAT=$(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js "$BRAND_DIR/branding.json" platform)
PRIMARY=$(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js "$BRAND_DIR/branding.json" default_colors.primary)
CSS_KB=$(( $(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js "$BRAND_DIR/branding.json" compiled_css_bytes) / 1024 ))
node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/recommend_model_tier.js "$BRAND_DIR/project_map.json" "$BRAND_DIR/branding.json"
MODEL_TIER=$(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js "$BRAND_DIR/project_map.json" mockup_model_recommendation.tier)
MODEL_REASONS=$(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js --join ", " "$BRAND_DIR/project_map.json" 'mockup_model_recommendation.reasons[].code')

cat <<EOF

✓ Mobile-app project cache at $BRAND_DIR/

  App type:    mobile (source: $APP_SRC — $MFW via $NAV)
  Platform:    $PLAT frame, brand primary $PRIMARY
  Styling:     Framework7 vendored bundle + brand overrides ($CSS_KB KB)
  Screens:     $SCREENS screen(s) indexed, shell: $SHELL_TYPE
  Model tier:  $MODEL_TIER ($MODEL_REASONS)

/generate-illustrated-article will render device-frame mockups for this
project. /generate-walkthrough does not support mobile apps yet.
Re-run /detect-project if the app's screens or theme change.
EOF

if [ "$APP_SRC" != "hint" ]; then
  echo "app_type=mobile was ${APP_SRC}-classified (no app_type hint given). If this is wrong, re-run: /detect-project app_type=web (or terminal)."
fi

# Deterministic STEP-6 gate — headless callers REJECT the output while
# overview.txt is missing, so this summary must not read as "done" until it exists.
if [ "${RTFM_ANALYZE:-}" = "full" ] && [ ! -s "${RTFM_OUTPUT_DIR:-./output/detect-project}/overview.txt" ]; then
  echo ""
  echo "STOP: RUN INCOMPLETE — RTFM_ANALYZE=full but overview.txt has not been written."
  echo "STEP 6 (codebase analysis) is still REQUIRED. Do STEP 6 now, then finish."
fi
```

**Do not finish here when `RTFM_ANALYZE=full` — STEP 6 below is still required.**

---

# Desktop branch (APP_TYPE=desktop only — Electron / Tauri apps)

Run this when STEP 0 printed `APP_TYPE=desktop`. Unlike terminal and mobile, desktop apps ARE web-rendered — the renderer's UI is real HTML/CSS — so this branch **reuses the web CSS pipeline**: run STEP D1 below first, then **STEPS 1–4 exactly as written** (D1's scoping rules apply), then **skip STEPS 4.5–5** and run D2–D3 + the Desktop summary instead, rejoining at STEP 6. **Never execute the target app or its tooling — no `npm start`, `electron .`, `tauri dev`, or packaging builds** — everything in this branch is derived from reading source.

## STEP D1 — Identify the desktop surface (YOU do this; source-only)

Read the manifests and the main process to determine (recorded in D3's `desktop_metadata`):

- **Framework.** Electron: `electron` in package.json dependencies/devDependencies. Tauri: `src-tauri/` with `tauri.conf.json`/`tauri.conf.json5`/`Tauri.toml`.
- **Main-process entry.** Electron: package.json `main` — when it points at build output (`dist/`, `.vite/`), follow it back to the source (`src/main/**`, `electron/**`, `main.{js,ts}`, `background.js`). Tauri: `src-tauri/src/main.rs` (+ `lib.rs`).
- **Renderer root** — where the front-end source lives (`src/renderer/`, `src/`, `app/`, the repo root for most Tauri projects). Two scoping rules for the web steps that follow:
  1. **`$CODEBASE` for STEPS 1–4 stays the nearest `package.json` ancestor of the renderer** — the repo root for classic Electron/Tauri layouts, a sub-package only in true monorepos. The renderer root is a *search-scope hint* for STEPS 2 and 3.2, not a new `$CODEBASE`: `compile_css.sh` requires a `package.json` at the dir it is given, and the render-time JIT later resolves `css_build` paths against the article run's cwd (the git root).
  2. **Every `css_build` path you record (entry / config / content_globs) must be git-root-relative**, for the same JIT reason.
- **Renderer framework** — react / vue / svelte / vanilla, plus the meta-bundler (vite / electron-vite / webpack / forge).
- **`window_chrome`** — how the window's titlebar is drawn; the field the mockup contract forks on. Three states, resolved **per window** and summarised top-level from the main window (**default `"native"` when no signal is found** — both frameworks default to decorated windows):
  - `"native"` — OS-drawn titlebar.
  - `"hybrid"` — system window controls drawn over an app-drawn bar: macOS `titleBarStyle: 'hidden' | 'hiddenInset' | 'customButtonsOnHover'`, Windows `titleBarOverlay` — the Slack/VS Code pattern.
  - `"custom"` — the app draws everything including window controls: `frame: false`; Tauri `decorations: false`.
  Signals: every `new BrowserWindow({...})` call in the main-process source (including option objects assembled in helpers/spreads and `process.platform === 'darwin'` conditionals), `trafficLightPosition`, a `custom-electron-titlebar` dependency; Tauri window config (v1 `tauri.windows[]`, v2 `app.windows[]`) and Rust `WindowBuilder`/`.decorations(false)` calls; `data-tauri-drag-region` attributes in renderer templates (a strong hybrid/custom tell). When chrome is hybrid or custom, ALSO record which renderer component draws the app's titlebar (`chrome_component` in D3) — the article skill lists it in `partials_expanded`.
- **Platform** (used only when STEP 0 printed `PLATFORM=auto`): `macos`, unless the repo is Windows-only (electron-builder/forge targets `win`/`nsis` with no `mac`/`dmg`, no `.icns` assets) ⇒ `windows`.
- **Windows list** — one entry per distinct window the app opens: `{name, title, width, height, window_chrome, entry}` from `BrowserWindow` call sites / Tauri window entries; `entry` = the route or renderer component the window loads.

**Now run STEPS 1–4 above exactly as written** (the static detector, in-session refinement, and CSS compile all operate on the renderer's CSS — it is ordinary web CSS), then continue at D2.

## STEP D2 — Window frame + desktop keys (after STEPS 1–4)

STEPS 1–4 produced the app's real `branding.css` + `branding.json`. Append the vendored window frame — its classes and traffic-light hexes must live inside `branding.css` so the fidelity lint whitelists them — and stamp the desktop fields:

```bash
cat ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/assets/desktop/desktop-frame.css >> "$BRAND_DIR/branding.css"
CSS_BYTES=$(wc -c < "$BRAND_DIR/branding.css" | tr -d ' ')

# $PLATFORM = STEP 0's value (or your D1 resolution when it printed auto);
# $WINDOW_CHROME = the top-level value resolved in D1.
node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/write_branding.js desktop "$BRAND_DIR/branding.json" "$PLATFORM" "$WINDOW_CHROME" "$CSS_BYTES"
```

Keep everything else the web steps wrote — the real `framework` string, `google_fonts`, `default_colors`. That is exactly what keeps the asset injector and the render-time JIT on the normal web path (no CDN is added when compiled CSS exists; the JIT reuses `css_build`).

## STEP D3 — Structure map: route_index + desktop_metadata + app_shell

First the deterministic skeleton (same command as STEP 4.5):

```bash
FRAMEWORK=$(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js "$BRAND_DIR/branding.json" framework unknown 2>/dev/null || echo unknown)
node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/detect_structure.js "$BRAND_DIR/project_map.json" "$CODEBASE" "$FRAMEWORK" desktop "$APP_TYPE_SOURCE"
cat "$BRAND_DIR/project_map.json"
```

Then enrich `$BRAND_DIR/project_map.json` yourself (Read/Grep + a `merge_json.js` merge, same as STEP 4.6). Add:

1. `app_type: "desktop"` + `app_type_source` — already stamped by the skeleton call; preserve them in your merge. **`app_type` is the field `/generate-illustrated-article` and `/generate-walkthrough` gate on.**
2. `desktop_metadata`:

```json
"desktop_metadata": {
  "framework": "electron",
  "renderer_framework": "react",
  "renderer_root": "src/renderer",
  "main_process_entry": "src/main/main.ts",
  "window_chrome": "hybrid",
  "chrome_component": "src/renderer/components/TitleBar.tsx",
  "windows": [ { "name": "main", "title": "My App", "width": 1200, "height": 800, "window_chrome": "hybrid", "entry": "src/renderer/App.tsx" } ],
  "platform_default": "macos",
  "hint": "<raw app_type arg if it was electron/tauri, else null>"
}
```

   `chrome_component` = the renderer file that draws the app's own titlebar (null when `window_chrome` is `"native"`). Like mobile's `theme_module`, this is a detect-time lookup the article skill depends on — it must not rely on the generating model re-finding the file.
3. `route_index` — **reused exactly as the web branch uses it** (desktop renderers are SPAs): key by route slug from the renderer's router table, value shaped as in STEP 4.6 item 5 with `primary_view` = the screen component file. **Router-less or multi-window apps:** one entry per window, keyed by the window's name, with its `entry` component as `primary_view`. Never leave it empty — cover the 10–30 user-facing screens.
4. `app_shell` — **mandatory**, same shape and resolution rules as STEP 4.6 item 4 (desktop apps are sidebar-heavy; resolving the persistent chrome once here is what stops mockups dropping it). Set it `null` only if every window is genuinely standalone.
5. `css_build` — from STEP 3, **paths git-root-relative** (D1 rule 2).

Validation (replaces the web branch's — a SPA renderer legitimately has no `layouts`):

```bash
node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/check_project_map.js desktop "$BRAND_DIR/project_map.json"
```

Run the STEP 4.6 render-chain resolver (the same `resolve_route_chains.js` line — these route entries are the same shape), then the **STEP 4.7 CSS health gate** (same block verbatim — the structure map now exists, so the coverage probe has views to sample). Repair `branding.css` per its output until it passes before continuing to the summary.

## Desktop summary

```bash
DFW=$(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js "$BRAND_DIR/project_map.json" desktop_metadata.framework "?")
RFW=$(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js "$BRAND_DIR/project_map.json" desktop_metadata.renderer_framework "?")
CHROME=$(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js "$BRAND_DIR/project_map.json" desktop_metadata.window_chrome native)
ROUTES=$(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js --length "$BRAND_DIR/project_map.json" route_index)
APP_SRC=$(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js "$BRAND_DIR/project_map.json" app_type_source hint)
PLAT=$(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js "$BRAND_DIR/branding.json" platform)
COMPILE_METHOD=$(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js "$BRAND_DIR/branding.json" compilation_method)
CSS_KB=$(( $(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js "$BRAND_DIR/branding.json" compiled_css_bytes) / 1024 ))
node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/recommend_model_tier.js "$BRAND_DIR/project_map.json" "$BRAND_DIR/branding.json"
MODEL_TIER=$(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js "$BRAND_DIR/project_map.json" mockup_model_recommendation.tier)
MODEL_REASONS=$(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js --join ", " "$BRAND_DIR/project_map.json" 'mockup_model_recommendation.reasons[].code')

cat <<EOF

✓ Desktop-app project cache at $BRAND_DIR/

  App type:    desktop (source: $APP_SRC — $DFW, renderer: $RFW)
  Window:      $PLAT frame, chrome: $CHROME
  Styling:     app CSS via $COMPILE_METHOD + desktop-frame ($CSS_KB KB)
  Screens:     $ROUTES route(s)/window(s) indexed
  Model tier:  $MODEL_TIER ($MODEL_REASONS)

/generate-illustrated-article will render OS-window mockups for this
project. /generate-walkthrough does not support desktop apps yet.
Re-run /detect-project if the app's screens or CSS change.
EOF

if [ "$APP_SRC" != "hint" ]; then
  echo "app_type=desktop was ${APP_SRC}-classified (no app_type hint given). If this is wrong, re-run: /detect-project app_type=web (or mobile/terminal)."
fi

# Deterministic STEP-6 gate — headless callers REJECT the output while
# overview.txt is missing, so this summary must not read as "done" until it exists.
if [ "${RTFM_ANALYZE:-}" = "full" ] && [ ! -s "${RTFM_OUTPUT_DIR:-./output/detect-project}/overview.txt" ]; then
  echo ""
  echo "STOP: RUN INCOMPLETE — RTFM_ANALYZE=full but overview.txt has not been written."
  echo "STEP 6 (codebase analysis) is still REQUIRED. Do STEP 6 now, then finish."
fi
```

**Do not finish here when `RTFM_ANALYZE=full` — STEP 6 below is still required.**

---

# Win32 branch (APP_TYPE=win32 only — native Windows GUI apps)

Run this instead of STEPS 1–5 when STEP 0 printed `APP_TYPE=win32`. Native Win32 apps have no HTML/CSS to compile — their UI is declared in `.rc` resource files (DIALOGEX dialog layouts, MENU trees) and Win32 API calls — so they get a vendored widget stylesheet (7.css classic Win32 controls + the flat Win10/11 window chrome from the desktop bundle) and a **dialog index** so the article skill can ground each step in the real resource definitions. **Never execute the target binary or its build (no MSBuild, no CMake)** — everything in this branch is derived from reading source. Chrome is always native Windows; the `platform`/`theme` args do not apply.

## STEP W1 — Identify the Win32 surface (YOU do this; source-only)

Read the project files to determine (recorded in W4's `win32_metadata`):

- **Toolchain + UI framework.** `.sln`/`.vcxproj` (or CMakeLists with `WIN32` executables); raw Win32 (`WinMain`/`wWinMain` + `RegisterClass`/`CreateWindow`), MFC (`CWinApp`), or WTL. Record which.
- **App name** — the product users know: the `.vcxproj` project name, `VERSIONINFO` `ProductName` in the main `.rc`, or the window-class/title literals in the main source.
- **Resource files.** Every `.rc` under the app's source tree (not vendored sub-libraries' test dirs). Identify the **main** `.rc` — the one carrying the top-level `MENU` resource and `VERSIONINFO`.
- **Main-window composition** — what the primary window shows, from the main `.rc` + the window-creation source: the menu bar's top-level `POPUP` entries in order (with each menu's items — see W4's `app_shell.menus`), whether there is a toolbar, a document tab strip, a status bar, and what fills the client area (e.g. an embedded editor component such as Scintilla, a list view, a canvas).
- **Accelerators.** The `ACCELERATORS` resource maps command IDs to shortcuts (`Ctrl+F` etc.) — menu labels usually do NOT carry them. Correlate by command ID so W4 can record each menu item's accelerator; a generating model cannot be expected to re-do this two-table join at article time.
- **Colour/theme source.** Where the app defines its colour scheme — a stylers/theme XML, a colour-table source file, `RGB(...)` constant blocks. Record the path for W4's `stylers_file` (null when the app has no styled content). The mockup lint whitelists only colours found in `branding.css` or listed source files, so styled-content mockups (syntax highlighting, coloured status markers) are only possible when this file is in the map.

## STEP W2 — Assemble branding.css from the vendored bundles

No compilation — the bundles ship with this skill. Concatenate the 7.css widget kit, the flat window chrome, and the win32 frame glue (order matters: last file wins):

```bash
WIN32UI=${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/assets/win32ui
DESKTOPUI=${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/assets/desktop
cat "$WIN32UI/7css.css" "$DESKTOPUI/desktop-frame.css" "$WIN32UI/win32-frame.css" > "$BRAND_DIR/branding.css"
printf '7css_vendored' > "$BRAND_DIR/branding.css.method.txt"
CSS_BYTES=$(wc -c < "$BRAND_DIR/branding.css" | tr -d ' ')
echo "branding.css: $CSS_BYTES bytes"
```

## STEP W3 — Write branding.json

Write it directly (no static detector, no merge):

```bash
node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/write_branding.js win32 "$BRAND_DIR/branding.json" "$CSS_BYTES"
```

Do NOT add `google_fonts`, `framework_cdn`, or `external_stylesheets` — their absence keeps the mockup render fully offline, and the unknown `framework: "win32"` string stops the asset injector from adding any CDN fallback (the JIT self-skips on `css_build: null`). The stock colours are 7.css's own palette; if the app defines real UI colours in source (theme XML, `RGB(...)` literals for a default colour scheme), replace `default_colors` with those and drop the low confidence.

## STEP W4 — Structure map: dialog_index instead of route_index

First write the deterministic skeleton (same command as STEP 4.5; it emits a harmless near-empty map for non-web repos):

```bash
node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/detect_structure.js "$BRAND_DIR/project_map.json" "$CODEBASE" "win32" win32 "$APP_TYPE_SOURCE"
cat "$BRAND_DIR/project_map.json"
```

Then enrich `$BRAND_DIR/project_map.json` yourself (Read/Grep + a `merge_json.js` merge, same as STEP 4.6). This is the cache the article skill runs on — do not leave `dialog_index` empty. Add:

1. `app_type: "win32"` + `app_type_source` — already stamped by the skeleton call; preserve them in your merge. **`app_type` is the field `/generate-illustrated-article` and `/generate-walkthrough` gate on.**
2. `win32_metadata`: `{ "app_name": "...", "toolchain": "msbuild|cmake", "ui_framework": "win32|mfc|wtl", "main_rc": "path/to/main.rc", "rc_files": ["..."], "client_area": "scintilla-editor|list-view|canvas|...", "stylers_file": "path/to/theme-or-stylers-source|null", "hint": "<raw app_type arg if given, else null>" }`. `stylers_file` = the W1 colour/theme source. Like mobile's `theme_module`, this is a lookup the article skill depends on — a step showing styled content lists it in `partials_expanded` to whitelist the app's real colours, and it must not depend on the generating model re-finding the file.
3. `dialog_index` — the Win32 analogue of `route_index`. Key = the dialog's resource id (or a readable slug); the **main window goes under `""`**. Value shape:

```json
"dialog_index": {
  "IDD_FIND_REPLACE_DLG": {
    "title": "Replace",
    "definition_file": "PowerEditor/src/ScintillaComponent/FindReplaceDlg.rc",
    "invoked_from": "Search > Replace... (Ctrl+H)",
    "controls": [ { "type": "combobox", "label": "Find what :" }, { "type": "checkbox", "label": "Match whole word only" }, { "type": "button", "label": "Replace All" } ],
    "ui_evidence": ["verbatim strings from the .rc — CAPTION, control labels"]
  }
}
```

   Cover the 10–30 user-facing dialogs plus the `""` main-window entry (its `ui_evidence` = menu labels, status-bar text patterns). **`controls` must list every control in the dialog's `DIALOGEX` block, in source order** — the article contract renders exactly this census, so an entry you drop here is a control missing from every screenshot. `definition_file` must be a real path you opened with Read — it becomes the article skill's `primary_view`, and the fidelity lint fails the run if it doesn't exist. `ui_evidence` strings must appear verbatim in that file — **prefer strings without `&` accelerator marks** (`"Match whole word only"`, `CAPTION` values), because the mockup renders labels `&`-stripped and the lint asserts evidence appears in both the source AND the mockup. **No emoji in `ui_evidence`.**
4. `app_shell` — **mandatory** (the main window's persistent chrome, resolved once): `{ "type": "win32-main-window", "definition_file": "<main .rc>", "nav_items": [ { "label": "File" }, { "label": "Edit" }, … ], "menus": { … }, "toolbar": true, "doc_tabs": true, "statusbar": true }` — `nav_items` = the top-level `POPUP` menu labels in real order, `&`-stripped. **`menus`** = each top-level menu's full item list, resolved once so open-menu mockups are a transcription job:

```json
"menus": {
  "Search": [
    { "item": "Find...", "accel": "Ctrl+F" },
    { "item": "Find Next", "accel": "F3" },
    { "item": "Go to...", "accel": "Ctrl+G", "divider_before": true }
  ],
  "Language": [
    { "item": "A", "submenu": ["ActionScript", "Ada", "ASN.1"] }
  ]
}
```

   Items in real `.rc` order, `&`-stripped; `accel` from the W1 accelerator-table join (null when none); nested `POPUP`s become `submenu` (labels only is enough); `divider_before: true` where the `.rc` has a `SEPARATOR`. Cover every top-level menu — this is a one-time cost that every menu screenshot reuses.
5. `css_build: null`; leave `route_index` as `{}` and `layouts` as `[]`.

Validation (replaces the web branch's — win32 repos legitimately have no layouts):

```bash
node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/check_project_map.js win32 "$BRAND_DIR/project_map.json"
```

## Win32 summary

```bash
APPNAME=$(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js "$BRAND_DIR/project_map.json" win32_metadata.app_name "?")
UIFW=$(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js "$BRAND_DIR/project_map.json" win32_metadata.ui_framework "?")
DIALOGS=$(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js --length "$BRAND_DIR/project_map.json" dialog_index)
APP_SRC=$(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js "$BRAND_DIR/project_map.json" app_type_source hint)
CSS_KB=$(( $(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js "$BRAND_DIR/branding.json" compiled_css_bytes) / 1024 ))
node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/recommend_model_tier.js "$BRAND_DIR/project_map.json" "$BRAND_DIR/branding.json"
MODEL_TIER=$(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js "$BRAND_DIR/project_map.json" mockup_model_recommendation.tier)
MODEL_REASONS=$(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js --join ", " "$BRAND_DIR/project_map.json" 'mockup_model_recommendation.reasons[].code')

cat <<EOF

✓ Win32-app project cache at $BRAND_DIR/

  App type:    win32 (source: $APP_SRC — $APPNAME via $UIFW)
  Styling:     7.css vendored bundle + Win10/11 window chrome ($CSS_KB KB)
  Dialogs:     $DIALOGS dialog(s)/window(s) indexed
  Model tier:  $MODEL_TIER ($MODEL_REASONS)

/generate-illustrated-article will render native-Windows-window mockups for
this project. /generate-walkthrough does not support win32 apps yet.
Re-run /detect-project if the app's dialogs or menus change.
EOF

if [ "$APP_SRC" != "hint" ]; then
  echo "app_type=win32 was ${APP_SRC}-classified (no app_type hint given). If this is wrong, re-run: /detect-project app_type=web (or terminal/desktop)."
fi

# Deterministic STEP-6 gate — headless callers REJECT the output while
# overview.txt is missing, so this summary must not read as "done" until it exists.
if [ "${RTFM_ANALYZE:-}" = "full" ] && [ ! -s "${RTFM_OUTPUT_DIR:-./output/detect-project}/overview.txt" ]; then
  echo ""
  echo "STOP: RUN INCOMPLETE — RTFM_ANALYZE=full but overview.txt has not been written."
  echo "STEP 6 (codebase analysis) is still REQUIRED. Do STEP 6 now, then finish."
fi
```

**Do not finish here when `RTFM_ANALYZE=full` — STEP 6 below is still required.**

---

# macOS branch (APP_TYPE=macos only — native AppKit apps)

Run this instead of STEPS 1–5 when STEP 0 printed `APP_TYPE=macos`. Native Mac apps have no HTML/CSS to compile — their UI is declared in Interface Builder files (`.xib`/`.storyboard` XML with literal `title="…"` strings and declarative `keyEquivalent` accelerators) plus AppKit code — so they get a vendored widget stylesheet (Puppertino macOS-HIG controls + the mac window chrome from the desktop bundle) and a **view index** so the article skill can ground each step in the real interface definitions. **Never execute the target app or its build (no xcodebuild, no swift build)** — everything in this branch is derived from reading source. Light appearance only in v1; the `theme`/`platform` args do not apply.

## STEP C1 — Identify the macOS surface (YOU do this; source-only)

Read the project files to determine (recorded in C4's `macos_metadata` / `app_shell`):

- **App identity.** `Info.plist` `CFBundleName` (the name users see), `NSMainNibFile` (the main xib). The `.xcodeproj` location marks the app root.
- **Interface inventory.** Every `.xib`/`.storyboard` under the app's source tree (`Base.lproj/` typically holds the localized ones). Identify which defines the **menu bar** (`<menuItem` entries — usually the main xib), which are windows, which are sheets/panels/popovers, and which are hosted **pane** views (e.g. preferences panes living as outlet views inside one window's xib).
- **`titlebar_style`** — `"unified"` (modern: `windowStyleMask … fullSizeContentView="YES"` in the xib, or `NSWindowToolbarStyleUnified` in code — toolbar merged into the titlebar) or `"classic"` (plain titled window, separate content). Deterministic default when ambiguous: a toolbar exists ⇒ unified; none ⇒ classic.
- **Toolbar — three tiers, in order:** (a) xib-defined: `<toolbarItem label="…">` entries (deterministic, free); (b) code-defined: bounded ~10-grep search for `NSToolbarItem` / `itemForItemIdentifier` / SwiftUI `ToolbarItem` sites and their `NSLocalizedString` labels — record which source file, the article skill lists it in `partials_expanded`; (c) nothing found ⇒ `toolbar: []` and the mockup contract renders traffic lights + title only (a valid macOS look — never invent items).
- **Localization posture.** `Base.lproj` xibs carrying inline English (+ per-language `.lproj/*.strings` overrides) vs strings-only. This decides where `ui_evidence` comes from.
- **Dark mode** (informational only in v1): `NSAppearance` usage, asset-catalog dark variants.

## STEP C2 — Assemble branding.css from the vendored bundles

No compilation — the bundles ship with this skill (order matters: last file wins):

```bash
MACOSUI=${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/assets/macosui
DESKTOPUI=${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/assets/desktop
cat "$MACOSUI/puppertino.css" "$MACOSUI/fonts.css" "$DESKTOPUI/desktop-frame.css" "$MACOSUI/macos-frame.css" > "$BRAND_DIR/branding.css"
printf 'puppertino_vendored' > "$BRAND_DIR/branding.css.method.txt"
CSS_BYTES=$(wc -c < "$BRAND_DIR/branding.css" | tr -d ' ')
echo "branding.css: $CSS_BYTES bytes"
```

## STEP C3 — Write branding.json

Write it directly (no static detector, no merge):

```bash
node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/write_branding.js macos "$BRAND_DIR/branding.json" "$CSS_BYTES"
```

Do NOT add `google_fonts`, `framework_cdn`, or `external_stylesheets` — the render is fully offline (Inter ships as a data URI registered as both `'Inter'` and `'SF Pro Text'`), and the unknown `framework: "macos"` string stops the asset injector from adding any CDN fallback (the JIT self-skips on `css_build: null`). If the app defines real accent/brand colours in source (asset catalogs, `NSColor` constants), replace `default_colors` and drop the low confidence.

## STEP C4 — Structure map: view_index instead of route_index

First write the deterministic skeleton (same command as STEP 4.5):

```bash
node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/detect_structure.js "$BRAND_DIR/project_map.json" "$CODEBASE" "macos" macos "$APP_TYPE_SOURCE"
cat "$BRAND_DIR/project_map.json"
```

Then enrich `$BRAND_DIR/project_map.json` yourself (Read/Grep + a `merge_json.js` merge, same as STEP 4.6). This is the cache the article skill runs on — do not leave `view_index` empty. Add:

1. `app_type: "macos"` + `app_type_source` — already stamped by the skeleton call; preserve them in your merge. **`app_type` is the field the generator skills gate on.**
2. `macos_metadata`: `{ "app_name": "...", "main_xib": "path", "xib_dir": "macosx/Base.lproj", "ui_framework": "appkit|appkit+swiftui", "localization": "base-lproj-inline|strings-only", "hint": "<raw app_type arg if given, else null>" }`.
3. `view_index` — the macOS analogue of `route_index`. Key = a window/pane slug; the **main window goes under `""`**; hosted panes are keyed `"<host>/<pane>"`. Value shape:

```json
"view_index": {
  "preferences/transfers": {
    "title": "Transfers",
    "kind": "pane",
    "host": "preferences",
    "definition_file": "macosx/Base.lproj/PrefsWindow.xib",
    "controller": "macosx/PrefsController.mm",
    "invoked_from": "AppName menu > Preferences… (⌘,) > Transfers tab",
    "controls": [ { "type": "checkBox", "label": "Start transfers when added" }, { "type": "popUpButton", "label": "Default location:" } ],
    "ui_evidence": ["verbatim strings from the xib — window titles, control labels"]
  }
}
```

   `invoked_from` = the real path a user takes to reach the view (menu path from `app_shell.menus`, a toolbar button, a keyboard shortcut) — resolve it here once, like win32's `dialog_index.invoked_from`; the article skill uses it both for prose and to decide when a screenshot shows an open menu. Null only when the view is the app's landing state.

   **`controls[]` rules (xib-specific):** it must be **complete** (every user-visible control in the view — a 4-entry census for a 10-control pane forces the generating model back into the xib, where it will guess) and in **visual top-to-bottom order** — xib XML child order is NOT layout order (autolayout frames decide position); order by each element's `frame` `y` within its container. Nest sectioned panes as `{ "type": "groupBox", "label": "…", "children": [ … ] }` so section order is explicit. For a table/outline-view main window, ALSO record `"row_anatomy": ["title", "progress bar", "secondary status line (peers/speeds)"]` — the element stack the app's cell class renders per row, from the cell xib/class; the article contract keys its rich-row rule on it.

   `kind` ∈ `window | sheet | popover | panel | pane` (`pane` = a view hosted inside another window — preferences panes, inspector tabs; its `host` names the hosting entry). A pane's `definition_file` is the xib that holds its strings (often the host window's single xib — that is fine, it is the step's `primary_view`); pane-**tab** labels defined in code mean the `controller` must be recorded so the article skill can list it. `controls[]` = every control element in the view's xib in order (`checkBox`/`popUpButton`/`segmentedControl`/`textField`/`button`/`tableView` map cleanly). Cover the 10–30 user-facing views. **Evidence rules:** `ui_evidence` strings must appear verbatim in the `definition_file`; they must contain **no `&`, `<`, `>`, or `"` characters** (xib XML entity-encodes them — `Support & Development` is `Support &amp; Development` in the file and fails the raw-substring check) and **never composed accelerator strings** ("⌘," exists in no source file — labels only). **No emoji.**
4. `app_shell` — **mandatory**: `{ "type": "macos-main-window", "definition_file": "<main xib>", "titlebar_style": "unified|classic", "toolbar": [ { "label": "Open", "icon": "folder", "from_code": true } ], "menus": { … }, "statusbar": true, "filterbar": false }` — `toolbar` from the C1 three-tier lookup (`icon` = the SF Symbol or image name hint from the xib/code; `[]` when none found); **`menus`** = each top-level menu's item list from the menu-bar xib, same shape as the Win32 branch's `app_shell.menus` (items in order, `accel` rendered as a glyph string like `"⌘O"` / `"⌥⌘O"` from `keyEquivalent` + `<modifierMask>`, nested menus as `submenu`, `divider_before` markers).
5. `css_build: null`; leave `route_index` as `{}` and `layouts` as `[]`.

Validation (replaces the web branch's — mac repos legitimately have no layouts):

```bash
node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/check_project_map.js macos "$BRAND_DIR/project_map.json"
```

## macOS summary

```bash
APPNAME=$(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js "$BRAND_DIR/project_map.json" macos_metadata.app_name "?")
UIFW=$(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js "$BRAND_DIR/project_map.json" macos_metadata.ui_framework "?")
TBSTYLE=$(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js "$BRAND_DIR/project_map.json" app_shell.titlebar_style classic)
VIEWS=$(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js --length "$BRAND_DIR/project_map.json" view_index)
APP_SRC=$(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js "$BRAND_DIR/project_map.json" app_type_source hint)
CSS_KB=$(( $(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js "$BRAND_DIR/branding.json" compiled_css_bytes) / 1024 ))
node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/recommend_model_tier.js "$BRAND_DIR/project_map.json" "$BRAND_DIR/branding.json"
MODEL_TIER=$(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js "$BRAND_DIR/project_map.json" mockup_model_recommendation.tier)
MODEL_REASONS=$(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js --join ", " "$BRAND_DIR/project_map.json" 'mockup_model_recommendation.reasons[].code')

cat <<EOF

✓ macOS-app project cache at $BRAND_DIR/

  App type:    macos (source: $APP_SRC — $APPNAME via $UIFW, titlebar: $TBSTYLE)
  Styling:     Puppertino vendored bundle + mac window chrome ($CSS_KB KB)
  Views:       $VIEWS window(s)/pane(s) indexed
  Model tier:  $MODEL_TIER ($MODEL_REASONS)

/generate-illustrated-article will render native-Mac-window mockups for this
project. /generate-walkthrough does not support macos apps yet.
Re-run /detect-project if the app's windows or menus change.
EOF

if [ "$APP_SRC" != "hint" ]; then
  echo "app_type=macos was ${APP_SRC}-classified (no app_type hint given). If this is wrong, re-run: /detect-project app_type=web (or another type)."
fi

# Deterministic STEP-6 gate — headless callers REJECT the output while
# overview.txt is missing, so this summary must not read as "done" until it exists.
if [ "${RTFM_ANALYZE:-}" = "full" ] && [ ! -s "${RTFM_OUTPUT_DIR:-./output/detect-project}/overview.txt" ]; then
  echo ""
  echo "STOP: RUN INCOMPLETE — RTFM_ANALYZE=full but overview.txt has not been written."
  echo "STEP 6 (codebase analysis) is still REQUIRED. Do STEP 6 now, then finish."
fi
```

**Do not finish here when `RTFM_ANALYZE=full` — STEP 6 below is still required.**

---

# Game branch (APP_TYPE=game only — web-rendered games)

Run this when STEP 0 printed `APP_TYPE=game`. Like desktop, web/canvas games ARE web-rendered — menu/overlay screens are real HTML/CSS — so this branch **reuses the web CSS pipeline**: run STEP G1 below first, then **STEPS 1–4 exactly as written**, then **skip STEPS 4.5–5** and run G2–G3 + the Game summary instead, rejoining at STEP 6. What no web step can capture is the **gameplay itself** — it is drawn to a `<canvas>` by JS at runtime and exists nowhere as DOM/CSS — so this branch's core addition is a **`scene_anatomy`** per canvas-drawn state, extracted from the game's render code, giving the article skill a reproduction recipe instead of forcing every generation run to re-derive the scene by hand. **Never execute the target game or its tooling — no dev server, no build** — everything here is derived from reading source. Native-engine games (Godot, Unity, Unreal, Bevy) are NOT supported by this branch — it requires a web renderer.

## STEP G1 — Identify the game surface (YOU do this; source-only)

Read the manifests and the game source to determine (recorded in G3's `game_metadata`):

- **Engine.** `vanilla-canvas` (no engine dep — a hand-rolled `requestAnimationFrame` loop), or the engine dependency from package.json: `phaser`, `pixi`, `excalibur`, `kaboom`, `melonjs`.
- **The canvas + draw-code file.** The `<canvas>` element (record its selector) and the file that owns the render loop — for vanilla games the file containing the `requestAnimationFrame` game loop and the `draw*()` functions; for engine games the scene classes/files. This file is the `primary_view` of every canvas-drawn state and the source of every scene colour.
- **Logical canvas size** — the coordinate space the draw code targets: canvas `width`/`height` attributes or JS-set dimensions, an engine `Game` config `{width, height}`, or a fixed-size container the code letterboxes to. If the game is genuinely resolution-independent, record the design resolution its constants target; failing that use 1200×750.
- **`display_size` + `display_scale`** — computed here, copied mechanically by the article skill: fit-width `W=1200, H=round(1200·h/w)`; if that `H > 900`, fit-height instead (`H=900, W=round(900·w/h)`); if the logical canvas is already ≤ 1200×900, use it 1:1 (`display_scale: 1`).
- **The state machine** — the variable or scene registry that decides what is on screen (a `gameState` string, engine scene keys), the user-reachable states, and for each whether it is a **DOM overlay** (markup in the entry HTML / templates, styled by the app's CSS) or **canvas-drawn** (painted by the draw code).
- **`hud_kind`** — `dom` (persistent HUD is HTML elements the game updates) or `canvas` (drawn with `fillText` etc.).
- **The overlay markup files** (entry HTML, template files) for the DOM screens.

Scoping rules for the web steps, same as desktop: `$CODEBASE` for STEPS 1–4 stays the nearest `package.json` ancestor, and every `css_build` path you record must be git-root-relative (the render-time JIT resolves them against the article run's cwd).

**Now run STEPS 1–4 above exactly as written** (the overlay/menu CSS is ordinary web CSS), then continue at G2.

## STEP G2 — Playfield frame + game keys (after STEPS 1–4)

STEPS 1–4 produced the app's real `branding.css` + `branding.json`. Append the vendored playfield frame — its classes must live inside `branding.css` so the fidelity lint whitelists them — and stamp the game fields:

```bash
cat ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/assets/game/game-frame.css >> "$BRAND_DIR/branding.css"
CSS_BYTES=$(wc -c < "$BRAND_DIR/branding.css" | tr -d ' ')

# $ENGINE / $LOGICAL_W×H / $DISPLAY_W×H = your G1 resolutions.
node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/write_branding.js game "$BRAND_DIR/branding.json" "$ENGINE" "$LOGICAL_W" "$LOGICAL_H" "$DISPLAY_W" "$DISPLAY_H" "$CSS_BYTES"
```

Keep everything else the web steps wrote — the real `framework` string, `google_fonts`, `default_colors`. That is exactly what keeps the asset injector and the render-time JIT on the normal web path.

## STEP G3 — Structure map: route_index + scene_anatomy + game_metadata + app_shell

First the deterministic skeleton (same command as STEP 4.5):

```bash
FRAMEWORK=$(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js "$BRAND_DIR/branding.json" framework unknown 2>/dev/null || echo unknown)
node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/detect_structure.js "$BRAND_DIR/project_map.json" "$CODEBASE" "$FRAMEWORK" game "$APP_TYPE_SOURCE"
cat "$BRAND_DIR/project_map.json"
```

Then enrich `$BRAND_DIR/project_map.json` yourself (Read/Grep + a `merge_json.js` merge, same as STEP 4.6). Add:

1. `app_type: "game"` + `app_type_source` — already stamped by the skeleton call; preserve them in your merge.
2. `game_metadata`:

```json
"game_metadata": {
  "engine": "vanilla-canvas",
  "canvas_file": "src/game.js",
  "canvas_selector": "#game",
  "logical_size": { "width": 1440, "height": 900 },
  "display_size": { "width": 1200, "height": 750 },
  "display_scale": 0.833,
  "state_variable": "this.gameState",
  "states": ["menu", "difficulty-select", "playing", "paused", "game-over"],
  "hud_kind": "dom",
  "entry_html": "index.html",
  "hint": "<raw app_type arg if it was game/canvas/phaser/pixi, else null>"
}
```

3. `route_index` — **reused exactly as the web branch uses it**: one entry per user-reachable screen/state, keyed by a state slug, shaped as in STEP 4.6 item 5 **plus a `method` field**: `"UI"` for DOM overlay screens (`primary_view` = the markup file) or `"CANVAS"` for canvas-drawn states (`primary_view` = the draw-code file). Every entry's `partials_expanded` includes the draw-code file, the entry HTML, and the stylesheet — listing the draw-code file is what whitelists the game's palette for the fidelity lint. Never leave the index empty.
4. **`scene_anatomy` on every `method: "CANVAS"` entry** — the reproduction recipe, read straight out of the state's draw functions:

```json
"scene_anatomy": {
  "canvas_size": { "width": 1440, "height": 900 },
  "background": {
    "clear_color": "#000033",
    "gradient": { "direction": "vertical",
      "stops": [ { "offset": 0, "color": "#0a0a1a" }, { "offset": 1, "color": "#3a3a4e" } ] }
  },
  "layers": [
    { "name": "stars", "draw_fn": "drawStars",
      "entities": [ { "name": "star", "shape": "dot", "colors": ["#ffffff"], "size": "1-2px",
                      "count_hint": "dozens, scattered across the upper two-thirds" } ] },
    { "name": "terrain", "draw_fn": "drawTerrain",
      "entities": [ { "name": "ridge", "shape": "path silhouette", "colors": ["#2a2a2a"],
                      "count_hint": "horizon band across the full width" } ] },
    { "name": "enemies", "draw_fn": "drawEnemies",
      "entities": [ { "name": "enemy ship", "shape": "sprite polygon + trail line", "colors": ["#ff4444", "#666666"],
                      "size": "~24px", "count_hint": "3-5 mid-flight", "catalog": "this.enemyTypes" } ] }
  ],
  "text_literals": [ "Score: ", "Wave " ],
  "evidence": [ "<draw-code file> game loop draw order", "<draw-code file> background gradient stops" ]
}
```

   Rules: `layers` MUST be in game-loop draw-call order (paint order is z-order). `colors` are **verbatim hex/rgb literals from the draw code** — the article skill copies them, never approximates. `count_hint` is a plausible-mid-game guide. An entity's optional `catalog` names a source structure (a types/spec table) whose variants a mockup may sample. `text_literals` are canvas-drawn string fragments **exactly as they appear literally in source** (a template literal's fixed prefix) — they double as lint-checkable evidence. Capture what the draw functions say, at the grain shown — **`scene_anatomy` is the completeness checklist for a mockup, not the artifact**: it records what kinds of things are on screen and how they look, never every instance.

5. `app_shell` — **mandatory**, game-shaped: the persistent in-game chrome is the HUD.

```json
"app_shell": {
  "type": "game-hud",
  "definition_file": "index.html",
  "hud_selector": "#hud",
  "hud_fields": [
    { "label": "Score", "format": "Score: <n>", "position": "top-left", "font": "14px <font family>",
      "color": "#ffffff", "rendered_by": "dom", "source": "index.html" }
  ]
}
```

   `hud_selector` is the deterministic string the lint backstop checks for (id/class of the real HUD container for `dom` HUDs). `type: "none"` only if the game genuinely shows no persistent HUD during play.
6. `css_build` — from STEP 3, paths git-root-relative (G1 rule).

Validation (replaces the web branch's — a game legitimately has no `layouts`):

```bash
node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/check_project_map.js game "$BRAND_DIR/project_map.json"
```

Run the STEP 4.6 render-chain resolver (the same `resolve_route_chains.js` line — these route entries are the same shape), then the **STEP 4.7 CSS health gate** (same block verbatim — the structure map now exists, so the coverage probe has views to sample; canvas-state entries whose `primary_view` is draw code extract no class tokens and are skipped automatically). Repair `branding.css` per its output until it passes before continuing to the summary.

## Game summary

```bash
ENGINE=$(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js "$BRAND_DIR/project_map.json" game_metadata.engine "?")
STATES=$(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js --length "$BRAND_DIR/project_map.json" route_index)
CANVAS_STATES=$(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js --count "$BRAND_DIR/project_map.json" 'route_index[]' method=CANVAS)
DISPW=$(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js "$BRAND_DIR/branding.json" display_size.width)
DISPH=$(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js "$BRAND_DIR/branding.json" display_size.height)
APP_SRC=$(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js "$BRAND_DIR/project_map.json" app_type_source hint)
COMPILE_METHOD=$(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js "$BRAND_DIR/branding.json" compilation_method)
CSS_KB=$(( $(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js "$BRAND_DIR/branding.json" compiled_css_bytes) / 1024 ))
node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/recommend_model_tier.js "$BRAND_DIR/project_map.json" "$BRAND_DIR/branding.json"
MODEL_TIER=$(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js "$BRAND_DIR/project_map.json" mockup_model_recommendation.tier)
MODEL_REASONS=$(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js --join ", " "$BRAND_DIR/project_map.json" 'mockup_model_recommendation.reasons[].code')

cat <<EOF

✓ Game project cache at $BRAND_DIR/

  App type:    game (source: $APP_SRC — engine: $ENGINE)
  Playfield:   ${DISPW}x${DISPH} display (logical $(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js "$BRAND_DIR/branding.json" canvas_size.width)x$(node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js "$BRAND_DIR/branding.json" canvas_size.height))
  Styling:     app CSS via $COMPILE_METHOD + game-frame ($CSS_KB KB)
  Screens:     $STATES state(s) indexed ($CANVAS_STATES canvas-drawn, with scene_anatomy)
  Model tier:  $MODEL_TIER ($MODEL_REASONS)

/generate-illustrated-article will render playfield mockups for this
project. /generate-walkthrough does not support game apps yet.
Re-run /detect-project if the game's screens or CSS change.
EOF

if [ "$APP_SRC" != "hint" ]; then
  echo "app_type=game was ${APP_SRC}-classified (no app_type hint given). If this is wrong, re-run: /detect-project app_type=web (or another type)."
fi

# Deterministic STEP-6 gate — headless callers REJECT the output while
# overview.txt is missing, so this summary must not read as "done" until it exists.
if [ "${RTFM_ANALYZE:-}" = "full" ] && [ ! -s "${RTFM_OUTPUT_DIR:-./output/detect-project}/overview.txt" ]; then
  echo ""
  echo "STOP: RUN INCOMPLETE — RTFM_ANALYZE=full but overview.txt has not been written."
  echo "STEP 6 (codebase analysis) is still REQUIRED. Do STEP 6 now, then finish."
fi
```

**Do not finish here when `RTFM_ANALYZE=full` — STEP 6 below is still required.**

---

## STEP 6 — Codebase analysis (MANDATORY when RTFM_ANALYZE=full)

Skip this step entirely unless the environment variable `RTFM_ANALYZE` is set to `full` (you checked in STEP 0). When it IS set, this step is not optional: the headless caller rejects the run if `summary.md` or `overview.txt` is missing. Interactive use (env unset) is unchanged.

**Do ALL of this step yourself, in this session, with Bash heredocs. Do NOT spawn a subagent/Task for any part of it** — a subagent does not reliably see `$RTFM_OUTPUT_DIR` and will write the files to the wrong place. Before writing, run `echo "OUT=$OUT"` and use that exact directory for every file below.

```bash
OUT="${RTFM_OUTPUT_DIR:-./output/detect-project}"
mkdir -p "$OUT"
WORKSPACE="${RTFM_REPOS_ROOT:-.}"   # multi-repo: the dir holding every checkout; else the working directory

# 6a — File tree (mechanical) + commit SHA
{
  find "$WORKSPACE" -maxdepth 6 \
    -name node_modules -prune -o \
    -name .git -prune -o \
    -name vendor -prune -o \
    -name build -prune -o \
    -name dist -prune -o \
    -name __pycache__ -prune -o \
    -name .next -prune -o \
    -name .nuxt -prune -o \
    -name coverage -prune -o \
    -name tmp -prune -o \
    -name log -prune -o \
    -name logs -prune -o \
    -name '.cache' -prune -o \
    -type f -print -o -type d -print | \
    sort | \
    sed "s|^${WORKSPACE}/||"
} | head -n 2000 > "$OUT/file_tree.txt"

git rev-parse HEAD > "$OUT/commit_sha.txt" 2>/dev/null || true
RELATED_REPOS=$(bash ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/generate-illustrated-article/scripts/related_repos.sh)
if [ -n "$RELATED_REPOS" ]; then
  echo "MULTI_REPO=yes"
  # Which checkouts have a user-facing interface, and of which kind (deterministic).
  node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/classify_workspace.js "$RTFM_REPOS_ROOT" > "$OUT/surfaces.json"
  cat "$OUT/surfaces.json"
else
  echo "MULTI_REPO=no"
fi
```

**6b — Project summary.** Write a SHORT project summary in markdown to `$OUT/summary.md` — **15–20 lines maximum, hard cap**. One or two lines each on: what the product does, tech stack, architecture shape, key directories, and notable user-facing feature areas. This is quick orientation context for later generation runs, not documentation — downstream consumers also get the structure map and explore the code themselves, so do not be comprehensive. **Write it inline from what you already learned in STEPS 1–5 — do not re-explore the codebase.** The one exception is `MULTI_REPO=yes`: skim each related repository first (its README, manifest and top-level directories — a handful of reads each, not an exploration) so the summary names every repository and what it contributes. Write the file with a Bash heredoc.

**6c — End-user overview.** Write a 2-3 sentence overview to `$OUT/overview.txt` describing what this project does for END USERS (not developers). Focus on the user-facing functionality and value proposition. Do not mention technical implementation details like frameworks, databases, or architecture. Write it as if explaining to a non-technical person what the software helps them accomplish.

**6d — Repository relationships (multi-repo only).** Write `$OUT/repository_relationships.json` if and only if 6a printed `MULTI_REPO=yes`. List every checkout under `$WORKSPACE` — the working directory and each related repository — using its directory name exactly as it appears there:

```json
{
  "repositories": [
    {
      "directory": "owner-repo1",
      "name": "repo1",
      "role": "Brief role description (e.g., Backend API server)",
      "description": "What this repository does and its main purpose",
      "surface": "copied verbatim from surfaces.json for this directory"
    }
  ],
  "relationships": [
    {
      "from": "directory-name",
      "to": "directory-name",
      "type": "consumes|provides|extends|shares",
      "description": "How these repositories relate to each other"
    }
  ],
  "architecture_summary": "A 2-3 sentence summary of how all repositories work together as a system"
}
```

`surface` is the value `surfaces.json` printed for that directory (`web`, `terminal`, `mobile`, … or `none` for a repository with no user-facing interface) — copy it, never re-judge it. Let it inform `role`: a `none` repository is an API, service or library; two repositories with an interface are distinct surfaces of the product (e.g. "Customer web app" and "Admin panel", or "Web app" and "CLI").

Relationship types: consumes (one repo uses/calls another, e.g. frontend calls backend API), provides (provides services/data to another), extends (builds upon another), shares (shares common code, data, or configuration).

Validate every JSON file you wrote with `node ${RTFM_SKILLS_DIR:-$HOME/.rtfm-skills}/detect-project/scripts/json_get.js --valid <file>` and fix it if invalid.

## Notes for the user

- The cache directory `./.rtfm/` is project-scoped and shared by all the rtfm skills (branding, structure map, image manifest, card background). Add it to `.gitignore` if you don't want any of it committed (a per-cache `.gitignore` already excludes the big derived files; `branding.json` and `project_map.json` stay visible because they're small and committable).
- `branding.json` is small and plausibly committable so teammates inherit the same detected branding.
- If something looks wrong (wrong primary colour, missing font), open `branding.json` and edit it manually — every subsequent run of `/generate-illustrated-article` or `/generate-walkthrough` picks up the change.
- Re-run this skill when you change `tailwind.config.{js,ts}`, the project's brand colour defaults, or its layout-injected fonts. There is no automatic invalidation in v1.
