#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  printf '%s\n' \
    'Usage: pnpm ci:local' \
    '' \
    'Install repository dependencies and run the local pull request gate.' \
    'The gate includes unit, integration, package, documentation, and static checks.' \
    'Independent checks run concurrently after their build prerequisites.' \
    'Tests always run. Unchanged builds and type checks can use the Turbo cache.' \
    '' \
    'Test commands:' \
    '  pnpm test:unit         Isolated behavior.' \
    '  pnpm test:integration  Component interactions, including terminal hosts and shells; builds prerequisites.' \
    '  pnpm test:web          Browser UI workflows; not part of this gate.' \
    '' \
    'Integration tests require zsh and Bash on PATH.' \
    'Fish coverage is optional and is reported as skipped when fish is absent.' \
    'The gate does not require a browser or Electron runtime.'
  exit 0
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

export CI=true
export TURBO_TELEMETRY_DISABLED=1

pnpm install --frozen-lockfile --prefer-offline
pnpm check
