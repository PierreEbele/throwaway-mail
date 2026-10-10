#!/bin/bash
# Construit dist/fable-throwaway-<version>.xpi (zip non signé) depuis extension/.
# Firefox : about:debugging -> Charger un module temporaire, ou signature AMO "unlisted".
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(node -p 'require("./extension/manifest.json").version')
OUT="dist/fable-throwaway-$VERSION.xpi"
mkdir -p dist && rm -f "$OUT"
(cd extension && zip -qr -X "../$OUT" . -x '*.DS_Store')
echo "$OUT"
