# Treeport

Treeport is a tree-first terminal driver for persistent development workspaces.

```sh
npm install --global @treeport/treeport
cd /path/to/repository
treeport .
```

Treeport starts its backend if needed, registers the repository and its trees, and opens the current tree in the desktop app or browser. Run `treeport start` to start only the backend. Use `treeport service enable` when a host must start Treeport after reboot.

Treeport supports macOS and Linux. It requires Node.js 24 or newer, npm, and Git.

Documentation: <https://treeport.app>
