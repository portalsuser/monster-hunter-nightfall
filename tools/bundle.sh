#!/usr/bin/env bash
# Produces dist/monster-hunter-nightfall.zip — the artifact you upload to
# Portals. Vendors three.js first so the published bundle has no external
# runtime dependency.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ ! -f vendor/three.module.js ]]; then
  echo "three.js is not vendored yet — fetching it first."
  bash tools/vendor-three.sh
fi

rm -rf dist
mkdir -p dist/build

# _portals/ is intentionally excluded: Portals injects its own managed sdk.js.
cp -R index.html styles.css src vendor dist/build/

( cd dist/build && zip -qr "../monster-hunter-nightfall.zip" . )
rm -rf dist/build

echo "✔ dist/monster-hunter-nightfall.zip"
echo "  Upload this to Portals. It injects _portals/sdk.js during processing."
