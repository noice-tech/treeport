# AGENTS.md

## About TaskTTY

TaskTTY is a worktree-first terminal driver. It registers Git repositories, discovers their main and linked worktrees, and runs persistent terminals in a dedicated, application-owned tmux server for each worktree. Its web UI attaches normal terminal clients to tools such as Pi, shells, and development servers without replacing or modifying their TUIs.

## Coding guidelines

- Keep things in one function unless composable or reusable.
- Do not extract single-use helpers preemptively. Inline the logic at the call site unless the helper is reused, hides a genuinely complex boundary, or has a clear independent name that improves the caller.
- Avoid `try`/`catch` where possible.
- Do not write tests that are really thin and assert strings. Test behavior in critical paths.
