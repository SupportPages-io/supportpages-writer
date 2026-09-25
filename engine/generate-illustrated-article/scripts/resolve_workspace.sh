#!/usr/bin/env bash
# Recover the project workspace when a shell tool starts in a non-project
# directory (Antigravity scratch, $HOME, …). The CLI process was launched in
# the target repo — walk parent pids until we find a directory that looks like
# a project (.git or .rtfm). No project-specific paths.
#
# Prefer $RTFM_WORKSPACE when the harness already set it.
# Prints one absolute path to stdout. Always exits 0.
# bash 3.2 / macOS + Linux.

if [ -n "$RTFM_WORKSPACE" ] && [ -d "$RTFM_WORKSPACE" ]; then
  (cd "$RTFM_WORKSPACE" && pwd -P)
  exit 0
fi

scratch_default="${HOME}/.gemini/antigravity-cli/scratch"
here=$(pwd -P 2>/dev/null || pwd)
home_real=$(cd "$HOME" && pwd -P 2>/dev/null || true)

is_scratch() {
  local p="$1" s
  [ -n "$p" ] || return 1
  [ -d "$scratch_default" ] || return 1
  s=$(cd "$scratch_default" && pwd -P 2>/dev/null) || return 1
  [ "$p" = "$s" ]
}

is_home() {
  [ -n "$home_real" ] && [ "$1" = "$home_real" ]
}

looks_like_project() {
  [ -d "$1/.git" ] || [ -d "$1/.rtfm" ]
}

is_untrusted() {
  is_scratch "$1" && return 0
  is_home "$1" && return 0
  looks_like_project "$1" && return 1
  return 0
}

pid_cwd() {
  local pid="$1" cand=""
  [ -n "$pid" ] || return 1
  [ "$pid" -gt 1 ] 2>/dev/null || return 1
  if command -v lsof >/dev/null 2>&1; then
    cand=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | awk '/^n\// {print substr($0,2); exit}')
  fi
  if [ -z "$cand" ] && [ -L "/proc/$pid/cwd" ]; then
    cand=$(readlink "/proc/$pid/cwd" 2>/dev/null || true)
  fi
  [ -n "$cand" ] && [ -d "$cand" ] || return 1
  (cd "$cand" && pwd -P)
}

if ! is_untrusted "$here"; then
  printf '%s\n' "$here"
  exit 0
fi

pid=${PPID:-$$}
i=0
found=""
while [ "$i" -lt 12 ]; do
  cand=$(pid_cwd "$pid" || true)
  if [ -n "$cand" ] && ! is_untrusted "$cand"; then
    printf '%s\n' "$cand"
    exit 0
  fi
  if [ -z "$found" ] && [ -n "$cand" ] && ! is_scratch "$cand" && ! is_home "$cand"; then
    found=$cand
  fi
  next=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
  [ -n "$next" ] && [ "$next" != "$pid" ] && [ "$next" -gt 1 ] 2>/dev/null || break
  pid=$next
  i=$((i + 1))
done

if [ -n "$found" ]; then
  printf '%s\n' "$found"
  exit 0
fi

printf '%s\n' "$here"
exit 0
