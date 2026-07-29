---
title: Worktree setup hooks
description: Prepare a new worktree with repository-defined setup commands.
---

Run repository-defined setup when Treeport creates a worktree. Use hooks to install dependencies, copy local environment files, generate code, or prepare any other local prerequisites.

Hooks run in the new worktree, in order. If one fails, Treeport stops running the remaining hooks and reports the failure; the worktree remains available for you to inspect or finish setting up manually.

Treeport currently supports **Zed worktree hooks only**. Contributions that add support for other existing formats are welcome. A Treeport-specific format is planned.

## Zed

Define tasks with the `create_worktree` hook in `.zed/tasks.json` at the repository's main worktree:

```json
{
  "tasks": [
    {
      "label": "Install dependencies",
      "command": "pnpm install",
      "hooks": ["create_worktree"]
    },
    {
      "label": "Copy local environment",
      "command": "cp",
      "args": [".env.example", ".env"],
      "hooks": ["create_worktree"]
    }
  ]
}
```

Tasks run with the new worktree as their default working directory. Treeport also provides Zed's `ZED_WORKTREE_ROOT` and `ZED_MAIN_GIT_WORKTREE` variables, which can be used in a command, arguments, task environment, or `cwd`.

See the [Zed task documentation](https://zed.dev/docs/tasks) for the complete task format.
