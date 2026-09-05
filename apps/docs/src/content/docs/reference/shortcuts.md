---
title: Shortcuts
description: Use Treeport shortcuts and terminal controls.
---

The macOS desktop client can reserve application shortcuts.

In a browser, shortcuts for windows, tabs, history, and numbered tabs stay under browser control.

Treeport shortcuts work when Treeport has keyboard focus. An embedded web panel can process keys in its own frame.

This page includes only Treeport-specific operations.

## Use application shortcuts

| Action                           | Browser                                                    | macOS desktop           |
| -------------------------------- | ---------------------------------------------------------- | ----------------------- |
| Switch project                   | `Cmd+Shift+P` on Apple keyboards; `Ctrl+Shift+P` elsewhere | `Cmd+Shift+P`           |
| Select the previous tree         | Use the sidebar                                            | `Cmd+Shift+[`           |
| Select the next tree             | Use the sidebar                                            | `Cmd+Shift+]`           |
| Select a tab in the active group | Use the sidebar                                            | `Cmd+1` through `Cmd+9` |
| Create a tree in a repository    | Use **New tree**                                           | `Cmd+N`                 |
| Open a tab in the active group   | Use **New panel**                                          | `Cmd+T`                 |
| Open the global panel picker     | Use **New panel**                                          | `Cmd+Shift+T`           |
| Toggle the side panel            | `Option+Cmd+B` on Apple keyboards; `Ctrl+Alt+B` elsewhere  | `Option+Cmd+B`          |
| Close a tab in the active group  | Use its close operation                                    | `Cmd+W`                 |
| Go back or forward               | Use browser history                                        | `Cmd+[` or `Cmd+]`      |

The tree shortcuts follow the sidebar order and continue at the opposite end.

Treeport has a terminal tab group and a tool tab group. The focused group is the active tab group.

A focus outline shows the active tab group. Numbered selection operates only in that group.

Only the first nine tabs in each group have numbered shortcuts.

Drag a terminal row or tool tab to change its position. Treeport saves the order and shares it with connected clients.

For a focused terminal row, press `Alt+Shift+Up` or `Alt+Shift+Down` to move it.

For a focused tool tab, press `Alt+Shift+Left` or `Alt+Shift+Right` to move it.

In the terminal tab group, `Cmd+T` creates a shell immediately.

In the tool tab group, `Cmd+T` opens the tool picker.

`Cmd+Shift+T` always opens the global **New panel** picker. You can select Shell, a preset, Browser, or a web panel.

Select the side panel button to open or hide the side panel with a mouse.

`Cmd+W` closes the selected tab in the active tab group. It uses the standard close safeguards.

Treeport can request approval before it stops a foreground process or deletes panel data. A tree always keeps at least one terminal.

## Take terminal control

Only one connected client can control a terminal. Other clients continue to receive output and show **Viewing**.

Click, tap, type, paste, or use a terminal control to request control.

The client shows **Taking control…** during the transfer.

When the label disappears, that client controls terminal input. The prior controller changes to **Viewing**.

Assistive technology announces **Controlling terminal**.

The operation that requested control can occur before the transfer completes.

Wait until **Taking control…** disappears before you repeat important input.

## Shared terminal size

A terminal has one row-and-column grid for all clients.

The controlling client sets this grid when it takes control or changes the terminal area size.

A size change on a viewing client does not change the shared grid.

Viewing clients show the controller grid. They reduce the font size when necessary to fit it.

When a different device takes control, the terminal layout can change for all clients.

## Selection, scrolling, and clipboard

### Use a pointer or keyboard

Drag across terminal output to select text.

Selection also works when a terminal application has mouse reporting enabled.

Drag above or below the terminal to extend the selection through browser-owned history.

Scroll up to read the browser terminal's local scrollback.

Treeport shows **Scrolled back** while new output continues outside the visible area.

If text is selected, Treeport keeps the selection while new output continues.

- Select **Follow latest** to show current output when no selection is active.
- Select **Clear** to remove the selection and show current output.
- Reach the end of history to show current output when no selection is active.
- Start a new selection or use **Clear** to replace the retained selection.

Use the shown **Copy** and **Clear** controls or the standard client clipboard commands.

Use the standard terminal paste operation for text. Treeport does not replace browser clipboard shortcuts.

### Use touch controls

Swipe with one finger to scroll through terminal history.

Touch and hold with one finger to start text selection. Then, drag to extend the selection.

Select **Copy** or **Clear** when the selection controls appear.

Use the **Paste** terminal control to open the paste interface.

Use the **Upload** terminal control to choose one or more photos or files.

Alternatively, touch and hold with two fingers to open the paste interface.

If the browser cannot read the clipboard, paste into the editable field. Then, send the text from that field.

## Open links and transfer files

### Open links

On a touch screen, tap a link in terminal output.

On an Apple keyboard, press `Cmd` and select a link.

On other keyboards, press `Ctrl` and select the link.

HTTP and HTTPS links open outside the terminal.

A `file:` link opens in the default system application only in the macOS desktop client.

A browser client does not open terminal `file:` links.

### Drop, paste, or upload files

Take control before you drop files on a terminal. Also take control before you paste files or clipboard images.

When the client and Treeport run on the same computer, Treeport can paste the original file path without an upload. The desktop client uses this operation for local connections. A browser uses this operation only when its platform supplies a trusted absolute path.

For a remote connection, Treeport uploads each file to the backend. It also uploads the file when the client cannot get a trusted absolute path. Treeport then pastes the temporary backend path into the terminal.

Treeport quotes multiple paths. Thus, spaces and shell-special characters do not make the paths ambiguous.

One transfer can contain a maximum of eight files. Each file can have a maximum size of 50 MiB.
