#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

export CI=true
export TURBO_TELEMETRY_DISABLED=1

pnpm install --frozen-lockfile --prefer-offline
pnpm check
