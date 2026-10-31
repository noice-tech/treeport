---
title: Project configuration
description: Set commands, launchers, and project settings.
---

`.treeport/settings.json`:

| Section                   | Function                                                  | File location           |
| ------------------------- | --------------------------------------------------------- | ----------------------- |
| [`setup`](#setup)         | [Tree setup and cleanup](/features/worktree-setup-hooks/) | Main tree               |
| [`launchers`](#launchers) | [Shared launchers](/features/launchers/)                  | Current tree            |
| [`packages`](#packages)   | [Project packages](/features/packages/)                   | Registered project root |

```jsonc
// Comments explain this example; omit them from settings.json.
{
  // Commands for creating and removing trees, read from the main tree.
  "setup": {
    "commands": [
      {
        "name": "Install dependencies",
        "argv": ["pnpm", "install", "--frozen-lockfile"],
        "timeout": "10m"
      }
    ],
    "cleanup": []
  },
  // Shared launchers, read from the current tree.
  "launchers": {
    "dev": {
      "name": "Development server",
      "executable": "pnpm",
      "args": ["dev"]
    },
    "claude": {
      "name": "Claude",
      "executable": "claude",
      // ${task} is asked for when the launcher starts.
      "args": ["${task}"],
      "treeTitle": {
        "executable": "claude",
        "args": ["-p", "Reply with a 3-5 word title for: ${task}"]
      }
    }
  },
  // Project package sources, read from the registered project root.
  "packages": []
}
```

To add [web apps](/features/web-apps/), put the app files in `.treeport/web-apps/`.

## Setup

Use `setup.commands` to prepare each new tree: copy local `.env` files from the main tree, install dependencies, or create and seed a tree-specific database.

Use `setup.cleanup` to remove resources when the tree is removed, such as dropping its database or stopping its containers. Make cleanup commands safe to repeat.

### Command fields

| Field     | Required | Description                                                                                                                        |
| --------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `name`    | Yes      | The name that Treeport shows. Must be non-empty.                                                                                   |
| `argv`    | Yes      | An array with the executable first, then its arguments.                                                                            |
| `cwd`     | No       | The working directory. Defaults to the target tree root. Relative paths start at this root. The directory must be inside the tree. |
| `env`     | No       | Additional environment variables as string key/value pairs. Commands also use Treeport's environment.                              |
| `timeout` | No       | The time limit for the command. Defaults to `30m`. The maximum is `2147483647ms`.                                                  |

For `timeout`, use a positive integer with `ms`, `s`, `m`, or `h`. For example, use `500ms` or `10m`.

Treeport runs commands in list order and stops the list at the first failure.

### Paths and shell commands

Treeport supplies two environment variables:

- `TREEPORT_WORKTREE_PATH`: the absolute path of the tree that Treeport creates or removes.
- `TREEPORT_MAIN_WORKTREE_PATH`: the absolute path of the project's main tree.

Use `${TREEPORT_WORKTREE_PATH}` or `${TREEPORT_MAIN_WORKTREE_PATH}` in `argv`, `cwd`, or `env` values. Treeport replaces these references with the paths. These environment variables are reserved for Treeport.

Treeport runs `argv` directly. To use pipes, redirects, or shell expansion, include a shell in `argv`. For example, use `["sh", "-c", "pnpm install && pnpm build"]`.

If `setup` is absent, Treeport can use compatible Zed `create_worktree` tasks for setup. An empty `setup.commands` array disables this fallback. Cleanup uses only `setup.cleanup`.

These commands run with your user permissions. Use them only in repositories that you trust.

## Launchers

- Use a launcher ID as the key for each launcher definition. IDs start with a lowercase letter or number and contain lowercase letters, numbers, dots, underscores, or hyphens.
- Include `name`, `executable`, and `args` in each definition. If there are no arguments, use `[]` for `args`.
- Write `${name}` inside an argument to ask for an [input](/features/launchers/#inputs) at launch. Input names start with a lowercase letter and contain lowercase letters, numbers, or underscores.
- Set `closeOnSuccess` to `true` to close the terminal after a successful command. The default is `false`. Terminals stay open after a command fails.
- Set `treeTitle` to an object with `executable` and `args` to title new trees started with this launcher. Its first output line becomes the tree title. It can use the same inputs.

## Packages

- `packages` is a list of local [packages](/features/packages/). To add a package, use `treeport install -l <source>`. To remove a package, use `treeport remove -l <source>`.

Treeport reads global packages from `settings.json` in its data directory.
