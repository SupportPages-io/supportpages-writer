#!/bin/bash
# run_css_build.sh — run an LLM-supplied CSS build command with a timeout, then
# validate the expected output CSS was produced. detect-project STEP 3 uses this to
# run a project-specific compile it discovered — a Tailwind v4 CLI invocation with
# `--content` globs, a project's own `mix assets.build` / `npm run build:css`, etc.
# — without each run reinventing timeout + validation. The mechanics are
# deterministic; the LLM supplies the command (and templates the output path into it).
#
# Usage:  run_css_build.sh <project_dir> <output_css> <timeout_secs> -- <command...>
#         The <command...> is expected to write CSS to <output_css> (e.g. `... -o <output_css>`).
# Exit:   0 if <output_css> exists and is non-trivial (>2KB); 1 otherwise.

set -u

PROJECT_DIR="$1"; OUTPUT_CSS="$2"; TIMEOUT="${3:-180}"; shift 3
[ "${1:-}" = "--" ] && shift

_timeout() {
    if command -v gtimeout &>/dev/null; then gtimeout "$@";
    elif command -v timeout &>/dev/null; then timeout "$@";
    else shift; "$@"; fi
}

if [ ! -d "$PROJECT_DIR" ]; then echo "  run_css_build: project_dir not found: $PROJECT_DIR" >&2; exit 1; fi
if [ "$#" -eq 0 ]; then echo "  run_css_build: no command given" >&2; exit 1; fi

echo "  run_css_build: (cwd=$PROJECT_DIR, timeout ${TIMEOUT}s) $*" >&2
( cd "$PROJECT_DIR" && _timeout "$TIMEOUT" "$@" ) >/tmp/css_build.log 2>&1
rc=$?
if [ "$rc" -ne 0 ]; then
    echo "  build command exited $rc" >&2
    tail -12 /tmp/css_build.log >&2
fi

if [ -f "$OUTPUT_CSS" ] && [ "$(wc -c < "$OUTPUT_CSS" 2>/dev/null || echo 0)" -gt 2000 ]; then
    echo "  build OK: $OUTPUT_CSS ($(wc -c < "$OUTPUT_CSS") bytes)" >&2
    exit 0
fi
echo "  build produced no usable CSS at $OUTPUT_CSS" >&2
exit 1
