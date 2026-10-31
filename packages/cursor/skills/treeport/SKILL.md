---
name: treeport
description: Use Treeport to manage persistent terminals, shared browser tabs, projects, and separate trees. Use when running inside Treeport, starting servers, opening a browser, or delegating work into another tree.
compatibility: Requires the treeport CLI and a reachable Treeport daemon.
---

<!-- Managed by @treeport/cursor. -->

# Treeport

Treeport keeps projects, Git worktrees (trees), persistent terminals, and browser tabs together. Use its CLI through your shell tool; no MCP server or special agent launcher is required.

## Start with context

Run `treeport context` before Treeport operations. It identifies this terminal, project, tree, and API instance.

Use the inherited instance and exact IDs from context. Never infer the target from the current folder, a familiar port, or the visible Treeport window. A worktree's development instance may differ from the instance hosting this terminal. Do not mutate another instance without permission.

For CLI installations with a machine-local development wrapper, use the executable in `TREEPORT_CLI_ENTRYPOINT` if set. If `TREEPORT_DAEMON_RECORD` points to `<app>/.treeport-dev/runtime/daemon.json`, the matching CLI is `<app>/bin/treeport.mjs`. Pass the inherited `TREEPORT_API_URL`; do not use a development wrapper that switches to another instance.

## Persistent terminals

Start servers and long-running tools in their own Treeport terminals, not hidden background shell processes:

```sh
treeport terminal create --worktree . --name "Dev server" -- pnpm dev
treeport terminal list --worktree .
treeport terminal inspect <terminal-id>
treeport terminal capture <terminal-id> --lines 200
```

Arguments after `--` are executable arguments, not shell source. If shell syntax is needed, explicitly launch `bash -lc` and keep untrusted values out of interpolated shell strings.

Wait for runtime conditions instead of polling or sleeping:

```sh
treeport terminal wait <terminal-id> --until working --timeout 30s
treeport terminal wait <terminal-id> --until idle --timeout 10m
treeport terminal wait <terminal-id> --until attention --timeout 10m
treeport terminal wait <terminal-id> --until exit --timeout 10m
```

`idle` means no `working` activity, not proof that every application has completed. `attention` waits for the next attention event, not an already-unread notification. Inspect first when the process may already have finished. Terminal creation success does not prove its command succeeded; inspect output and exit status.

Send input like `tmux send-keys`: key names such as `Enter`, `Escape`, `Up`, and `C-c` are sent as keys, and other arguments are typed literally. Paste multi-line text with `send-text`, which reads stdin when no text is given, then submit with `Enter`:

```sh
treeport terminal send-keys <terminal-id> 'npm test' Enter
treeport terminal send-keys <terminal-id> C-c
cat prompt.md | treeport terminal send-text <terminal-id>
treeport terminal send-keys <terminal-id> Enter
```

Never delete a terminal unless the user explicitly asks to stop or close it. Never delete your own Cursor terminal.

## Shared browser

```sh
treeport browser list
treeport browser open --worktree . http://localhost:3000
treeport browser snapshot
treeport browser click e12
treeport browser fill e14 "value"
treeport browser press Enter
treeport browser console
treeport browser network
treeport browser run 'return await page.title()'
treeport browser screenshot
```

Use snapshot element references, and take a fresh snapshot after navigation. When multiple tabs are open, specify `--app <app-id>`.

Keep tabs open for user inspection. Check `treeport browser status` if the runtime is unavailable, and ask permission before installing a browser runtime. Never attach a personal browser profile or put secrets in URLs.

## Separate work

Create an independent tree and its first terminal:

```sh
treeport spawn --worktree-name <tree-name> --name <terminal-name> -- <program> <arg> ...
```

By default, Treeport bases new trees on the fetched remote default branch. Use `--from-current` only when the task needs the current committed HEAD; uncommitted changes are not copied. Create trees sequentially. Do not automatically launch additional coding agents unless the user's request authorizes delegation.

If creation reports `terminalError` or `setupError`, the tree may already exist. Report the retained tree and terminal IDs rather than blindly retrying or removing them. Never remove trees without explicit permission.

## Launchers

Launchers are saved programs that the Treeport UI and `treeport launch` start in a tree. A lowercase `${name}` in an argument is an input that is filled in at launch. To register an agent CLI, check its `--help` for how it accepts an initial prompt, then run:

```sh
treeport launcher add --name Claude -- claude '${prompt}'
treeport launch claude --new-tree --tree-name login-redirect --input prompt="Fix the login redirect loop"
```

Add `--repo` to save the launcher in the current tree's `.treeport/settings.json`. Use `treeport launcher list` to see launcher IDs and inputs. Trees keep their folder name, but `treeport worktree title "<title>"` changes the title shown for the current tree.

## Safety and command discovery

- The user's shell or supervisor owns server startup and shutdown.
- Do not run `sudo` or change remote exposure without explicit permission.
- Use normal command output for reading; add `--json` for programmatic parsing, before the `--` separator.
- Use `treeport <command> --help` for options not shown here.
