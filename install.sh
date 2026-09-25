#!/usr/bin/env bash
set -euo pipefail

# A small, dependency-free bootstrap. The Node wizard handles the actual setup.
if ! command -v node >/dev/null 2>&1; then
  echo 'SupportPages Writer needs Node.js 22.12 or later. Install it from https://nodejs.org, then rerun ./install.sh.' >&2
  exit 1
fi
if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || major === 22 && minor >= 12 ? 0 : 1)'; then
  echo 'Please upgrade to Node.js 22.12 or later, then rerun ./install.sh.' >&2
  exit 1
fi
installer_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec node "$installer_root/scripts/install.mjs" "$@"
