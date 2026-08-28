# AGENTS.md

## About Treeport

Treeport is a worktree-first terminal driver. It registers Git repositories, discovers their main and linked worktrees, and runs persistent terminals in a dedicated, application-owned tmux server for each worktree. Its web UI attaches normal terminal clients to tools such as Pi, shells, and development servers without replacing or modifying their TUIs.

## Developing Treeport inside Treeport

Treeport development terminals are usually managed by an outer Treeport instance, while each worktree may run its own `pnpm dev` instance.

- `treeport context` and inherited `TREEPORT_*` variables describe the outer instance, not necessarily the current worktree’s development instance.
- For the current worktree’s dev instance, use `apps/treeport/.treeport-dev/runtime/daemon.json` as the source of truth.
- Before package or API mutations, verify its PID belongs to this worktree and explicitly target its recorded `apiUrl`, for example:

  ```sh
  TREEPORT_API_URL="$(node -p \
    "JSON.parse(require('fs').readFileSync('apps/treeport/.treeport-dev/runtime/daemon.json')).apiUrl")" \
    treeport list
  ```

- Do not infer the target instance from a familiar port or whichever Treeport window is visible.
- Never mutate the outer instance or another worktree’s dev instance unless explicitly requested.

## Documentation

- Keep project documentation in `apps/docs`.
- Public documentation belongs in `apps/docs/src/content/docs`.
- Internal documentation, including architectural decisions, belongs in `apps/docs/internal` and must not be added to the public Starlight content collection or sidebar.

## Coding guidelines

- Keep things in one function unless composable or reusable.
- Do not extract single-use helpers preemptively. Inline the logic at the call site unless the helper is reused, hides a genuinely complex boundary, or has a clear independent name that improves the caller.
- Avoid `try`/`catch` where possible.
- Prefer a stable object shape with nullable properties over unions that require property-existence checks such as the `in` operator.
- Do not add backward-compatibility paths for internal changes. For user-facing contracts, preserve compatibility when required; otherwise prefer a deliberate migration or clean change over maintaining legacy behavior.
- Do not write tests that are really thin and assert strings. Test behavior in critical paths.

## Validation

- Use the smallest relevant check while developing.
- `pnpm ci:local` is the complete local pull request gate. Agents can use it to validate their work.
- `pnpm signoff` runs the local gate, pushes the committed branch, and publishes the required `signoff` status for the pushed HEAD.
- `pnpm signoff` is not a read-only validation command because it pushes to GitHub.
