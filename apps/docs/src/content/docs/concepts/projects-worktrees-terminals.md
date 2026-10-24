---
title: Projects, trees, and apps
description: Organize agents, terminals, browser tabs, and custom apps by project and task.
---

In Treeport, each tree holds an agent's session and the tools you use to guide it and check its work.

```text
Project
└── Tree
    ├── Terminal — agent, shell, or development server
    ├── Browser — website or running app
    └── Web app — editor, diff viewer, or custom tool
```

A project is a Git repository or ordinary folder opened in Treeport.

A tree is a workspace for one Git worktree. An ordinary folder project has one tree.

An app is a terminal, browser tab, or custom web app opened in a tree.

Treeport finds existing Git worktrees. You can also create trees in Treeport to work on separate tasks, each with its own files, branch, and apps.

## Add tools to a tree

For a feature, keep a coding agent and a development server in separate [terminals](/features/persistent-terminals/). Open the running app in a [browser](/features/browser-app/), then use a [custom web app](/features/web-apps/) to review changes or work with project data.

Use **New app** to add tools to the current tree. [Launchers](/features/launchers/) and [packages](/features/packages/) make your usual tools available across tasks.

Some web apps use [app services](/features/web-apps/#app-services) for their backend. Several trees can share the same service process.

## Return to your work

Closing a project does not stop its terminals or delete files. Open it again to reconnect.

Terminal processes run on the host. They keep running when you close the client window, and you can reconnect from another device with [remote access](/features/remote-access/).
