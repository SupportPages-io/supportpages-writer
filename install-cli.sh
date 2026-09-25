#!/usr/bin/env bash
# Parse the complete function before doing work when downloaded through a pipe.
supportpages_install() {
set -euo pipefail

usage() {
  cat <<'EOF'
Install SupportPages Writer.

Usage: bash install-cli.sh [--yes] [--version VERSION] [--data-dir PATH] [--bin-dir PATH]
       bash install-cli.sh --archive /path/supportpages-VERSION-PLATFORM.tar.gz

From a source checkout, builds and installs locally using Node.js 22.12+ and npm.
Otherwise downloads a standalone release with Node.js and npm included.
--version or SUPPORTPAGES_CLI_RELEASE_URL selects a published release instead.

After installation, run supportpages init in your project. No account is needed to save
articles locally; supportpages publish hosts them on a help centre when you are ready.
EOF
}
sp_release_url="${SUPPORTPAGES_CLI_RELEASE_URL:-https://downloads.supportpages.io}"
sp_data_dir="${XDG_DATA_HOME:-$HOME/.local/share}/supportpages/cli"
sp_bin_dir="$HOME/.local/bin"
sp_version=""
sp_archive=""
sp_local=false
sp_yes=false
sp_update=false
sp_latest=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --yes) sp_yes=true; shift ;;
    --update) sp_update=true; shift ;;
    --version|--data-dir|--bin-dir|--archive)
      [ "$#" -ge 2 ] || { usage >&2; exit 2; }
      case "$1" in
        --version) sp_version="$2" ;;
        --data-dir) sp_data_dir="$2" ;;
        --bin-dir) sp_bin_dir="$2" ;;
        --archive) sp_archive="$2" ;;
      esac
      shift 2 ;;
    *) echo 'Invalid installer option. Run with --help.' >&2; exit 2 ;;
  esac
done
if [ "$sp_update" = true ] && [ -n "$sp_archive" ]; then echo '--update cannot be used with --archive.' >&2; exit 2; fi
case "$sp_release_url" in https://*) ;; *) echo 'The release URL must use HTTPS.' >&2; exit 1 ;; esac
sp_release_url="${sp_release_url%/}"
case "$(uname -s)" in Darwin) sp_os=darwin ;; Linux) sp_os=linux ;; *) echo 'SupportPages Writer supports macOS and Linux. On Windows, use WSL.' >&2; exit 1 ;; esac
case "$(uname -m)" in arm64|aarch64) sp_arch=arm64 ;; x86_64|amd64) sp_arch=x64 ;; *) echo 'Unsupported CPU architecture.' >&2; exit 1 ;; esac
for sp_tool in tar awk sed; do command -v "$sp_tool" >/dev/null || { echo "Missing $sp_tool." >&2; exit 1; }; done
if command -v sha256sum >/dev/null; then sp_hash=sha256sum
elif command -v shasum >/dev/null; then sp_hash=shasum
else echo 'A SHA-256 checker (shasum or sha256sum) is required.' >&2; exit 1; fi

umask 077
sp_tmp="$(mktemp -d "${TMPDIR:-/tmp}/supportpages-install.XXXXXX")"
sp_stage=""
sp_launcher_tmp=""
sp_lock=""
cleanup() { rm -rf -- "$sp_tmp"; if [ -n "$sp_launcher_tmp" ]; then rm -f -- "$sp_launcher_tmp"; fi; if [ -n "$sp_lock" ]; then rmdir "$sp_lock" 2>/dev/null || true; fi; if [ -n "$sp_stage" ]; then rm -rf -- "$sp_stage"; fi; }
trap cleanup EXIT
trap 'exit 130' INT TERM

# Resolve relative to the script, so this also works from outside the checkout.
# An explicit archive, version or release origin always wins over local source.
sp_source_root=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  sp_source_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
fi
if [ "$sp_update" = false ] && [ -z "$sp_archive" ] && [ -z "$sp_version" ] && [ -z "${SUPPORTPAGES_CLI_RELEASE_URL:-}" ] &&
   [ -n "$sp_source_root" ] && [ -f "$sp_source_root/src/index.ts" ] &&
   [ -f "$sp_source_root/package-lock.json" ] && [ -f "$sp_source_root/scripts/build-release.mjs" ]; then
  for sp_tool in node npm; do
    command -v "$sp_tool" >/dev/null || { echo "Building from this checkout requires $sp_tool. Install it and rerun this command." >&2; exit 1; }
  done
  if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || major === 22 && minor >= 12 ? 0 : 1)'; then
    echo 'Building from this checkout requires Node.js 22.12 or later.' >&2; exit 1
  fi
  echo 'Source checkout detected. Building SupportPages Writer for this machine...'
  node "$sp_source_root/scripts/build-release.mjs" --local --out "$sp_tmp/local" > "$sp_tmp/local-build"
  IFS= read -r sp_archive < "$sp_tmp/local-build"
  [ -n "$sp_archive" ] || { echo 'The local build did not produce an archive.' >&2; exit 1; }
  sp_local=true
fi

if [ -n "$sp_archive" ]; then
  [ -f "$sp_archive" ] && [ -f "$sp_archive.sha256" ] || { echo 'The archive and its .sha256 file are required.' >&2; exit 1; }
  sp_filename="$(basename -- "$sp_archive")"
  sp_version="${sp_filename#supportpages-}"
  sp_version="${sp_version%-$sp_os-$sp_arch.tar.gz}"
  cp -- "$sp_archive" "$sp_tmp/bundle.tar.gz"
  cp -- "$sp_archive.sha256" "$sp_tmp/checksum"
else
  command -v curl >/dev/null || { echo 'curl is required to download SupportPages Writer.' >&2; exit 1; }
  case "$sp_release_url" in https://*) ;; *) echo 'The release URL must use HTTPS.' >&2; exit 1 ;; esac
  if [ -z "$sp_version" ]; then
    sp_latest=true
    echo 'Checking the latest SupportPages Writer release…'
    sp_version="$(curl --proto '=https' --proto-redir '=https' -fsSL --max-time 60 "$sp_release_url/latest.txt")" || {
      echo 'Could not download the latest SupportPages Writer release. To install from source, run ./install-cli.sh directly inside your checkout.' >&2; exit 1;
    }
  fi
fi
if ! printf '%s\n' "$sp_version" | LC_ALL=C awk 'NR != 1 || $0 !~ /^[0-9]+\.[0-9]+\.[0-9]+$/ {bad=1} END {exit bad || NR != 1}'; then echo 'Invalid release version.' >&2; exit 1; fi
sp_filename="supportpages-$sp_version-$sp_os-$sp_arch.tar.gz"
if [ -z "$sp_archive" ]; then
  echo "Downloading SupportPages Writer $sp_version for $sp_os/${sp_arch}…"
  curl --proto '=https' --proto-redir '=https' -fsSL --max-time 600 "$sp_release_url/$sp_version/$sp_filename" -o "$sp_tmp/bundle.tar.gz" || { echo 'Download failed. Retry the installer; your existing installation was kept.' >&2; exit 1; }
  curl --proto '=https' --proto-redir '=https' -fsSL --max-time 60 "$sp_release_url/$sp_version/$sp_filename.sha256" -o "$sp_tmp/checksum" || { echo 'Could not download the checksum. Retry the installer; your existing installation was kept.' >&2; exit 1; }
fi
echo 'Verifying the release…'
sp_expected="$(awk 'NR==1 {print $1}' "$sp_tmp/checksum")"
if [ "$sp_hash" = shasum ]; then sp_actual="$(shasum -a 256 "$sp_tmp/bundle.tar.gz" | awk '{print $1}')"
else sp_actual="$(sha256sum "$sp_tmp/bundle.tar.gz" | awk '{print $1}')"; fi
[ "${#sp_expected}" -eq 64 ] && [ "$sp_actual" = "$sp_expected" ] || { echo 'Download verification failed. Your existing installation was kept.' >&2; exit 1; }

# Release archives contain ordinary files/directories only. Reject traversal,
# symlinks and hard links before extraction into a fresh private directory.
tar -tzf "$sp_tmp/bundle.tar.gz" > "$sp_tmp/names"
while IFS= read -r sp_entry; do
  case "$sp_entry" in supportpages|supportpages/|supportpages/*) ;; *) echo 'Invalid release archive path.' >&2; exit 1 ;; esac
  case "/$sp_entry/" in */../*|*/./*) echo 'Unsafe release archive path.' >&2; exit 1 ;; esac
done < "$sp_tmp/names"
tar -tvzf "$sp_tmp/bundle.tar.gz" > "$sp_tmp/types"
awk 'substr($0,1,1)!="-" && substr($0,1,1)!="d" {bad=1} END {exit bad}' "$sp_tmp/types" || { echo 'Unsafe release archive entry.' >&2; exit 1; }
for sp_dir in "$sp_data_dir" "$sp_bin_dir"; do
  [ ! -L "$sp_dir" ] || { echo 'Refusing an installation directory that is a symlink.' >&2; exit 1; }
  if [ -e "$sp_dir" ]; then [ -d "$sp_dir" ] && [ -O "$sp_dir" ] || { echo 'Installation directories must be owned by your user.' >&2; exit 1; }; fi
done
if [ -e "$sp_data_dir" ] && [ ! -f "$sp_data_dir/.supportpages-install" ]; then echo 'The installation directory is already used by something else.' >&2; exit 1; fi
mkdir -p -- "$sp_data_dir" "$sp_bin_dir"
sp_data_dir="$(cd -- "$sp_data_dir" && pwd -P)"
chmod 700 "$sp_data_dir"
sp_bin_dir="$(cd -- "$sp_bin_dir" && pwd -P)"
sp_launcher="$sp_bin_dir/supportpages"
if [ -e "$sp_launcher" ] || [ -L "$sp_launcher" ]; then
  if [ -L "$sp_launcher" ] || [ ! -f "$sp_launcher" ] || ! LC_ALL=C awk 'NR==2 && $0=="# SupportPages managed launcher" {ok=1} END {exit !ok}' "$sp_launcher"; then
    echo 'An unrelated supportpages command already exists. Choose another --bin-dir.' >&2; exit 1
  fi
fi
printf '%s\n' 'SupportPages CLI installation v1' > "$sp_data_dir/.supportpages-install"
if ! mkdir "$sp_data_dir/.install.lock" 2>/dev/null; then echo 'Another installer is running. Retry when it finishes.' >&2; exit 1; fi
sp_lock="$sp_data_dir/.install.lock"
if [ -e "$sp_data_dir/current" ] && [ ! -L "$sp_data_dir/current" ]; then echo 'Refusing to replace an unrelated current entry.' >&2; exit 1; fi
if { [ "$sp_update" = true ] || [ "$sp_latest" = true ]; } && [ -x "$sp_data_dir/current/runtime/bin/node" ]; then
  # Recheck while holding the lock: another update may have finished downloading first.
  sp_current="$("$sp_data_dir/current/runtime/bin/node" "$sp_data_dir/current/mcp/scripts/cli.mjs" --version)"
  if ! "$sp_data_dir/current/runtime/bin/node" -e '
    const [current, next] = process.argv.slice(1).map(v => v.split(".").map(BigInt));
    for (let i = 0; i < 3; i++) { if (current[i] !== next[i]) process.exit(current[i] > next[i] ? 1 : 0); }
  ' "$sp_current" "$sp_version"; then
    echo "SupportPages Writer $sp_current is newer than the available release. No update needed."
    exit 0
  fi
fi
echo 'Installing SupportPages Writer…'
sp_stage="$(mktemp -d "$sp_data_dir/.stage.XXXXXX")"
tar -xzf "$sp_tmp/bundle.tar.gz" -C "$sp_stage"
sp_package="$sp_stage/supportpages"
[ -x "$sp_package/runtime/bin/node" ] && [ -f "$sp_package/mcp/scripts/cli.mjs" ] || { echo 'Incomplete release archive.' >&2; exit 1; }
sp_probe="$("$sp_package/runtime/bin/node" "$sp_package/mcp/scripts/cli.mjs" --version)"
[ "$sp_probe" = "$sp_version" ] || { echo 'The release cannot run on this machine.' >&2; exit 1; }
if [ -f "$sp_package/mcp/scripts/check-runtime.mjs" ]; then
  "$sp_package/runtime/bin/node" "$sp_package/mcp/scripts/check-runtime.mjs" || { echo 'The bundled tools cannot run on this machine. Your existing installation was kept.' >&2; exit 1; }
fi
mkdir -p -- "$sp_data_dir/versions"
sp_target_name="$sp_version-$sp_os-$sp_arch"
# Development builds can change without a package-version bump. Keep each build
# separate while retaining immutable version directories for published releases.
if [ "$sp_local" = true ]; then sp_target_name="$sp_target_name-local-$sp_expected"; fi
sp_target="$sp_data_dir/versions/$sp_target_name"
# Immutable release directories: an identical version reuses the installed copy.
if [ -e "$sp_target" ] || [ -L "$sp_target" ]; then
  [ -d "$sp_target" ] && [ ! -L "$sp_target" ] && [ -f "$sp_target/.release-sha256" ] && [ "$(cat "$sp_target/.release-sha256")" = "$sp_expected" ] || { echo 'This version already exists with different contents.' >&2; exit 1; }
else
  printf '%s\n' "$sp_expected" > "$sp_package/.release-sha256"
  mv -- "$sp_package" "$sp_target"
fi
if [ "$sp_update" = true ] && [ -f "$sp_target/mcp/scripts/prepare-update.mjs" ]; then
  echo 'Preparing updated article tools…'
  "$sp_target/runtime/bin/node" "$sp_target/mcp/scripts/prepare-update.mjs" "$sp_data_dir/current/mcp"
fi
sp_marker="$sp_data_dir/.supportpages-install"
printf '%s\n' 'SupportPages CLI installation v1' > "$sp_marker"
sp_quoted_root="$(printf '%s' "$sp_data_dir" | sed "s/'/'\\\\''/g")"
{
  printf '%s\n' '#!/bin/sh' '# SupportPages managed launcher'
  printf "sp_root='%s'\n" "$sp_quoted_root"
  printf '%s\n' 'export SUPPORTPAGES_CLI_HOME="$sp_root/current"' 'export PATH="$sp_root/current/runtime/bin:$PATH"' 'exec "$sp_root/current/runtime/bin/node" "$sp_root/current/mcp/scripts/cli.mjs" "$@"'
} > "$sp_stage/launcher"
chmod 755 "$sp_stage/launcher"
# Atomic launcher replacement on its own filesystem.
sp_launcher_tmp="$(mktemp "$sp_bin_dir/.supportpages.XXXXXX")"
cp "$sp_stage/launcher" "$sp_launcher_tmp"
chmod 755 "$sp_launcher_tmp"
ln -s "versions/$sp_target_name" "$sp_stage/current"
# Prepare the receipt before replacing anything in the active installation.
"$sp_target/runtime/bin/node" -e '
  const fs = require("fs");
  const [file, data_dir, bin_dir, release_url, local] = process.argv.slice(1);
  fs.writeFileSync(file, JSON.stringify({version: 1, type: local === "true" ? "local" : "release", data_dir, bin_dir, release_url}) + "\n", {mode: 0o600});
' "$sp_stage/install.json" "$sp_data_dir" "$sp_bin_dir" "$sp_release_url" "$sp_local"
# The launcher always uses current; replacing it first keeps the old version usable
# if promotion fails. Node rename replaces the pointer on both macOS and Linux.
mv -f -- "$sp_launcher_tmp" "$sp_launcher"
mv -f -- "$sp_stage/install.json" "$sp_data_dir/install.json"
"$sp_target/runtime/bin/node" -e 'require("fs").renameSync(process.argv[1],process.argv[2])' "$sp_stage/current" "$sp_data_dir/current"
# PATH advice is kept for the finish screen, which clears the terminal first.
sp_path_note=""
case ":${PATH:-}:" in
  *":$sp_bin_dir:"*) ;;
  *)
    sp_quoted_bin="$(printf '%s' "$sp_bin_dir" | sed "s/'/'\\\\''/g")"
    sp_path_line="export PATH='$sp_quoted_bin':\$PATH"
    sp_profile=""
    case "${SHELL:-}" in */zsh) sp_profile="${ZDOTDIR:-$HOME}/.zshrc" ;; */bash) if [ "$sp_os" = darwin ]; then sp_profile="$HOME/.bash_profile"; else sp_profile="$HOME/.bashrc"; fi ;; esac
    sp_path_saved=false
    if [ -n "$sp_profile" ] && [ -f "$sp_profile" ] && SP_PATH_LINE="$sp_path_line" awk '$0 == ENVIRON["SP_PATH_LINE"] {found=1} END {exit !found}' "$sp_profile"; then
      sp_path_saved=true
    elif [ "$sp_yes" = false ] && [ -n "$sp_profile" ] && { exec 3<>/dev/tty; } 2>/dev/null; then
      printf 'Add supportpages to your shell PATH? [Y/n]: ' >&3
      IFS= read -r sp_answer <&3 || sp_answer=n
      case "$sp_answer" in ''|y|Y|yes|YES)
        if [ -L "$sp_profile" ]; then echo 'Shell config is a symlink; add the PATH line below manually.'
        elif printf '\n# SupportPages Writer\n%s\n' "$sp_path_line" >> "$sp_profile"; then sp_path_saved=true
        else echo 'Could not change shell configuration; add the PATH line below manually.'; fi ;;
      esac
    fi
    if [ "$sp_path_saved" = true ]; then
      sp_path_note="$(printf 'Open a new terminal, or run:\n  %s' "$sp_path_line")"
    else
      sp_path_note="$(printf 'For this terminal, run:\n  %s' "$sp_path_line")"
    fi ;;
esac
if [ "$sp_update" = true ]; then
  printf '\nSupportPages Writer %s installed.\n' "$sp_version"
  if [ -n "$sp_path_note" ]; then printf '\n%s\n' "$sp_path_note"; fi
  printf '\nRestart running coding-agent sessions to use the updated integration.\n'
  return 0
fi
# A fresh install ends on a clean screen: the logo, then how to get started.
# Piped or plain output (and NO_COLOR) gets the same text without clearing or colour.
sp_screen=false
sp_bold=""; sp_cmd=""; sp_dim=""; sp_reset=""
if [ -t 1 ] && [ "${TERM:-dumb}" != dumb ]; then
  sp_screen=true
  if [ -z "${NO_COLOR+x}" ]; then sp_bold=$'\033[1m'; sp_cmd=$'\033[1;36m'; sp_dim=$'\033[90m'; sp_reset=$'\033[0m'; fi
fi
if [ "$sp_screen" = true ]; then
  printf '\033[H\033[2J'
  if [ "$(tput cols 2>/dev/null || echo 80)" -gt 59 ]; then
    # figlet "Pagga" (see scripts/lib/terminal.mjs); the ░ texture and ".io" are dimmed.
    for sp_row in \
      '░█▀▀░█░█░█▀█░█▀█░█▀█░█▀▄░▀█▀░█▀█░█▀█░█▀▀░█▀▀░█▀▀|░░░░▀█▀░█▀█' \
      '░▀▀█░█░█░█▀▀░█▀▀░█░█░█▀▄░░█░░█▀▀░█▀█░█░█░█▀▀░▀▀█|░░░░░█░░█░█' \
      '░▀▀▀░▀▀▀░▀░░░▀░░░▀▀▀░▀░▀░░▀░░▀░░░▀░▀░▀▀▀░▀▀▀░▀▀▀|░▀░░▀▀▀░▀▀▀'; do
      sp_mark="${sp_row%%|*}"
      printf '%s%s%s%s\n' "${sp_mark//░/${sp_dim}░${sp_reset}}" "$sp_dim" "${sp_row#*|}" "$sp_reset"
    done
    printf '\n'
  fi
fi
printf '%sSupportPages Writer %s installed.%s\n' "$sp_bold" "$sp_version" "$sp_reset"
if [ -n "$sp_path_note" ]; then printf '\n%s\n' "$sp_path_note"; fi
printf '\n%sGet started%s\n\n' "$sp_bold" "$sp_reset"
printf '  1. Set up this computer, once       %ssupportpages setup%s\n' "$sp_cmd" "$sp_reset"
printf '  2. Then, in each project folder    %ssupportpages init%s\n' "$sp_cmd" "$sp_reset"
printf '  3. Open Claude Code or Codex in the project and ask for an article:\n'
printf '     %s"Write an illustrated guide to inviting a teammate."%s\n' "$sp_dim" "$sp_reset"
printf '\nArticles are saved in your project, with no account needed. Run %ssupportpages publish%s\n' "$sp_cmd" "$sp_reset"
printf 'later to host them on a SupportPages.io help centre.\n\n'
}

supportpages_install "$@"
