#!/bin/bash
# compile_css.sh — Attempt to compile a project's CSS from source using its
# own build tools (tailwindcss, sass, postcss). Falls back to CDN download +
# synthesised theme overrides + Tailwind utility fallback if source compilation
# fails.
#
# Takes arbitrary project / output paths, so it runs the same way in a local
# checkout and in a container.
#
# Usage:
#   compile_css.sh <project_dir> <detection_json> <output_css_path>
#
# Exit codes:
#   0   — CSS produced (via source compilation, CDN, or fallback synthesis)
#         Method written to <output_css_path>.method.txt
#   1   — total failure (no CSS produced)

set -e

PROJECT_DIR="$1"
DETECT_JSON="$2"
OUTPUT_CSS="$3"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ -z "$PROJECT_DIR" ] || [ -z "$DETECT_JSON" ] || [ -z "$OUTPUT_CSS" ]; then
    echo "Usage: compile_css.sh <project_dir> <detection_json> <output_css_path>" >&2
    exit 1
fi
if [ ! -d "$PROJECT_DIR" ]; then
    echo "Error: project_dir does not exist: $PROJECT_DIR" >&2
    exit 1
fi
if [ ! -f "$DETECT_JSON" ]; then
    echo "Error: detection_json not found: $DETECT_JSON" >&2
    exit 1
fi

_timeout() {
    if command -v gtimeout &>/dev/null; then
        gtimeout "$@"
    elif command -v timeout &>/dev/null; then
        timeout "$@"
    else
        # No timeout command available — just run it
        shift
        "$@"
    fi
}

# Parse the detection JSON for the fields we need.
FRAMEWORK=$(node "$SCRIPT_DIR/json_get.js" "$DETECT_JSON" framework none 2>/dev/null || echo "none")
FRAMEWORK="${FRAMEWORK%%+*}"  # primary framework if hybrid
VERSION=$(node "$SCRIPT_DIR/json_get.js" "$DETECT_JSON" framework_version "" 2>/dev/null || echo "")
[ -n "$VERSION" ] || VERSION=$(node "$SCRIPT_DIR/json_get.js" "$DETECT_JSON" version "" 2>/dev/null || echo "")
SCSS_ENTRY=$(node "$SCRIPT_DIR/json_get.js" "$DETECT_JSON" scss_entry "" 2>/dev/null)
TW_ENTRY=$(node "$SCRIPT_DIR/json_get.js" "$DETECT_JSON" tailwind_entry "" 2>/dev/null)
TW_CONFIG=$(node "$SCRIPT_DIR/json_get.js" "$DETECT_JSON" tailwind_config "" 2>/dev/null)
POSTCSS_CONFIG=$(node "$SCRIPT_DIR/json_get.js" "$DETECT_JSON" postcss_config "" 2>/dev/null)

# Derive scss/tailwind entries from sources if not explicit. Includes
# bundler-pipeline entries (webpacker/shakapacker/vite put the @tailwind +
# custom @apply component layer in app/javascript or app/frontend, often as
# .scss) — these hold the project's own component classes (e.g. .base-input),
# so finding the real entry beats synthesizing a bare one that omits them.
if [ -z "$TW_ENTRY" ] && [ "$FRAMEWORK" = "tailwind" ]; then
    for candidate in \
        app/assets/tailwind/application.css \
        app/assets/tailwind/index.css \
        app/javascript/application.css \
        app/javascript/application.scss \
        app/javascript/packs/application.css \
        app/javascript/packs/application.scss \
        app/javascript/stylesheets/application.css \
        app/javascript/stylesheets/application.scss \
        app/frontend/entrypoints/application.css \
        app/frontend/entrypoints/application.scss \
        app/frontend/stylesheets/application.css \
        src/index.css \
        src/styles/globals.css \
        src/styles/main.css \
        styles/globals.css \
        styles/main.css \
        app/globals.css; do
        if [ -f "$PROJECT_DIR/$candidate" ]; then
            TW_ENTRY="$candidate"
            break
        fi
    done
fi

# Same fallback for SCSS — covers projects where detection JSON didn't capture
# the scss_entry (older detector runs, weird webpacker setups, etc.)
if [ -z "$SCSS_ENTRY" ]; then
    for candidate in \
        app/frontend/packs/application.scss \
        app/frontend/styling/application.scss \
        app/javascript/packs/application.scss \
        app/assets/stylesheets/application.scss \
        app/assets/stylesheets/application.sass \
        src/styles/main.scss \
        src/styles/application.scss \
        src/styles/globals.scss \
        src/main.scss \
        src/index.scss \
        styles/main.scss; do
        if [ -f "$PROJECT_DIR/$candidate" ]; then
            SCSS_ENTRY="$candidate"
            break
        fi
    done
fi

# Detect package manager
PKG_MGR="npm"
if [ -f "$PROJECT_DIR/yarn.lock" ] && command -v yarn &>/dev/null; then
    PKG_MGR="yarn"
elif [ -f "$PROJECT_DIR/pnpm-lock.yaml" ] && command -v pnpm &>/dev/null; then
    PKG_MGR="pnpm"
fi

COMPILE_METHOD="none"
> "$OUTPUT_CSS"

# ─── Helpers ─────────────────────────────────────────────────────────────────

# Many projects commit their fully-compiled stylesheet: tailwindcss-rails writes
# app/assets/builds/tailwind.css, cssbundling-rails writes app/assets/builds/*.css.
# That artifact is the real build the app actually ships — every utility the
# views use is already in it — so it's both more reliable than recompiling in the
# container (no npm/network/CLI-version roulette; tailwindcss-rails has no node
# tailwind dependency to compile against at all) and more faithful than the
# utility fallback. Prefer it whenever a non-trivial one exists.
try_prebuilt_css() {
    local f found="" size dir
    # Named build outputs across frameworks: Rails (tailwindcss-/cssbundling-rails),
    # Phoenix (priv/static/assets), Vite (dist/assets), esbuild/cssbundling (public).
    for f in app/assets/builds/tailwind.css \
             app/assets/builds/application.css \
             app/assets/builds/application.tailwind.css \
             priv/static/assets/app.css \
             priv/static/assets/css/app.css \
             public/assets/application.css \
             public/build/assets/app.css \
             dist/assets/index.css \
             dist/index.css; do
        if [ -f "$PROJECT_DIR/$f" ] && [ "$(wc -c < "$PROJECT_DIR/$f")" -gt 5000 ]; then
            found="$f"; break
        fi
    done
    # Otherwise take the largest non-vendor stylesheet in any known build dir
    # (handles hashed/non-standard names from cssbundling, Vite, Next, esbuild).
    if [ -z "$found" ]; then
        for dir in app/assets/builds priv/static/assets priv/static/assets/css \
                   dist/assets dist .next/static/css \
                   public/assets public/build public/build/assets public/css static/css; do
            [ -d "$PROJECT_DIR/$dir" ] || continue
            for f in "$PROJECT_DIR/$dir"/*.css; do
                [ -f "$f" ] || continue
                case "$(basename "$f")" in *vendor*|*chunk*|*runtime*) continue ;; esac
                [ "$(wc -c < "$f")" -gt 5000 ] || continue
                if [ -z "$found" ] || [ "$(wc -c < "$f")" -gt "$(wc -c < "$PROJECT_DIR/$found")" ]; then
                    found="${f#"$PROJECT_DIR"/}"
                fi
            done
        done
    fi
    [ -z "$found" ] && return 1

    size=$(wc -c < "$PROJECT_DIR/$found")
    echo "  Pre-built CSS: $found ($size bytes)" >&2
    cat "$PROJECT_DIR/$found" > "$OUTPUT_CSS"
    echo "" >> "$OUTPUT_CSS"
    COMPILE_METHOD="prebuilt"
    return 0
}

# Pick a Tailwind config to compile against. Real apps sometimes split Tailwind
# across several configs — a base holding theme/plugins (often with NO `content`)
# plus sibling configs that add the `content` globs (e.g. docuseal's
# tailwind.{application,form,dynamic}.config.js). Compiling the content-less base
# purges every utility, so prefer a config that declares a `content: [` array,
# favouring an app-wide one. Matches `content:[` specifically so theme keys like
# `base-content` don't false-positive. Echoes a repo-relative path; returns 1 if none.
pick_tw_config() {
    local c
    for c in "$TW_CONFIG" tailwind.application.config.js tailwind.config.js; do
        [ -n "$c" ] && [ -f "$PROJECT_DIR/$c" ] && \
            grep -qE 'content[[:space:]]*:[[:space:]]*\[' "$PROJECT_DIR/$c" && { echo "$c"; return 0; }
    done
    for c in "$PROJECT_DIR"/tailwind*.config.js; do
        [ -f "$c" ] && grep -qE 'content[[:space:]]*:[[:space:]]*\[' "$c" && { echo "${c#"$PROJECT_DIR"/}"; return 0; }
    done
    return 1
}

try_source_compile() {
    echo "  Source compile: $FRAMEWORK $VERSION" >&2

    if [ ! -f "$PROJECT_DIR/package.json" ]; then
        echo "  No package.json — skipping npm-based compilation" >&2
        return 1
    fi

    # Install if node_modules is missing
    if [ ! -d "$PROJECT_DIR/node_modules" ]; then
        echo "  Running $PKG_MGR install --ignore-scripts (may take a minute)..." >&2
        if ! ( cd "$PROJECT_DIR" && _timeout 180 $PKG_MGR install --ignore-scripts >/tmp/npm_out.log 2>&1 ); then
            echo "  $PKG_MGR install failed" >&2
            tail -10 /tmp/npm_out.log >&2
            return 1
        fi
        echo "  Install OK" >&2
    else
        echo "  node_modules already present — skipping install" >&2
    fi

    case "$FRAMEWORK" in
        tailwind)
            # Detect Tailwind major version (installed pkg first; @import in the
            # entry CSS as a v4 tell when the package isn't resolvable).
            local tw_ver tw_major
            tw_ver=$( ( cd "$PROJECT_DIR" && node -e "try{console.log(require('./node_modules/tailwindcss/package.json').version)}catch(e){}" 2>/dev/null ) || echo "")
            tw_major="${tw_ver%%.*}"
            if [ -z "$tw_major" ] && [ -n "$TW_ENTRY" ] && grep -q '@import.*tailwindcss' "$PROJECT_DIR/$TW_ENTRY" 2>/dev/null; then
                tw_major="4"
            fi

            # v4 is CSS-first and needs a real entry. Try it when one exists; on
            # miss, fall through to the v3 path (which can synthesize an entry).
            if [ "$tw_major" = "4" ] && [ -n "$TW_ENTRY" ] && [ -f "$PROJECT_DIR/$TW_ENTRY" ]; then
                echo "  Compiling Tailwind v4 ($tw_ver)..." >&2
                if ! ( cd "$PROJECT_DIR" && npm ls @tailwindcss/cli 2>/dev/null | grep -q '@tailwindcss/cli' ); then
                    ( cd "$PROJECT_DIR" && npm install --no-save @tailwindcss/cli >/dev/null 2>&1 || true )
                fi
                if ( cd "$PROJECT_DIR" && _timeout 180 npx @tailwindcss/cli -i "$TW_ENTRY" -o "$OUTPUT_CSS" >/tmp/compile_out.log 2>&1 ); then
                    COMPILE_METHOD="tailwind_v4"
                    return 0
                fi
                echo "  Tailwind v4 compile failed" >&2
                tail -5 /tmp/compile_out.log >&2
            fi

            # Tailwind v3 (or v4 fallthrough). Many real apps build CSS through a
            # bundler (shakapacker/webpack/esbuild) and ship NO standalone entry
            # CSS — the @tailwind directives live in the JS pipeline — and often
            # split Tailwind across multiple configs (base = theme/plugins,
            # siblings = `content` globs). When there's no usable entry, synthesize
            # one and compile against a config that declares content, so plugin
            # component layers (e.g. daisyUI `.btn`/`.input`) and the project theme
            # make it into the output instead of falling back to bare utilities.
            echo "  Compiling Tailwind v3..." >&2
            # Prefer a content-bearing config (handles multi-config setups where
            # the base config has no `content`); fall back to the detected one.
            local tw_input="$TW_ENTRY" tmp_input="" tw_cfg
            tw_cfg=$(pick_tw_config) || tw_cfg="$TW_CONFIG"
            if [ -z "$tw_input" ] || [ ! -f "$PROJECT_DIR/$tw_input" ]; then
                if [ -z "$tw_cfg" ]; then
                    echo "  No Tailwind entry file and no config with content globs" >&2
                    return 1
                fi
                tmp_input="${TMPDIR:-/tmp}/rtfm_tw_in_$$.css"
                printf '@tailwind base;\n@tailwind components;\n@tailwind utilities;\n' > "$tmp_input"
                tw_input="$tmp_input"
                echo "  No entry CSS — synthesised input; config=$tw_cfg" >&2
            else
                echo "  Entry CSS=$tw_input; config=${tw_cfg:-<default>}" >&2
            fi
            local tw_args=(-i "$tw_input" -o "$OUTPUT_CSS")
            if [ -n "$tw_cfg" ] && [ -f "$PROJECT_DIR/$tw_cfg" ]; then
                tw_args=(-c "$tw_cfg" "${tw_args[@]}")
            fi
            if ( cd "$PROJECT_DIR" && _timeout 180 npx tailwindcss "${tw_args[@]}" >/tmp/compile_out.log 2>&1 ); then
                [ -n "$tmp_input" ] && rm -f "$tmp_input"
                COMPILE_METHOD="tailwind_v3"
                return 0
            fi
            [ -n "$tmp_input" ] && rm -f "$tmp_input"
            echo "  Tailwind v3 compile failed" >&2
            tail -5 /tmp/compile_out.log >&2
            return 1
            ;;

        bootstrap|bulma|foundation|scss|webpixels)
            if [ -z "$SCSS_ENTRY" ] || [ ! -f "$PROJECT_DIR/$SCSS_ENTRY" ]; then
                echo "  No SCSS entry file" >&2
                return 1
            fi
            echo "  Compiling SCSS via npx sass..." >&2
            if ( cd "$PROJECT_DIR" && _timeout 180 npx sass "$SCSS_ENTRY" "$OUTPUT_CSS" \
                --load-path=node_modules --load-path=. \
                --no-source-map --style=expanded >/tmp/compile_out.log 2>&1 ); then
                COMPILE_METHOD="sass"
                return 0
            fi
            echo "  SCSS compile failed" >&2
            tail -5 /tmp/compile_out.log >&2
            return 1
            ;;

        postcss)
            local pc_entry="${TW_ENTRY:-${SCSS_ENTRY}}"
            if [ -z "$POSTCSS_CONFIG" ] || [ -z "$pc_entry" ] || [ ! -f "$PROJECT_DIR/$pc_entry" ]; then
                echo "  Missing PostCSS config or entry" >&2
                return 1
            fi
            echo "  Compiling via npx postcss..." >&2
            if ( cd "$PROJECT_DIR" && _timeout 180 npx postcss "$pc_entry" -o "$OUTPUT_CSS" \
                --config "$POSTCSS_CONFIG" >/tmp/compile_out.log 2>&1 ); then
                COMPILE_METHOD="postcss"
                return 0
            fi
            echo "  PostCSS compile failed" >&2
            tail -5 /tmp/compile_out.log >&2
            return 1
            ;;

        plain_css|custom)
            # Concatenate the project's listed CSS files
            local css_files
            css_files=$(node "$SCRIPT_DIR/json_get.js" "$DETECT_JSON" "css_files[]" "" 2>/dev/null)
            if [ -z "$css_files" ]; then
                return 1
            fi
            while IFS= read -r css_path; do
                [ -z "$css_path" ] && continue
                if [ -f "$PROJECT_DIR/$css_path" ]; then
                    echo "  Including: $css_path" >&2
                    cat "$PROJECT_DIR/$css_path" >> "$OUTPUT_CSS"
                    echo "" >> "$OUTPUT_CSS"
                fi
            done <<< "$css_files"
            if [ -s "$OUTPUT_CSS" ]; then
                COMPILE_METHOD="plain_css"
                return 0
            fi
            return 1
            ;;

        *)
            echo "  No source-compile strategy for: $FRAMEWORK" >&2
            return 1
            ;;
    esac
}

try_cdn_fallback() {
    echo "  Falling back to CDN + synthesised overrides..." >&2
    > "$OUTPUT_CSS"

    case "$FRAMEWORK" in
        bootstrap)
            local bs_ver="${VERSION:-5.3.0}"
            bs_ver=$(echo "$bs_ver" | sed 's/^[v^~]//')
            echo "  Fetching Bootstrap $bs_ver..." >&2
            curl -sL "https://cdn.jsdelivr.net/npm/bootstrap@${bs_ver}/dist/css/bootstrap.min.css" >> "$OUTPUT_CSS" 2>/dev/null || \
                curl -sL "https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" >> "$OUTPUT_CSS" 2>/dev/null || true
            echo "" >> "$OUTPUT_CSS"
            ;;
        webpixels)
            local wp_ver="${VERSION:-latest}"
            wp_ver=$(echo "$wp_ver" | sed 's/^[v^~]//')
            echo "  Fetching @webpixels/css $wp_ver..." >&2
            # Webpixels wraps Bootstrap — bundle both so the mockup gets Bootstrap reset + webpixels components
            curl -sL "https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" >> "$OUTPUT_CSS" 2>/dev/null || true
            echo "" >> "$OUTPUT_CSS"
            curl -sL "https://cdn.jsdelivr.net/npm/@webpixels/css@${wp_ver}/dist/index.css" >> "$OUTPUT_CSS" 2>/dev/null || true
            echo "" >> "$OUTPUT_CSS"
            ;;
        bulma)
            local bl_ver="${VERSION:-0.9.4}"
            bl_ver=$(echo "$bl_ver" | sed 's/^[v^~]//')
            echo "  Fetching Bulma $bl_ver..." >&2
            curl -sL "https://cdn.jsdelivr.net/npm/bulma@${bl_ver}/css/bulma.min.css" >> "$OUTPUT_CSS" 2>/dev/null || true
            echo "" >> "$OUTPUT_CSS"
            ;;
        foundation)
            local fd_ver="${VERSION:-6.8.1}"
            fd_ver=$(echo "$fd_ver" | sed 's/^[v^~]//')
            echo "  Fetching Foundation $fd_ver..." >&2
            curl -sL "https://cdn.jsdelivr.net/npm/foundation-sites@${fd_ver}/dist/css/foundation.min.css" >> "$OUTPUT_CSS" 2>/dev/null || true
            echo "" >> "$OUTPUT_CSS"
            ;;
        tailwind|custom|none)
            echo "  Generating Tailwind utility fallback..." >&2
            cat "$SCRIPT_DIR/../assets/tailwind-fallback.css" >> "$OUTPUT_CSS" 2>/dev/null
            echo "" >> "$OUTPUT_CSS"
            ;;
    esac

    # Generate theme overrides from detection JSON
    node "$SCRIPT_DIR/theme_overrides.js" "$DETECT_JSON" "$FRAMEWORK" >> "$OUTPUT_CSS" 2>/dev/null || true

    COMPILE_METHOD="fallback_synthesis"
}

# ─── Run ─────────────────────────────────────────────────────────────────────

if try_prebuilt_css; then
    echo "  Used committed pre-built CSS ($COMPILE_METHOD)" >&2
elif try_source_compile; then
    echo "  Source compile succeeded ($COMPILE_METHOD)" >&2
else
    try_cdn_fallback
    echo "  Used CDN fallback ($COMPILE_METHOD)" >&2
fi

# Append additional CDN links the project loads (FontAwesome, tippy, etc.)
EXTRA_CDN=$(node "$SCRIPT_DIR/json_get.js" "$DETECT_JSON" "cdn_links[]" "" 2>/dev/null)
if [ -n "$EXTRA_CDN" ]; then
    while IFS= read -r url; do
        [ -z "$url" ] || [ "$url" = "null" ] && continue
        echo "  Fetching CDN: $url" >&2
        curl -sL "$url" >> "$OUTPUT_CSS" 2>/dev/null || true
        echo "" >> "$OUTPUT_CSS"
    done <<< "$EXTRA_CDN"
fi

# Prepend font @imports (must be at the top per CSS spec)
FONT_LINKS=$(node "$SCRIPT_DIR/json_get.js" "$DETECT_JSON" "font_links[]" "" 2>/dev/null)
# Also support skill schema (google_fonts at top level)
if [ -z "$FONT_LINKS" ]; then
    FONT_LINKS=$(node "$SCRIPT_DIR/json_get.js" "$DETECT_JSON" "google_fonts[]" "" 2>/dev/null)
fi
if [ -n "$FONT_LINKS" ]; then
    FONT_IMPORTS=""
    while IFS= read -r url; do
        [ -z "$url" ] || [ "$url" = "null" ] && continue
        FONT_IMPORTS="${FONT_IMPORTS}@import url('${url}');\n"
    done <<< "$FONT_LINKS"
    if [ -n "$FONT_IMPORTS" ]; then
        TMP=$(mktemp)
        printf '%b\n' "$FONT_IMPORTS" > "$TMP"
        cat "$OUTPUT_CSS" >> "$TMP"
        mv "$TMP" "$OUTPUT_CSS"
    fi
fi

# Sanitize: strip un-compilable directives that may have leaked in
node "$SCRIPT_DIR/sanitize_css.js" "$OUTPUT_CSS" 2>&1 >&2 || true

# Record the method used
echo "$COMPILE_METHOD" > "${OUTPUT_CSS}.method.txt"

CSS_SIZE=$(wc -c < "$OUTPUT_CSS" 2>/dev/null || echo "0")
echo "  Output: $OUTPUT_CSS ($CSS_SIZE bytes, method=$COMPILE_METHOD)" >&2

[ -s "$OUTPUT_CSS" ] && exit 0 || exit 1
