---
title: Shell setup
description: Configure an informative interactive shell for Treeport terminals.
---

Treeport starts your current login shell and keeps its startup configuration. It does not require a shell framework or replace your prompt.

## Recommended zsh setup

The recommended interactive shell is [zsh](https://www.zsh.org/) with [Oh My Zsh](https://ohmyz.sh/).

Oh My Zsh supplies a default configuration, optional plug-ins, themes, and automatic terminal titles.

Automatic titles help Treeport show the current directory for an inactive shell. Treeport separately captures the complete command in supported interactive shells.

Follow the [official Oh My Zsh installation instructions](https://github.com/ohmyzsh/ohmyzsh#getting-started).

Keep automatic title support enabled. The setting `DISABLE_AUTO_TITLE=true` disables this title behavior.

## Use other shells

This recommendation is optional. Bash, fish, plain zsh, and other shell configurations continue to work as standard Treeport terminals.

Interactive zsh, Bash, and fish have best-effort command-title integration. Other configurations show the foreground executable name.

To configure titles, send a short title with OSC `0` or `2`. See the [terminal signals reference](/reference/terminal-signals/).
