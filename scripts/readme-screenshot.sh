#!/usr/bin/env bash
# Regenerates docs/assets/screenshot.png, the README hero image.
#
# Serves the frontend in a plain browser (no Tauri, so the page uses its demo data),
# loads the `?demo=hero` preset (one light per input, nothing unassigned), captures it
# with headless Chrome/Chromium, then rounds the corners into the PNG's alpha channel.
# GitHub strips CSS from READMEs, so the rounding has to live in the image itself.
#
# Needs: pnpm deps installed in app/, a Chrome or Chromium binary, ImageMagick (`magick`).
# Usage: scripts/readme-screenshot.sh
set -euo pipefail

cd "$(dirname "$0")/.."
OUT=docs/assets/screenshot.png
WIDTH=500   # tight around the board's 4-input row: even margins, no empty tail
HEIGHT=620
RADIUS=18
PORT=5199

CHROME=$(command -v chromium || command -v chromium-browser || command -v google-chrome || true)
[[ -n $CHROME ]] || { echo "error: no chromium or google-chrome on PATH" >&2; exit 1; }
command -v magick >/dev/null || { echo "error: ImageMagick (magick) not on PATH" >&2; exit 1; }

TMP=$(mktemp -d)
(cd app && exec pnpm exec vite dev --port "$PORT" --strictPort) >"$TMP/vite.log" 2>&1 &
VITE=$!
trap 'kill "$VITE" 2>/dev/null || true; rm -rf "$TMP"' EXIT

for _ in $(seq 60); do
  curl -sf "http://localhost:$PORT/" >/dev/null && break
  sleep 0.5
done
curl -sf "http://localhost:$PORT/" >/dev/null || { cat "$TMP/vite.log" >&2; exit 1; }

"$CHROME" --headless=new --disable-gpu --hide-scrollbars --user-data-dir="$TMP/profile" \
  --force-device-scale-factor=1 --window-size="$WIDTH,$HEIGHT" \
  --virtual-time-budget=5000 --screenshot="$TMP/raw.png" \
  "http://localhost:$PORT/?demo=hero" >/dev/null 2>&1

# Build an alpha mask with one rounded corner, mirror it onto all four, apply it.
magick "$TMP/raw.png" \
  \( +clone -alpha extract \
     -draw "fill black polygon 0,0 0,$RADIUS $RADIUS,0 fill white circle $RADIUS,$RADIUS $RADIUS,0" \
     \( +clone -flip \) -compose Multiply -composite \
     \( +clone -flop \) -compose Multiply -composite \) \
  -alpha off -compose CopyOpacity -composite "$OUT"

echo "wrote $OUT"
