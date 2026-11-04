#!/bin/bash
# Builds both extension packages from extension/ (one codebase):
#   dist/throwaway-mail-<version>.xpi         Firefox (unsigned zip, background.scripts)
#   dist/throwaway-mail-<version>-chrome.zip  Chrome/Chromium MV3 (service worker, contextMenus, PNG icons)
# Firefox: about:debugging -> Load Temporary Add-on, or AMO "unlisted" signing.
# Chrome: chrome://extensions -> Developer mode -> Load unpacked (unzipped folder), or the Chrome Web Store.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
VERSION=$(node -p 'require("./extension/manifest.json").version')
FIREFOX="$ROOT/dist/throwaway-mail-$VERSION.xpi"
CHROME="$ROOT/dist/throwaway-mail-$VERSION-chrome.zip"
mkdir -p dist
rm -f "$FIREFOX" "$CHROME"

(cd extension && zip -qr -X "$FIREFOX" . -x '*.DS_Store' -x 'service-worker.js' -x 'icons/*.png')

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
cp -r extension/. "$STAGE/"
rm -f "$STAGE/icons/throwaway-mail.svg"
node scripts/chrome-manifest.mjs extension/manifest.json >"$STAGE/manifest.json"
(cd "$STAGE" && zip -qr -X "$CHROME" . -x '*.DS_Store')

echo "dist/$(basename "$FIREFOX")"
echo "dist/$(basename "$CHROME")"
