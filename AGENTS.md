# AGENTS.md

## About Treeport

Treeport is a worktree-first terminal driver. It registers Git repositories, discovers their main and linked worktrees, and runs persistent terminals in a dedicated, application-owned tmux server for each worktree. Its web UI attaches normal terminal clients to tools such as Pi, shells, and development servers without replacing or modifying their TUIs.

## Documentation

- Keep project documentation in `apps/docs`.
- Public documentation belongs in `apps/docs/src/content/docs`.
- Internal documentation, including architectural decisions, belongs in `apps/docs/internal` and must not be added to the public Starlight content collection or sidebar.

## Coding guidelines

- Keep things in one function unless composable or reusable.
- Do not extract single-use helpers preemptively. Inline the logic at the call site unless the helper is reused, hides a genuinely complex boundary, or has a clear independent name that improves the caller.
- Avoid `try`/`catch` where possible.
- Do not write tests that are really thin and assert strings. Test behavior in critical paths.

## Validation

- Use the smallest relevant check while developing.
- `pnpm ci:local` is the complete local pull request gate.
- `pnpm signoff` runs the local gate, pushes the committed branch, and publishes the required `signoff` status for the pushed HEAD.
- `pnpm signoff` is not a read-only validation command because it pushes to GitHub.
