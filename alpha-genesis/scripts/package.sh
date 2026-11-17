#!/usr/bin/env bash
# Builds release/ALPHA-GENESIS-v3.0.zip from tracked source plus the pre-built dashboard.
# Credentials, market data, databases and node_modules are never included.
set -euo pipefail
cd "$(dirname "$0")/.."
VER="${1:-v3.0}"; OUT="release/ALPHA-GENESIS-$VER.zip"; STAGE="$(mktemp -d)/ALPHA-GENESIS-$VER"   # e.g. ./scripts/package.sh macOS
(cd frontend && npm run build >/dev/null)
mkdir -p "$STAGE" release
git ls-files . | grep -v -E '^(release/|docs/screenshots)' | while read -r f; do mkdir -p "$STAGE/$(dirname "$f")"; cp "$f" "$STAGE/$f"; done
cp -r frontend/dist "$STAGE/frontend/dist"
if find "$STAGE" -name '*.parquet' -o -name '*.sqlite' -o -name '.env' -o -name '*.pkl' -o -name '*.npz' | grep -q .; then echo "refusing to package: data or secret files present" >&2; exit 1; fi
rm -f "$OUT"; (cd "$(dirname "$STAGE")" && zip -q -r - "ALPHA-GENESIS-$VER") > "$OUT"
chmod +x "$STAGE"/*.command "$STAGE"/*.sh "$STAGE"/scripts/*.sh 2>/dev/null || true
rm -f "$OUT"; (cd "$(dirname "$STAGE")" && zip -q -r - "ALPHA-GENESIS-$VER") > "$OUT"
sha256sum "$OUT" | tee "release/ALPHA-GENESIS-$VER.sha256"; unzip -l "$OUT" | tail -1
