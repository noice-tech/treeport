---
name: solve-task-tasktty
description: Start solving a TaskTTY repository task in a separate persistent worktree and Pi terminal. Use only when the user explicitly asks to start solving or implementing a task, issue, bug, or feature now; do not use for requests that only ask to discuss, explain, investigate, review, or plan work.
compatibility: Requires the tasktty CLI and Pi to be installed, with a reachable TaskTTY daemon.
---

# Solve a Task with TaskTTY

Use the `tasktty` skill.

Do not implement the task in the current worktree. Create a separate TaskTTY-managed worktree and start a persistent interactive Pi agent there with the task as its initial prompt.

## Workflow

1. Identify the task from the user's request. Preserve issue references, requirements, and relevant context in the child prompt.
2. Choose a short, descriptive worktree name and terminal name. Do not ask the user for names unless ambiguity would make the worktree misleading.
3. Follow the `tasktty` skill to resolve the current project and spawn the child worktree and terminal.
4. Launch `pi` directly as the child program and pass a clear initial prompt telling it to begin solving the task, implement the solution, and validate its work. Keep Pi interactive and persistent; do not use print mode or restrict its normal tools.
5. Return once creation succeeds. Report the worktree and terminal identifiers and any partial-creation errors. Do not wait for the child agent to finish.

A typical child command is shaped like:

```sh
tasktty spawn \
  --project <project-id> \
  --worktree-name <task-slug> \
  --name agent \
  -- pi "Start solving this task now: <task and context>"
```

Use `--from-current` only when the task must start from the current worktree's committed `HEAD`; uncommitted changes are not copied. Otherwise use TaskTTY's default base.

Do not delete or clean up the created terminal or worktree unless the user explicitly requests it.
