---
title: Change Treeport
description: Fix or extend your own Treeport, try it, and share it.
---

Treeport is your fork. Change it the same way you change any project in Treeport.

1. **Add your clone as a project** in Treeport, then create a tree for the change.
2. **Ask your coding agent** for the fix or feature in that tree.
3. **Try it** with `pnpm dev` in the tree. It opens a separate development Treeport, so the one you're working in keeps running.
4. **Keep it:** merge the tree's branch into your fork, then run `treeport update`.
5. **Share it** (optional): open a pull request to [noice-tech/treeport](https://github.com/noice-tech/treeport) so everyone gets it.

Changes to the Mac app itself take effect after `pnpm app:install` and reopening the app.

## Getting upstream changes

Use **Sync fork** on GitHub, then `treeport update`. If your fork has its own commits and GitHub can't sync it, ask your agent to merge upstream into your fork's main branch, then update.
