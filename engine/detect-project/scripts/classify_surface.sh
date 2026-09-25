#!/usr/bin/env bash
# classify_surface.sh — does this checkout have a user-facing interface, and of
# which kind? Wraps classify_app_type.sh (which never says "no UI": an API-only
# Rails app or an Express JSON server is web to it) with a deterministic
# no-UI check, so a multi-repo product can tell its surfaces (web app, admin
# panel, CLI, mobile app) from its code-only repos (APIs, libraries).
#
# Usage: classify_surface.sh <codebase_dir>
#
# Output (line-oriented):
#   surface=web|terminal|mobile|desktop|win32|macos|game|none
#   source=auto|default     auto = positive identification
#   reason=<one line>
#
# Only a web verdict is refined: terminal/mobile/desktop/win32/macos/game are
# positive identifications of an interface. A web verdict becomes
#   - none when Rails declares config.api_only = true;
#   - web when package.json has a frontend framework dependency, or there are
#     UI sources: 3+ template/markup/style/component files outside tests, docs,
#     mailers and vendored/bundled code (engine/, third_party/, assets/vendor/…);
#   - terminal when package.json declares a bin (a hand-rolled Node CLI that
#     classify_app_type.sh's framework list misses);
#   - none otherwise (a server/API or library).
#
# Always exits 0. Bash 3.2 + BSD/GNU grep compatible.

CODEBASE="${1:-.}"
CODEBASE="${CODEBASE%/}"
HERE="$(cd "$(dirname "$0")" && pwd)"

finish() { printf 'surface=%s\nsource=%s\nreason=%s\n' "$1" "$2" "$3"; exit 0; }

[ -d "$CODEBASE" ] || finish none default "codebase directory does not exist"

CLASSIFY=$(bash "$HERE/classify_app_type.sh" "$CODEBASE" 2>/dev/null)
TYPE=$(printf '%s\n' "$CLASSIFY" | sed -n 's/^type=//p' | head -1)
SOURCE=$(printf '%s\n' "$CLASSIFY" | sed -n 's/^source=//p' | head -1)
REASON=$(printf '%s\n' "$CLASSIFY" | sed -n 's/^reason=//p' | head -1)
TYPE="${TYPE:-web}"
SOURCE="${SOURCE:-default}"

if [ "$TYPE" != "web" ]; then
  finish "$TYPE" "$SOURCE" "$REASON"
fi

# ---------- Rails API mode ----------
if [ -f "$CODEBASE/config/application.rb" ] &&
   grep -Eq '^[[:space:]]*config\.api_only[[:space:]]*=[[:space:]]*true' "$CODEBASE/config/application.rb" 2>/dev/null; then
  finish none auto "Rails app with config.api_only = true — an API, no user-facing interface"
fi

# ---------- frontend framework dependency ----------
if [ -f "$CODEBASE/package.json" ] &&
   grep -Eq '"(react-dom|vue|svelte|@sveltejs/kit|@angular/core|solid-js|preact|next|nuxt|@remix-run/react|astro|ember-source|lit|@builder.io/qwik|alpinejs|htmx.org|@hotwired/turbo|@hotwired/stimulus)"[[:space:]]*:' "$CODEBASE/package.json" 2>/dev/null; then
  finish web "$SOURCE" "${REASON:-frontend framework dependency in package.json}"
fi

# ---------- UI sources ----------
# Templates, markup, styles and component files, excluding places that hold
# UI-shaped files without being an interface (tests, docs, mail, vendored code,
# and the skills' own .rtfm cache and ./output mockups).
UI_COUNT=$(find "$CODEBASE" \
    \( -name .git -o -name node_modules -o -name vendor -o -name dist -o -name build \
       -o -name coverage -o -name tmp -o -name test -o -name tests -o -name spec \
       -o -name __tests__ -o -name fixtures -o -name docs -o -name doc -o -name examples \
       -o -name '*mailer*' -o -name mail -o -name mails -o -name emails -o -name email \
       -o -name .github -o -name target -o -name engine -o -name third_party -o -name third-party \
       -o -name .rtfm -o -name '.rtfm-*' -o -name output \
       -o -path '*/assets/vendor' -o -path '*/public/vendor' -o -path '*/static/vendor' \) -prune -o \
    -type f \( -name '*.html' -o -name '*.htm' -o -name '*.erb' -o -name '*.haml' -o -name '*.slim' \
       -o -name '*.heex' -o -name '*.leex' -o -name '*.eex' -o -name '*.vue' -o -name '*.svelte' \
       -o -name '*.jsx' -o -name '*.tsx' -o -name '*.hbs' -o -name '*.handlebars' -o -name '*.ejs' \
       -o -name '*.pug' -o -name '*.twig' -o -name '*.blade.php' -o -name '*.jinja' -o -name '*.jinja2' \
       -o -name '*.j2' -o -name '*.cshtml' -o -name '*.razor' -o -name '*.liquid' -o -name '*.mustache' \
       -o -name '*.css' -o -name '*.scss' -o -name '*.sass' -o -name '*.less' -o -name '*.templ' \) \
    -print 2>/dev/null | head -50 | wc -l | tr -d ' ')

if [ "${UI_COUNT:-0}" -ge 3 ]; then
  finish web "$SOURCE" "${REASON:-UI sources present} (${UI_COUNT}+ template/markup/style files)"
fi

# ---------- Node CLI: a package.json bin with no frontend framework ----------
# classify_app_type.sh only recognises specific CLI frameworks (commander,
# yargs, oclif, ink); a hand-rolled Node CLI (process.argv, @clack/prompts, an
# MCP stdio server) has none of them. A declared executable with no frontend
# framework and no UI sources of its own (vendored engines/templates are
# pruned above) is a terminal tool.
if [ -f "$CODEBASE/package.json" ] && grep -Eq '"bin"[[:space:]]*:' "$CODEBASE/package.json" 2>/dev/null; then
  finish terminal auto "package.json declares a bin (a command-line executable) with no frontend framework dependency"
fi

if [ "$SOURCE" = "auto" ]; then
  finish none auto "web framework but no templates, styles or frontend framework — a server/API with no user-facing interface ($REASON)"
fi
finish none default "no interface signals: no app-type manifest, templates, styles or frontend framework — a library or service"
