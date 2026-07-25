---
name: solve-task-tasktty
description: Delegate a TaskTTY repository task from the current coordinating agent to a new persistent worktree and Pi terminal. Use when the user explicitly asks the current agent to start a task in a separate TaskTTY worktree. Never use when the prompt contains TASKTTY_DIRECT_WORKER; that agent must work directly in its existing worktree.
compatibility: Requires the tasktty CLI and Pi to be installed, with a reachable TaskTTY daemon.
---

# Solve a Task with TaskTTY

## Recursion guard

If the current request contains `TASKTTY_DIRECT_WORKER`, do not use this workflow. The agent is already the delegated worker: it must solve the task directly in its current worktree and must not create another worktree or agent.

Otherwise, use the `tasktty` skill.

Do not implement the task in the coordinating worktree. Create a separate TaskTTY-managed worktree and start a persistent interactive Pi agent there with the task as its initial prompt.

## Workflow

1. Identify the task from the user's request. Preserve issue references, requirements, and relevant context in the child prompt.
2. Choose a short, descriptive worktree name and terminal name. Do not ask the user for names unless ambiguity would make the worktree misleading.
3. Follow the `tasktty` skill to resolve the current project and spawn the child worktree and terminal.
4. Launch `pi` directly as the child program. Begin its initial prompt with the exact marker `TASKTTY_DIRECT_WORKER` and explicitly tell it that it is already in the delegated worktree, must work directly there, and must not spawn another worktree or agent. Then describe the implementation requirements and ask it to validate its work. Do not repeat the user's delegation wording (such as “start solving this task”) in the child prompt. Keep Pi interactive and persistent; do not use print mode or restrict its normal tools.
5. Return once creation succeeds. Report the worktree and terminal identifiers and any partial-creation errors. Do not wait for the child agent to finish.

A typical child command is shaped like:

```sh
tasktty spawn \
  --project <project-id> \
  --worktree-name <task-slug> \
  --name agent \
  -- pi "TASKTTY_DIRECT_WORKER: Work directly in this existing worktree. Do not create another worktree or delegate to another agent. Implement and validate the following: <task requirements and context>"
```

Use `--from-current` only when the task must start from the current worktree's committed `HEAD`; uncommitted changes are not copied. Otherwise use TaskTTY's default base.

Do not delete or clean up the created terminal or worktree unless the user explicitly requests it.
