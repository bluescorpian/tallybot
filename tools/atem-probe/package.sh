#!/usr/bin/env bash
#
# Build a source zip of the ATEM probe to carry to another machine.
#
#   bash package.sh           # -> dist/tallybot-atem-probe.zip
#
# The zip is just the source (no node_modules). On the target, double-click run.cmd
# (Windows) or run ./run.sh: it installs Node if missing, then runs `npm install` on
# first launch — so the target needs internet once to fetch dependencies.
set -euo pipefail
cd "$(dirname "$0")"

command -v zip >/dev/null 2>&1 || {
  echo "This script needs 'zip'. On NixOS:  nix shell nixpkgs#zip -c bash $0" >&2
  exit 1
}

NAME=tallybot-atem-probe
WORK="$(mktemp -d)"
STAGE="$WORK/$NAME"
OUT="$PWD/dist"
mkdir -p "$STAGE" "$OUT"

echo "==> staging source files ..."
# Source only — node_modules is intentionally excluded; run.cmd / run.sh install it.
cp -r src package.json package-lock.json tsconfig.json run.cmd run.sh README.md "$STAGE"/

echo "==> zipping ..."
ZIP="$OUT/$NAME.zip"
rm -f "$ZIP"
( cd "$WORK" && zip -rq "$ZIP" "$NAME" )
rm -rf "$WORK"

echo "==> done."
ls -lh "$ZIP"
echo "    Copy $ZIP to the streaming PC, unzip, and double-click run.cmd."
