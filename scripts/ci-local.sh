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
    'Integration tests require zsh and Bash on PATH, plus compatible Playwright Chromium.' \
    'Fish coverage is optional and is reported as skipped when fish is absent.' \
    'To install Chromium, run: pnpm --filter @treeport/treeport exec playwright install chromium' \
    'For Linux browser libraries, run: pnpm --filter @treeport/treeport exec playwright install-deps chromium' \
    'Set PLAYWRIGHT_BROWSERS_PATH if you use a custom Playwright browser cache.' \
    'This script does not install Chromium or system dependencies.'
  exit 0
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

export CI=true
export TURBO_TELEMETRY_DISABLED=1

pnpm install --frozen-lockfile --prefer-offline
pnpm check
