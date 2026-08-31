# Experimental direct-PTY terminal backend

## Status

This backend is an experimental development option. Tmux remains the default backend.

Set `TREEPORT_EXPERIMENTAL_TERMINAL_BACKEND=direct-pty` before the daemon starts to enable the backend.

## Design

The daemon owns one `node-pty` process for each terminal. Browser attachments do not create PTYs and do not start tmux.

Each PTY has one `@xterm/headless` terminal model. The model keeps 50,000 history lines and supplies terminal capture data.

A new attachment receives a serialized model snapshot in its `ready` event. The daemon then sends ordered live output on a new stream.

The browser hides the terminal while xterm parses the snapshot. It shows the completed frame after the write callback runs.

Direct-mode browser terminals use 50,000 local scrollback lines. Wheel scrolling, the viewport, and selection stay in the browser.

The current browser controller owns terminal query responses. The headless model has stdin disabled and cannot answer queries.

Serialized history contains terminal state, not the original query sequences. Therefore, snapshot replay cannot answer an old query.

Each client keeps a bounded unacknowledged output window. The daemon disconnects a stalled direct-mode client instead of pausing the child PTY.

Input and resize operations use the existing controller lease. A resize changes the real PTY and the canonical headless model once.

The headless model observes title, progress, and BEL sequences. The existing metadata manager publishes and stores these events.

## Deliberate limitations

- A daemon restart stops all direct PTYs. Treeport creates replacement terminals during reconciliation.
- Direct sessions exist only in daemon memory. This experiment does not restore child processes after a daemon restart.
- The browser controller answers terminal queries. Queries do not receive answers while no controller is attached.
- Tmux copy mode and server-side selection do not exist in direct mode.
- This slice does not add panes, windows, layouts, or prefix keys.
