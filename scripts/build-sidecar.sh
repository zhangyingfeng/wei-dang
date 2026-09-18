#!/bin/bash
# Compiles the Node backend into a single-file executable (via Bun's native
# compiler) and drops it in src-tauri/binaries/ as a Tauri sidecar, so the
# packaged app doesn't require Node or Bun to be installed on the user's
# machine. Bun bundles TypeScript/ESM natively, so no separate build step is
# needed first.
#
# Unlike zhi-dang's version of this script, there's no edition argument —
# this project only ever has one entry point (src/index.ts).
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v bun >/dev/null 2>&1; then
  echo "bun is required to build the sidecar (https://bun.sh) but was not found on PATH" >&2
  exit 1
fi

TARGET_TRIPLE=$(rustc -vV | awk '/^host:/ { print $2 }')
if [ -z "$TARGET_TRIPLE" ]; then
  echo "Could not determine target triple (is rustc on PATH?)" >&2
  exit 1
fi

mkdir -p src-tauri/binaries
OUT="src-tauri/binaries/weidang-server-$TARGET_TRIPLE"
if [ "$(uname)" = "Windows_NT" ] || [[ "$TARGET_TRIPLE" == *windows* ]]; then
  OUT="$OUT.exe"
fi

echo "==> Compiling backend with Bun (src/index.ts)"
# Not a plain `bun build ... --compile` CLI call: build-sidecar-compile.mjs
# adds a plugin (see katex-stub.mjs) that only the programmatic Bun.build()
# API can take, not the CLI form.
bun scripts/build-sidecar-compile.mjs src/index.ts "$OUT"

if [ "$(uname)" = "Darwin" ]; then
  codesign --sign - --force "$OUT" 2>/dev/null || true
fi
chmod +x "$OUT"

echo "==> Sidecar built: $OUT ($(du -h "$OUT" | cut -f1))"
