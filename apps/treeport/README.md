# Treeport

Treeport is a worktree-first terminal driver for persistent development workspaces.

```sh
npm install --global @treeport/treeport
cd /path/to/repository
treeport .
```

Treeport starts its backend if needed, registers the repository and its worktrees, and opens the current worktree in the desktop app or browser. Run `treeport up` to start only the backend.

Treeport supports macOS and Linux and requires Node.js 24 or newer, Git, and tmux 3.2 or newer.

Documentation: <https://treeport.app>
