#!/usr/bin/env bash
# TallyBot ATEM Probe — launcher for macOS / Linux (the Windows equivalent is run.cmd).
# Checks Node, installs deps on first run, then starts the probe.
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install the LTS from https://nodejs.org/ and re-run."
  exit 1
fi
echo "Node.js $(node --version) found."

if [ ! -d node_modules ]; then
  echo "First run: installing dependencies..."
  npm install
fi

# Newer Node strips TypeScript types by default; older Node needs the flag. Use it
# only if it's accepted, so this works across Node versions.
STRIP=""
if node --experimental-strip-types -e "0" >/dev/null 2>&1; then
  STRIP="--experimental-strip-types"
fi

echo "Starting the probe at http://127.0.0.1:4848 — Ctrl+C to stop."
exec node $STRIP src/main.ts
