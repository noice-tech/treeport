---
title: Tree-friendly development
description: Run an independent copy of your application in each Tree.
---

A Tree is most useful when it can run an independent copy of the application.

## Prevent port conflicts

Do not configure all development servers to use one fixed port.

Accept a port in a command option or environment variable. Alternatively, select an unused port automatically.

Print the selected URL so another tool can open it.

If the application has multiple processes, use one development command. Configure that command to select a compatible group of ports.

Do not stop an existing process without approval to resolve a port conflict. The process can belong to another active Tree.
