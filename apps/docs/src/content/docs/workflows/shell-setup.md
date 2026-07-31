---
title: Shell setup
description: Use an informative interactive shell in Treeport terminals.
---

Treeport starts your existing login shell and preserves its startup configuration. It does not require a shell framework or replace your prompt.

## Recommended zsh setup

Our recommended interactive shell setup is [zsh](https://www.zsh.org/) with [Oh My Zsh](https://ohmyz.sh/). Oh My Zsh provides a useful default configuration, a large collection of optional plugins and themes, and automatic terminal titles.

Automatic titles are particularly useful in Treeport: an idle shell terminal can show its current directory instead of only `zsh`. Treeport separately captures the complete command while supported interactive shells run it.

Follow the [official Oh My Zsh installation instructions](https://github.com/ohmyzsh/ohmyzsh#getting-started). Leave its automatic title support enabled; setting `DISABLE_AUTO_TITLE=true` disables the title behavior described above.

## Other shells and configurations

This recommendation is optional. Bash, fish, plain zsh, and other shell configurations remain normal Treeport terminals. Interactive zsh, Bash, and fish receive best-effort command-title integration, while unsupported configurations fall back to the foreground executable name.

If you configure titles yourself, publish a concise title with OSC `0` or `2`. See the [terminal signals reference](/reference/terminal-signals/) for details.
