#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  printf '%s\n' \
    'Usage: pnpm ci:local' \
    '' \
    'Install repository dependencies and run the local pull request gate.' \
    'The gate includes unit, integration, desktop, package, and static checks.' \
    '' \
    'Test commands:' \
    '  pnpm test:unit         Isolated behavior.' \
    '  pnpm test:integration  Component interactions, including browsers and shells; builds prerequisites.' \
    '  pnpm test:web          Browser UI workflows; not part of this gate.' \
    '  pnpm test:desktop      Electron workflows; builds prerequisites.' \
    '' \
    'Integration tests require zsh and Bash on PATH, plus a configured browser runtime.' \
    'Fish coverage is optional and is reported as skipped when fish is absent.' \
    'On macOS, install Google Chrome in /Applications.' \
    'On Linux, set up the browser container with treeport browser install.' \
    'Alternatively, set TREEPORT_BROWSER_EXECUTABLE to an absolute Chrome/Chromium executable path.' \
    'Browser sandbox support is required. This script does not install browsers or system dependencies.'
  exit 0
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

export CI=true
export TURBO_TELEMETRY_DISABLED=1

pnpm install --frozen-lockfile --prefer-offline
pnpm check
