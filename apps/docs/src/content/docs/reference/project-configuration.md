---
title: Project configuration
description: Set commands, terminal presets, and project settings.
---

Treeport reads configuration files from the `.treeport/` directory at the repository root.

| File                                             | Function                                 | File location |
| ------------------------------------------------ | ---------------------------------------- | ------------- |
| [`setup.json`](#setupjson)                       | Tree setup and cleanup commands          | Main tree     |
| [`terminal-presets.json`](#terminal-presetsjson) | Shared terminal presets                  | Each tree     |
| [`settings.json`](#settingsjson)                 | Project packages and tree context fields | Project root  |

To add [web panels](/features/web-panels/), put the panel files in `.treeport/web-panels/`.

## setup.json

Use `.treeport/setup.json` for [tree setup and cleanup](/features/worktree-setup-hooks/).

Create this file at the root of the project's main tree. Treeport reads this copy for setup and cleanup. It does not read the copy in the tree that it creates or removes.

You can use comments and trailing commas in this file.

```json
{
  "commands": [
    {
      "name": "Install dependencies",
      "argv": ["pnpm", "install", "--frozen-lockfile"],
      "timeout": "10m"
    },
    {
      "name": "Copy local configuration",
      "argv": [
        "cp",
        "${TREEPORT_MAIN_WORKTREE_PATH}/.env.local",
        "${TREEPORT_WORKTREE_PATH}/.env.local"
      ]
    }
  ],
  "cleanup": [
    {
      "name": "Remove the tree database",
      "argv": ["node", "scripts/remove-tree-database.mjs"]
    }
  ]
}
```

Replace the example commands with commands and scripts for your project.

- Put setup commands in the `commands` array. This field is mandatory. For cleanup without setup, use `[]`.
- Put cleanup commands in the optional `cleanup` array.

### Command fields

| Field     | Description                                                                                                                    |
| --------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `name`    | The name that Treeport shows. This field is mandatory. The name must not be empty.                                             |
| `argv`    | An array with the executable first, then its arguments. This field is mandatory.                                               |
| `cwd`     | The working directory. The default is the tree root. Relative paths start at this root. The directory must be inside the tree. |
| `env`     | Additional environment variables as string key/value pairs. Commands also use Treeport's environment.                          |
| `timeout` | The time limit for the command. The default is `30m`. The maximum is `2147483647ms`.                                           |

For `timeout`, use a positive integer with `ms`, `s`, `m`, or `h`. For example, use `500ms` or `10m`.

Treeport runs commands in list order. It stops the list at the first failure. Treeport does not accept unknown configuration fields.

### Paths and shell commands

Treeport supplies two environment variables:

- `TREEPORT_WORKTREE_PATH`: the absolute path of the tree that Treeport creates or removes.
- `TREEPORT_MAIN_WORKTREE_PATH`: the absolute path of the project's main tree.

Use `${TREEPORT_WORKTREE_PATH}` or `${TREEPORT_MAIN_WORKTREE_PATH}` in `argv`, `cwd`, or `env` values. Treeport replaces these references with the paths. Do not set these variables in `env`.

Treeport runs `argv` without a shell. To use pipes, redirects, or shell expansion, include a shell in `argv`. For example, use `["sh", "-c", "pnpm install && pnpm build"]`.

If `.treeport/setup.json` is absent, Treeport can use compatible Zed `create_worktree` tasks for setup. To prevent this, create the file with an empty `commands` array. Treeport does not use Zed tasks for cleanup.

These commands run with your user permissions. Use them only in repositories that you trust.

## terminal-presets.json

Create `.treeport/terminal-presets.json` to share [terminal presets](/features/terminal-presets/). Each tree reads its own copy.

Use standard JSON in this file. Do not use comments or trailing commas.

```json
{
  "presets": {
    "dev": {
      "name": "Development server",
      "executable": "pnpm",
      "args": ["dev"],
      "closeOnSuccess": false
    }
  }
}
```

- Put command definitions in the `presets` object. Use a preset ID as the key for each definition.
- Include `name`, `executable`, and `args` in each definition. If there are no arguments, use `[]` for `args`.
- Set `closeOnSuccess` to `true` to close the terminal after a successful command. The default is `false`. Terminals stay open after a command fails.

## settings.json

Treeport reads project settings from `.treeport/settings.json` at the registered project root.

Use standard JSON in this file. Do not use comments or trailing commas.

```json
{
  "packages": [],
  "treeContext": {
    "fields": [{ "id": "task", "label": "Task", "input": "textarea" }]
  }
}
```

- `packages` is a list of npm or local [packages](/features/packages/). To add a package, use `treeport install -l <source>`. To remove a package, use `treeport remove -l <source>`.
- `treeContext.fields` defines the fields for tree context. It does not contain the context values for each tree.
- `npmCommand` is an optional array with the npm executable and its arguments. For example, use `["npm"]`.

For each tree context field:

- Set a unique `id`.
- Set a `label` that is not empty.
- Set `input` to `text` or `textarea`.

Treeport reads global packages and tree context fields from `settings.json` in its data directory. If a project field and a global field have the same ID, Treeport uses the project field definition.
