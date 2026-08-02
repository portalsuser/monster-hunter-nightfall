#!/usr/bin/env bash
# Vendors the three.js ES module build into vendor/three.module.js.
#
# index.html prefers the local copy and falls back to a CDN when it is missing,
# so this is optional for development — but you want it before publishing to
# Portals so the bundle has no external runtime dependency.
set -euo pipefail

VERSION="${THREE_VERSION:-0.169.0}"
DEST="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/vendor"
OUT="$DEST/three.module.js"

mkdir -p "$DEST"

SOURCES=(
  "https://unpkg.com/three@${VERSION}/build/three.module.js"
  "https://cdn.jsdelivr.net/npm/three@${VERSION}/build/three.module.js"
  "https://registry.npmjs.org/three/-/three-${VERSION}.tgz"
)

echo "Vendoring three.js ${VERSION} -> vendor/three.module.js"

for src in "${SOURCES[@]}"; do
  echo "  trying ${src%%\?*}"
  if [[ "$src" == *.tgz ]]; then
    tmp="$(mktemp -d)"
    if curl -fsSL "$src" -o "$tmp/three.tgz" 2>/dev/null \
       && tar -xzf "$tmp/three.tgz" -C "$tmp" package/build/three.module.js 2>/dev/null; then
      mv "$tmp/package/build/three.module.js" "$OUT"
      rm -rf "$tmp"
    else
      rm -rf "$tmp"
      continue
    fi
  else
    curl -fsSL "$src" -o "$OUT" 2>/dev/null || continue
  fi

  # Sanity check: the real build is ~1 MB and exports a REVISION constant.
  if [[ -s "$OUT" ]] && grep -q "REVISION" "$OUT"; then
    size=$(wc -c < "$OUT" | tr -d ' ')
    echo "  ✔ wrote vendor/three.module.js (${size} bytes)"
    exit 0
  fi
  rm -f "$OUT"
done

echo "  ✘ could not fetch three.js from any source." >&2
echo "    The game still runs — index.html falls back to the CDN." >&2
echo "    To vendor manually, save this file to vendor/three.module.js:" >&2
echo "    https://unpkg.com/three@${VERSION}/build/three.module.js" >&2
exit 1
