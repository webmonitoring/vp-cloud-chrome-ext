#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

VERSION="$(awk -F'"' '/"version"[[:space:]]*:/ { print $4; exit }' manifest.json)"
OUT_DIR="dist"
ZIP_PATH="${OUT_DIR}/vp-cloud-chrome-ext-${VERSION}.zip"

mkdir -p "$OUT_DIR"
rm -f "$ZIP_PATH"

zip -r "$ZIP_PATH" \
  manifest.json \
  background.js \
  popup.html popup.js popup.css \
  script_generator.html script_generator.js script_generator.css \
  lib

echo "Created ${ZIP_PATH}"
