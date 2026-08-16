# Treeport

Treeport is a Tree-first terminal driver for persistent development workspaces.

```sh
npm install --global @treeport/treeport
cd /path/to/repository
treeport .
```

Treeport starts its backend if needed, registers the repository and its Trees, and opens the current Tree in the desktop app or browser. Run `treeport start` to start only the backend. Use `treeport service enable` when a host must start Treeport after reboot.

Treeport supports macOS and Linux and requires Node.js 24 or newer, Git, and tmux 3.2 or newer.

Documentation: <https://treeport.app>
