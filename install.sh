#!/usr/bin/env bash
# Install (or update) the PR Open VSCode extension.
# By default, downloads the VSIX from the latest GitHub release (correctly
# versioned by CI). Pass --source to build and package from local source instead.
# Usage: ./install.sh [--editor code|cursor|code-insiders] [--source]
set -euo pipefail

editor_cli=""
requested_editor=""
from_source=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --editor) editor_cli="${2:-}"; requested_editor="${2:-}"; shift 2 ;;
    --source) from_source=true; shift ;;
    -h|--help)
      echo "Usage: $0 [--editor code|cursor|code-insiders] [--source]"
      exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ext_dir="$script_dir/vscode-extension"

# Resolve an editor name (or path) to a runnable CLI: prefer PATH, fall back to
# the CLI bundled inside the macOS app so it works without the shell command
# installed. Prints the resolved command on success.
resolve_editor() {
  local name="$1"
  if command -v "$name" >/dev/null 2>&1; then echo "$name"; return 0; fi
  local app bin
  case "$name" in
    code) app="Visual Studio Code"; bin="code" ;;
    cursor) app="Cursor"; bin="cursor" ;;
    code-insiders) app="Visual Studio Code - Insiders"; bin="code-insiders" ;;
    *) return 1 ;;
  esac
  for prefix in "/Applications" "$HOME/Applications"; do
    local candidate="$prefix/$app.app/Contents/Resources/app/bin/$bin"
    if [[ -x "$candidate" ]]; then echo "$candidate"; return 0; fi
  done
  return 1
}

# Pick the editor CLI: explicit flag, else first available.
if [[ -n "$editor_cli" ]]; then
  editor_cli="$(resolve_editor "$editor_cli")" || { echo "error: editor CLI '$requested_editor' not found on PATH or in the standard app locations" >&2; exit 1; }
else
  for candidate in code cursor code-insiders; do
    if resolved="$(resolve_editor "$candidate")"; then editor_cli="$resolved"; break; fi
  done
  [[ -n "$editor_cli" ]] || { echo "error: no editor CLI found (looked for code, cursor, code-insiders on PATH and in /Applications). Install the shell command or pass --editor." >&2; exit 1; }
fi

cleanup_files=()
cleanup() { [[ ${#cleanup_files[@]} -gt 0 ]] && rm -rf "${cleanup_files[@]}"; }
trap cleanup EXIT

if [[ "$from_source" == true ]]; then
  for cmd in node npm; do
    command -v "$cmd" >/dev/null 2>&1 || { echo "error: '$cmd' not found on PATH" >&2; exit 1; }
  done

  echo "==> Installing dependencies"
  npm --prefix "$ext_dir" install

  version="$(node -p "require('$ext_dir/package.json').version")"
  vsix="$ext_dir/pr-open-$version.vsix"
  cleanup_files+=("$vsix")

  # vsce package runs vscode:prepublish (npm run compile), so no separate compile step.
  echo "==> Packaging pr-open-$version.vsix"
  ( cd "$ext_dir" && npx --yes @vscode/vsce package --out "$vsix" )
else
  command -v gh >/dev/null 2>&1 || { echo "error: 'gh' not found on PATH (needed to download the release; or run with --source)" >&2; exit 1; }

  # gh resolves owner/repo from the checkout's origin remote — no hand-rolled URL parsing.
  repo="$(cd "$script_dir" && gh repo view --json nameWithOwner -q .nameWithOwner)"
  [[ -n "$repo" ]] || { echo "error: could not resolve the GitHub repo (run inside the pr-open checkout)" >&2; exit 1; }
  tag="$(gh release view --repo "$repo" --json tagName -q .tagName)"
  [[ -n "$tag" ]] || { echo "error: no published release found for $repo" >&2; exit 1; }

  tmp_dir="$(mktemp -d)"
  cleanup_files+=("$tmp_dir")
  echo "==> Downloading PR Open $tag VSIX from $repo"
  gh release download "$tag" --repo "$repo" --pattern '*.vsix' --dir "$tmp_dir"
  shopt -s nullglob
  vsix_files=("$tmp_dir"/*.vsix)
  shopt -u nullglob
  [[ ${#vsix_files[@]} -gt 0 ]] || { echo "error: release $tag has no .vsix asset (build one with --source)" >&2; exit 1; }
  vsix="${vsix_files[0]}"
  version="$tag"
fi

echo "==> Installing into '$editor_cli'"
"$editor_cli" --install-extension "$vsix" --force

echo "Done. Reload $editor_cli (Cmd+Shift+P -> 'Developer: Reload Window') to activate PR Open $version."
