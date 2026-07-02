#!/bin/bash
set -e

cd "$(dirname "$0")"

DIST="dist"
mkdir -p "$DIST"

# Files to include in both packages
FILES=(
  icons/
  popup/
  export/
  content-scripts/
  background/background.js
  lib/
  LICENSE
  README.md
  ACKNOWLEDGMENTS.md
)

echo "📦 Building Firefox package..."
cp manifest.json manifest.json.bak
zip -r "$DIST/threadkeeper-firefox.zip" "${FILES[@]}" manifest.json
mv manifest.json.bak manifest.json
echo "✓ dist/threadkeeper-firefox.zip"

echo "📦 Building Chrome package..."
cp manifest.chrome.json manifest.json.tmp
zip -r "$DIST/threadkeeper-chrome.zip" "${FILES[@]}" background/sw.js
cd "$DIST"
# Swap manifest for Chrome version inside the zip
zip -d threadkeeper-chrome.zip manifest.json 2>/dev/null || true
cd ..
cp manifest.chrome.json manifest_chrome_tmp.json
zip "$DIST/threadkeeper-chrome.zip" manifest_chrome_tmp.json
cd "$DIST"
unzip -p ../manifest_chrome_tmp.json > /dev/null 2>&1 || true
cd ..
rm -f manifest_chrome_tmp.json manifest.json.tmp
echo "✓ dist/threadkeeper-chrome.zip"

echo ""
echo "✨ Done. Packages in dist/"
