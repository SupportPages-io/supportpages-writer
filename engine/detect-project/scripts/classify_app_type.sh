#!/usr/bin/env bash
# classify_app_type.sh — deterministic app-type classifier for /detect-project
# when the user gave no app_type hint. Root-level manifests only; conservative
# by design: it diverts from web only on unambiguous signals. Multi-surface
# repos (react-native + react-dom, CLI + web framework, monorepos with the app
# in a subdirectory) default to web and emit a note= line the caller surfaces.
#
# Usage: classify_app_type.sh <codebase_dir>
#
# Output (line-oriented):
#   type=web|terminal|mobile|desktop|win32|macos|game
#   source=auto|default    auto = positive identification; default = nothing matched
#   reason=<one line explaining the decision>
#   note=<0+ lines — ambiguities worth surfacing to the user>
#
# Decision order: mobile → desktop (Electron/Tauri — must precede the web
# signals, since Electron renderers have react-dom) → web signals → game
# (web/canvas game engine + no web framework — before terminal, a game repo may
# also carry a CLI helper) → terminal (CLI framework + no web framework; Bevy
# vetoes the near-universal clap) → win32 (VS project + DIALOGEX .rc, no
# web/CLI signals) → macos (Xcode project + AppKit menu bar) → monorepo +
# native-game-engine + vanilla-canvas notes → web.
#
# Always exits 0. Bash 3.2 + BSD/GNU grep compatible (no \b, no flock, no jq).

CODEBASE="${1:-.}"
CODEBASE="${CODEBASE%/}"
NOTES=()

has() { [ -e "$CODEBASE/$1" ]; }
dep() { [ -f "$CODEBASE/$1" ] && grep -Eq "$2" "$CODEBASE/$1" 2>/dev/null; }

finish() { # finish <type> <source> <reason>
  printf 'type=%s\nsource=%s\nreason=%s\n' "$1" "$2" "$3"
  for n in ${NOTES[@]+"${NOTES[@]}"}; do printf 'note=%s\n' "$n"; done
  exit 0
}

# ---------- mobile: unambiguous root-level signals ----------
if dep pubspec.yaml 'sdk:[[:space:]]*flutter'; then
  # Flutter-DESKTOP refinement: desktop platform dirs with no mobile ones means
  # the mobile branch would render this app in a phone frame — wrong, and the
  # desktop branch supports Electron/Tauri only. Note it, stay web.
  if { has macos || has windows || has linux; } && ! has android && ! has ios; then
    NOTES+=("Flutter DESKTOP app (desktop platform dirs, no android/ or ios/) — not supported by the desktop branch (Electron/Tauri only). Defaulting to web; pass app_type=mobile to force phone-frame docs.")
  else
    finish mobile auto "pubspec.yaml declares an sdk: flutter dependency — Flutter app"
  fi
fi
if dep package.json '"react-native"[[:space:]]*:'; then
  if dep package.json '"react-dom"[[:space:]]*:'; then
    NOTES+=("package.json has both react-native and react-dom — multi-surface repo (native app + web). Defaulting to web; pass app_type=mobile to document the native app instead.")
  else
    finish mobile auto "package.json depends on react-native with no react-dom — React Native app"
  fi
fi

# ---------- desktop: Electron / Tauri ----------
# Checked BEFORE the web signals on purpose: an Electron renderer has react-dom
# (often next/vite too), so the web positive ID would otherwise always win.
if [ -f "$CODEBASE/src-tauri/tauri.conf.json" ] || [ -f "$CODEBASE/src-tauri/tauri.conf.json5" ] \
  || [ -f "$CODEBASE/src-tauri/Tauri.toml" ] || [ -f "$CODEBASE/tauri.conf.json" ]; then
  finish desktop auto "Tauri configuration found — Tauri desktop app"
fi
if dep package.json '"electron"[[:space:]]*:'; then
  # The dep alone is not unambiguous (a web workspace root can list electron for
  # a wrapper subpackage) — require a main-process tell: the package.json "main"
  # entry creating a BrowserWindow, or packaging config (electron-builder/forge/
  # electron-vite).
  ELECTRON_TELL=""
  MAIN_REL=$(sed -n 's/.*"main"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$CODEBASE/package.json" 2>/dev/null | head -1)
  if [ -n "$MAIN_REL" ] && [ -f "$CODEBASE/$MAIN_REL" ] && grep -Eq 'BrowserWindow|app\.whenReady' "$CODEBASE/$MAIN_REL" 2>/dev/null; then
    ELECTRON_TELL="main entry $MAIN_REL creates a BrowserWindow"
  elif [ -f "$CODEBASE/electron-builder.yml" ] || [ -f "$CODEBASE/electron-builder.yaml" ] || [ -f "$CODEBASE/electron-builder.json" ] \
    || [ -f "$CODEBASE/forge.config.js" ] || [ -f "$CODEBASE/forge.config.cjs" ] || [ -f "$CODEBASE/forge.config.ts" ] \
    || [ -f "$CODEBASE/electron.vite.config.js" ] || [ -f "$CODEBASE/electron.vite.config.mjs" ] || [ -f "$CODEBASE/electron.vite.config.ts" ] \
    || dep package.json '"forge"[[:space:]]*:'; then
    ELECTRON_TELL="Electron packaging config present"
  fi
  if [ -n "$ELECTRON_TELL" ]; then
    finish desktop auto "package.json depends on electron and $ELECTRON_TELL — Electron desktop app"
  fi
  NOTES+=("electron dependency found but no main-process tell (compiled entry, or a wrapper subpackage?). Defaulting to web; pass app_type=desktop if this repo is the Electron app.")
fi

# ---------- web framework signals (positive web ID; also the terminal veto) ----------
WEB_REASON=""
if has config/routes.rb && has Gemfile; then WEB_REASON="Rails (Gemfile + config/routes.rb)"
elif dep mix.exs '\{:phoenix'; then WEB_REASON="Phoenix (mix.exs)"
elif has artisan; then WEB_REASON="Laravel (artisan)"
elif has manage.py; then WEB_REASON="Django (manage.py)"
elif has next.config.js || has next.config.mjs || has next.config.ts; then WEB_REASON="Next.js (next.config.*)"
elif dep package.json '"(react-dom|next|nuxt|vue|svelte|@angular/core|astro|@remix-run/react|express|fastify|koa|hono)"[[:space:]]*:'; then
  WEB_REASON="web framework dependency in package.json"
elif dep Cargo.toml '^[[:space:]]*(actix-web|axum|rocket|warp|poem)[[:space:]]*='; then
  WEB_REASON="Rust web framework in Cargo.toml"
elif dep go.mod '(gin-gonic/gin|labstack/echo|gofiber/fiber|go-chi/chi)'; then
  WEB_REASON="Go web framework in go.mod"
elif dep pyproject.toml '(^(django|flask|fastapi|starlette)[[:space:]]*=|["'"'"'](django|flask|fastapi|starlette)[=>< ~!,"'"'"'])' \
  || dep requirements.txt '^(django|flask|fastapi|starlette)([=><~ !]|$)'; then
  WEB_REASON="Python web framework dependency"
fi

# ---------- game: web/canvas game engine (renders as web tech) ----------
# Positive only for engines that are games-only in practice. three.js / Babylon /
# playcanvas are deliberately NOT signals (huge non-game viz/3D usage — no note
# either). Native engines (Godot/Unity/Unreal/Bevy) are note-only further down:
# the game branch supports web-rendered games only.
GAME_REASON=""
if dep package.json '"(phaser|pixi\.js|@pixi/[a-z-]+|excalibur|kaboom|kaplay|melonjs)"[[:space:]]*:'; then
  GAME_REASON="web game engine dependency in package.json"
fi
if [ -n "$GAME_REASON" ]; then
  if [ -z "$WEB_REASON" ]; then
    finish game auto "$GAME_REASON, and no web framework in the root manifests — web/canvas game"
  fi
  NOTES+=("Both a game engine ($GAME_REASON) and a web framework ($WEB_REASON) are present. Defaulting to web; pass app_type=game to document the game instead.")
fi

# ---------- terminal: a CLI/TUI framework AND no web framework at all ----------
CLI_REASON=""
if dep Cargo.toml '^[[:space:]]*(clap|structopt)[[:space:]]*='; then
  CLI_REASON="Rust CLI framework (clap/structopt) in Cargo.toml"
elif dep Cargo.toml '^[[:space:]]*(ratatui|crossterm|cursive|tui)[[:space:]]*='; then
  CLI_REASON="Rust TUI framework in Cargo.toml"
elif dep go.mod '(spf13/cobra|urfave/cli|charmbracelet/bubbletea)'; then
  CLI_REASON="Go CLI/TUI framework in go.mod"
elif dep pyproject.toml '^\[project\.scripts\]' || dep setup.cfg 'console_scripts' || dep setup.py 'console_scripts'; then
  CLI_REASON="Python console-script entry points"
elif dep pyproject.toml '(^(click|typer|textual)[[:space:]]*=|["'"'"'](click|typer|textual)[=>< ~!,"'"'"'])' \
  || dep requirements.txt '^(click|typer|textual)([=><~ !]|$)'; then
  CLI_REASON="Python CLI/TUI framework dependency"
elif dep package.json '"bin"[[:space:]]*:' && dep package.json '"(commander|yargs|oclif|@oclif/core|ink)"[[:space:]]*:'; then
  CLI_REASON="package.json bin entry + Node CLI framework"
fi

# Bevy veto: a Bevy game near-universally carries clap for launcher args, which
# would positively classify terminal. Bevy is a native-engine GAME — the mockup
# pipeline supports web-rendered games only, so veto the CLI signal and note it.
if dep Cargo.toml '^[[:space:]]*bevy[[:space:]]*='; then
  CLI_REASON=""
  NOTES+=("Cargo.toml carries the Bevy game engine — a native-engine game, not supported by the mockup pipeline (web-rendered games only). Defaulting to web.")
fi

if [ -n "$CLI_REASON" ]; then
  if [ -z "$WEB_REASON" ]; then
    finish terminal auto "$CLI_REASON, and no web framework in the root manifests — CLI/TUI app"
  fi
  NOTES+=("Both a CLI framework ($CLI_REASON) and a web framework ($WEB_REASON) are present. Defaulting to web; pass app_type=terminal to document the CLI instead.")
fi

# ---------- win32: native Windows GUI (Visual Studio project + dialog resources) ----------
# Unambiguous only when nothing web/CLI matched: a .sln/.vcxproj plus an .rc
# resource that defines dialogs (DIALOGEX). Qt/.ui apps deliberately do NOT
# match (unsupported); a C++ CLI has no dialog resources.
if [ -z "$WEB_REASON" ] && [ -z "$CLI_REASON" ]; then
  VS_PROJ=$(find "$CODEBASE" -maxdepth 3 \( -name '*.vcxproj' -o -name '*.sln' \) -not -path '*/.git/*' 2>/dev/null | head -1)
  if [ -n "$VS_PROJ" ]; then
    RC_DLG=""
    while IFS= read -r rcf; do
      if grep -q 'DIALOGEX' "$rcf" 2>/dev/null; then RC_DLG="$rcf"; break; fi
    done < <(find "$CODEBASE" -maxdepth 4 -name '*.rc' -not -path '*/.git/*' 2>/dev/null | head -20)
    if [ -n "$RC_DLG" ]; then
      finish win32 auto "Visual Studio project + Win32 dialog resources (.rc with DIALOGEX) — native Windows GUI app"
    fi
  fi
fi

# ---------- macos: native AppKit (Xcode project + Interface Builder UI) ----------
# Checked after mobile/desktop on purpose: Flutter macOS runners and Electron
# apps also ship .xcodeproj files but are caught by the earlier signals. The
# gate is <menuItem — an AppKit menu bar is definitive (iOS storyboards have
# none). Pure-SwiftUI apps (no IB files) get a note, never auto-classified.
if [ -z "$WEB_REASON" ] && [ -z "$CLI_REASON" ]; then
  XCPROJ=$(find "$CODEBASE" -maxdepth 2 -name '*.xcodeproj' -not -path '*/.git/*' 2>/dev/null | head -1)
  if [ -n "$XCPROJ" ]; then
    IB_FILE=""
    while IFS= read -r xf; do
      if grep -q '<menuItem ' "$xf" 2>/dev/null; then IB_FILE="$xf"; break; fi
    done < <(find "$CODEBASE" -maxdepth 4 \( -name '*.xib' -o -name '*.storyboard' \) -not -path '*/.git/*' 2>/dev/null | head -20)
    if [ -n "$IB_FILE" ]; then
      for fe in qt gtk web android windows linux; do
        if [ -d "$CODEBASE/$fe" ]; then
          NOTES+=("Multi-frontend repo: $fe/ (and possibly others) exists alongside the macOS app. Classifying macos (root Xcode project is the primary-surface signal); pass app_type=web or another hint to document a different surface.")
          break
        fi
      done
      finish macos auto "Xcode project + Interface Builder UI (a .xib/.storyboard defines an AppKit menu bar) — native macOS app"
    fi
    NOTES+=("Xcode project found but no Interface Builder files with an AppKit menu bar (pure SwiftUI, or an iOS app?). Defaulting to web; pass app_type=macos if this is a native macOS app.")
  fi
fi

# ---------- monorepo hints: notes only, never classification ----------
# An app living in a subdirectory can't be safely classified from the root, but
# it is worth telling the user where it is (Immich mobile/, LocalSend app/).
while IFS= read -r f; do
  rel="${f#"$CODEBASE"/}"
  if grep -Eq 'sdk:[[:space:]]*flutter' "$f" 2>/dev/null; then
    NOTES+=("Flutter app found at $rel — to document it, re-run /detect-project with codebase_path=${rel%/pubspec.yaml} app_type=mobile.")
  fi
done < <(find "$CODEBASE" -mindepth 2 -maxdepth 3 -name pubspec.yaml -not -path '*/node_modules/*' -not -path '*/.git/*' 2>/dev/null | head -3)

while IFS= read -r f; do
  rel="${f#"$CODEBASE"/}"
  if grep -Eq '"react-native"[[:space:]]*:' "$f" 2>/dev/null && ! grep -Eq '"react-dom"[[:space:]]*:' "$f" 2>/dev/null; then
    NOTES+=("React Native app found at ${rel%/package.json} — to document it, re-run /detect-project with codebase_path=${rel%/package.json} app_type=mobile.")
  elif grep -Eq '"electron"[[:space:]]*:' "$f" 2>/dev/null; then
    NOTES+=("Electron app found at ${rel%/package.json} — to document it, re-run /detect-project with codebase_path=${rel%/package.json} app_type=desktop.")
  fi
done < <(find "$CODEBASE" -mindepth 2 -maxdepth 3 -name package.json -not -path '*/node_modules/*' -not -path '*/.git/*' 2>/dev/null | head -20)

while IFS= read -r f; do
  rel="${f#"$CODEBASE"/}"
  if grep -Eq '^[[:space:]]*(clap|structopt|ratatui)[[:space:]]*=' "$f" 2>/dev/null; then
    NOTES+=("CLI/TUI crate found at ${rel%/Cargo.toml} (workspace member) — if this repo is a CLI/TUI app, pass app_type=terminal.")
  fi
done < <(find "$CODEBASE" -mindepth 2 -maxdepth 3 -name Cargo.toml -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/target/*' 2>/dev/null | head -5)

# ---------- native game engines: notes only, never classification ----------
# The game branch supports web-rendered games only; a native-engine project has
# no web CSS/DOM surface for the pipeline to work with.
if has project.godot; then
  NOTES+=("project.godot found — a Godot game (native engine), not supported by the mockup pipeline (web-rendered games only).")
fi
if [ -f "$CODEBASE/ProjectSettings/ProjectVersion.txt" ]; then
  NOTES+=("ProjectSettings/ProjectVersion.txt found — a Unity game (native engine), not supported by the mockup pipeline (web-rendered games only).")
fi
UPROJ=$(find "$CODEBASE" -maxdepth 2 -name '*.uproject' -not -path '*/.git/*' 2>/dev/null | head -1)
if [ -n "$UPROJ" ]; then
  NOTES+=("${UPROJ#"$CODEBASE"/} found — an Unreal game (native engine), not supported by the mockup pipeline (web-rendered games only).")
fi

# ---------- vanilla-canvas game: note only, adjudicated in STEP 0 ----------
# A root index.html drawing to a <canvas> with no framework signal at all is
# often a hand-rolled canvas game — but canvas alone is weak evidence (charts,
# viz). The note triggers the STEP 0 surface adjudication, which diverts to
# game only when the repo evidence is one-sided.
if [ -z "$WEB_REASON" ] && [ -z "$CLI_REASON" ] && [ -z "$GAME_REASON" ] && dep index.html '<canvas'; then
  NOTES+=("Root index.html draws to a <canvas> and no web framework is present — possibly a vanilla-canvas game. If it is, the right type is app_type=game (canvas-scene mockups); the surface adjudication should decide from the repo evidence.")
fi

if [ -n "$WEB_REASON" ]; then
  finish web auto "$WEB_REASON"
fi
finish web default "no unambiguous app-type signals in the root manifests — taking the web path"
