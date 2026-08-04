#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if (($# > 0)); then
  echo 'Treeport uses the default signoff context; pnpm signoff does not accept arguments.' >&2
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo 'GitHub CLI is required. Install it from https://cli.github.com/ and retry.' >&2
  exit 1
fi

if ! gh signoff --help >/dev/null 2>&1; then
  echo 'The gh-signoff extension is required. Install it with:' >&2
  echo '  gh extension install basecamp/gh-signoff' >&2
  exit 1
fi

branch="$(git symbolic-ref --quiet --short HEAD || true)"
if [[ -z "$branch" ]]; then
  echo 'Signoff requires an attached branch. Switch to or create a branch, then retry.' >&2
  exit 1
fi

status="$(git status --porcelain --untracked-files=normal)"
if [[ -n "$status" ]]; then
  echo 'Signoff requires a clean worktree. Commit or remove these changes, then retry:' >&2
  printf '%s\n' "$status" >&2
  exit 1
fi

pnpm ci:local
git push --set-upstream origin HEAD
gh signoff
