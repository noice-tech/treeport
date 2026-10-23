#!/bin/bash
# Builds libghostty-vt for wasm32-freestanding from a pinned Ghostty commit
# with ghostty-vt-wasm.patch applied.
# Usage: build-ghostty-vt.sh [--check]
set -euo pipefail

GHOSTTY_COMMIT="08a9518340e19487bd5fdf96963583fb32f0c41f"
GHOSTTY_SHA256="b2df3e649d37437245a932a150d049d638a8af77d8ca03e7b8f616234b3637ce"
ZIG_VERSION="0.17.0"
declare -A ZIG_SHA256=(
  [x86_64-linux]="1cbe9df9f27e6b78d14ccbca43b6703a404ef79ef1c463de901d7f088d4e2026"
  [aarch64-linux]="9e8d11661d4ae3bd57702a3832781e23ad151dde5798e16a5ccd503f65234ff8"
  [x86_64-macos]="4f9a1c5269aa17ebda5e6d3c2b89d6cbf36f7d2b22a0306e9ab98f25f95529c6"
  [aarch64-macos]="b607e9b9234790a008116ae5bdb71c6243b84b9fb42a53a9e70fde41c06c536a"
)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ARTIFACT="$SCRIPT_DIR/../src/ghostty-vt/ghostty-vt.wasm"
MODE="${1:-build}"
if [[ $# -gt 1 || ("$MODE" != build && "$MODE" != --check) ]]; then
  echo "Usage: $0 [--check]" >&2
  exit 1
fi

TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/treeport-ghostty-vt.XXXXXX")"
trap 'rm -rf "$TEMP_DIR"' EXIT

ZIG="${TREEPORT_ZIG:-}"
if [[ -z "$ZIG" ]] && command -v zig >/dev/null && [[ "$(zig version)" == "$ZIG_VERSION" ]]; then
  ZIG="$(command -v zig)"
fi
if [[ -z "$ZIG" ]]; then
  ARCH="$(uname -m)"
  [[ "$ARCH" == arm64 ]] && ARCH=aarch64
  OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
  [[ "$OS" == darwin ]] && OS=macos
  TARGET="$ARCH-$OS"
  if [[ -z "${ZIG_SHA256[$TARGET]:-}" ]]; then
    echo "No pinned Zig $ZIG_VERSION download for $TARGET; set TREEPORT_ZIG." >&2
    exit 1
  fi
  curl -fsSLo "$TEMP_DIR/zig.tar.xz" \
    "https://ziglang.org/download/$ZIG_VERSION/zig-$TARGET-$ZIG_VERSION.tar.xz"
  echo "${ZIG_SHA256[$TARGET]}  $TEMP_DIR/zig.tar.xz" | shasum -a 256 -c - >/dev/null
  tar -xf "$TEMP_DIR/zig.tar.xz" -C "$TEMP_DIR"
  ZIG="$TEMP_DIR/zig-$TARGET-$ZIG_VERSION/zig"
fi
if [[ "$("$ZIG" version)" != "$ZIG_VERSION" ]]; then
  echo "Expected Zig $ZIG_VERSION, got $("$ZIG" version)" >&2
  exit 1
fi

curl -fsSLo "$TEMP_DIR/ghostty.tar.gz" \
  "https://github.com/ghostty-org/ghostty/archive/$GHOSTTY_COMMIT.tar.gz"
echo "$GHOSTTY_SHA256  $TEMP_DIR/ghostty.tar.gz" | shasum -a 256 -c - >/dev/null
tar -xzf "$TEMP_DIR/ghostty.tar.gz" -C "$TEMP_DIR"

cd "$TEMP_DIR/ghostty-$GHOSTTY_COMMIT"
patch -p1 --quiet < "$SCRIPT_DIR/ghostty-vt-wasm.patch"
ZIG_GLOBAL_CACHE_DIR="$TEMP_DIR/global-cache" \
  "$ZIG" build -Demit-lib-vt -Dtarget=wasm32-freestanding -Doptimize=ReleaseSmall \
  --cache-dir "$TEMP_DIR/local-cache" \
  --prefix "$TEMP_DIR/output"
BUILT="$TEMP_DIR/output/bin/ghostty-vt.wasm"

if [[ "$MODE" == --check ]]; then
  if ! cmp -s "$BUILT" "$ARTIFACT"; then
    echo "src/ghostty-vt/ghostty-vt.wasm does not match patched Ghostty $GHOSTTY_COMMIT." >&2
    exit 1
  fi
  echo "ghostty-vt.wasm matches patched Ghostty $GHOSTTY_COMMIT."
else
  cp "$BUILT" "$ARTIFACT"
  echo "Built $ARTIFACT"
fi
