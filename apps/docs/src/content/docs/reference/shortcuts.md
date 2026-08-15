---
title: Shortcuts
description: Use Treeport shortcuts and non-obvious terminal interactions.
---

Treeport can reserve application shortcuts in the macOS desktop client. In a browser, new-window, new-tab, reopen-tab, close-tab, numbered-tab, and history shortcuts remain browser-owned. Treeport shortcuts work when Treeport itself has keyboard focus; an embedded web panel can handle keys inside its own frame.

This page lists Treeport-specific commands. Standard terminal, browser, and operating-system shortcuts are not included.

## Shortcut reference

| Action                                   | Browser                                                    | macOS desktop           |
| ---------------------------------------- | ---------------------------------------------------------- | ----------------------- |
| Switch project                           | `Cmd+Shift+P` on Apple keyboards; `Ctrl+Shift+P` elsewhere | `Cmd+Shift+P`           |
| Select numbered panel 1–9                | Use the sidebar                                            | `Cmd+1` through `Cmd+9` |
| Create a worktree                        | Use **New worktree**                                       | `Cmd+N`                 |
| Create a shell terminal                  | Use **New panel**                                          | `Cmd+T`                 |
| Choose a new panel                       | Use **New panel**                                          | `Cmd+Shift+T`           |
| Close the selected terminal or web panel | Use its close action                                       | `Cmd+W`                 |
| Go back or forward                       | Use browser history                                        | `Cmd+[` or `Cmd+]`      |

Numbered selection follows the terminal and web panel order in the selected worktree. Only the first nine entries have numbered shortcuts.

`Cmd+T` creates a shell immediately. `Cmd+Shift+T` opens **New panel**, where you can choose Shell, a preset, or a web panel.

`Cmd+W` keeps the normal close safeguards. Treeport can ask for confirmation before it stops a foreground process or deletes stored web panel data. A worktree always keeps at least one terminal.

## Terminal control

At most one attached client controls a terminal at a time. Other clients continue to receive output and show **Viewing**.

Clicking, tapping, typing, pasting, or using a terminal accessory control requests control. The client shows **Taking control…** during the transfer. When the badge disappears, that client controls terminal input, and the previous controller changes to **Viewing**. Assistive technology announces **Controlling terminal**.

The action that requests control might not reach the terminal. Wait for **Taking control…** to finish before you repeat important input.

## Shared terminal size

A terminal has one shared row-and-column grid across all attachments. The controlling client sets that grid when it takes control or when its terminal area changes size. Resizing a viewer does not change the shared terminal.

Viewers render the controller's grid and reduce the font size when needed to fit it. Taking control from a differently sized device can therefore reflow the terminal for all attached clients.

## Selection, scrolling, and clipboard

### Pointer and keyboard

Drag across terminal output to select text. Selection also works when a terminal application has mouse reporting enabled. Drag above or below the terminal to extend the selection through tmux history.

Scrolling up enters tmux history. Treeport shows **Scrolled back in tmux** while new output continues outside the visible area. If a selection is active, Treeport preserves it while new output continues.

- **Follow latest** returns to live output when no selection is active.
- **Clear** in the scrollback status clears the selection and returns to live output.
- Reaching the end of history returns to live output when no selection is active.
- Terminal input, paste, a terminal click, or a new selection clears the retained selection.

Use the displayed **Copy** and **Clear** actions or your client's normal clipboard commands. Use the normal terminal paste action for text. Treeport does not replace browser-owned clipboard shortcuts.

### Touch

Swipe with one finger to scroll terminal history. Touch and hold with one finger to start text selection, then drag to extend it. Use **Copy** or **Clear** when the selection actions appear.

Use the **Paste** terminal accessory action, or touch and hold with two fingers, to open the paste interface. If the browser cannot read the clipboard directly, paste into the editable field and send the text from there.

## Links and files

### Open links

Use `Cmd`-click on an Apple keyboard or `Ctrl`-click elsewhere to open a link in terminal output. HTTP and HTTPS links open outside the terminal.

A `file:` link opens with the system default application only in the macOS desktop client. Treeport does not open terminal `file:` links from a browser.

### Drop or paste files

Take control before you drop files on a terminal or paste files or clipboard images. Treeport uploads them to the backend and pastes their temporary backend paths into the terminal. This makes a file from a browser or remote device readable to a command that runs on the backend computer.

Each transfer can contain up to eight files. Each file can be up to 50 MiB.
