#!/usr/bin/env bash
#
# Build a self-contained, ready-to-run zip of the ATEM probe.
#
#   bash package.sh           # -> dist/tallybot-atem-probe.zip
#
# Unzip it on any machine, then double-click run.cmd (Windows) or run ./run.sh. The zip
# includes a production node_modules, so the target needs no internet for dependencies
# (run.cmd still auto-installs Node itself if it's missing).
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

echo "==> staging files ..."
cp -r src package.json package-lock.json tsconfig.json run.cmd run.sh README.md "$STAGE"/

echo "==> installing production dependencies into the bundle ..."
# Prod-only (no typescript/@types) keeps the zip small. atem-connection's
# @julusian/freetype2 ships prebuilt binaries for every platform incl. win32-x64, so a
# node_modules built here still runs on Windows. run.cmd skips install when it's present.
( cd "$STAGE" && npm install --omit=dev --no-audit --no-fund --silent )

echo "==> zipping ..."
ZIP="$OUT/$NAME.zip"
rm -f "$ZIP"
( cd "$WORK" && zip -rq "$ZIP" "$NAME" )
rm -rf "$WORK"

echo "==> done."
ls -lh "$ZIP"
echo "    Copy $ZIP to the streaming PC, unzip, and double-click run.cmd."
