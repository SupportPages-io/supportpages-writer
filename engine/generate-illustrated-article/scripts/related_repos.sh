#!/usr/bin/env bash
# List the sibling repositories of a multi-repo product.
#
# RTFM checks every repository of a multi-repo project out side by side under
# $RTFM_REPOS_ROOT and runs the skill from one of them (the anchor,
# $RTFM_WORKSPACE, default cwd). The siblings are extra source to read, never a
# place to write. Prints one line per sibling, relative to the anchor:
#
#   ../<dir>        (or)        ../<dir>	<role>	<surface>
#
# The role and surface come from $RTFM_REPO_RELATIONSHIPS
# (repository_relationships.json, `repositories[].directory` / `.role` /
# `.surface`) when that file exists; either may be empty. surface is the
# repository's interface (web, terminal, mobile, … or none for an API/library). Prints nothing
# when RTFM_REPOS_ROOT is unset or holds no other checkout — single-repo runs
# are unchanged. Always exits 0. bash 3.2 / macOS + Linux.

root="${RTFM_REPOS_ROOT:-}"
[ -n "$root" ] && [ -d "$root" ] || exit 0

anchor=$(cd "${RTFM_WORKSPACE:-.}" 2>/dev/null && pwd -P) || exit 0
root=$(cd "$root" && pwd -P) || exit 0
rels="${RTFM_REPO_RELATIONSHIPS:-}"

meta_for() {
  [ -n "$rels" ] && [ -f "$rels" ] || return 0
  command -v node >/dev/null 2>&1 || return 0
  node -e '
    try {
      const data = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const repo = (data.repositories || []).find(r => r && r.directory === process.argv[2]);
      if (!repo) process.exit(0);
      const clean = v => (v == null ? "" : String(v).replace(/\s+/g, " ").trim());
      if (repo.role || repo.surface) process.stdout.write(clean(repo.role) + "\t" + clean(repo.surface));
    } catch (e) {}
  ' "$rels" "$1" 2>/dev/null
}

for dir in "$root"/*/; do
  dir="${dir%/}"
  [ -d "$dir/.git" ] || continue
  real=$(cd "$dir" && pwd -P) || continue
  [ "$real" = "$anchor" ] && continue
  name=$(basename "$real")
  meta=$(meta_for "$name")
  if [ -n "$meta" ]; then
    printf '../%s\t%s\n' "$name" "$meta"
  else
    printf '../%s\n' "$name"
  fi
done
exit 0
