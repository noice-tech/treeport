# Terminal host persistence and lifecycle

## Decision status

Accepted and implemented. This document replaces the experimental daemon-owned design from commit `9745947`.

The experimental design proved these parts:

- One PTY can serve multiple browser clients.
- A headless terminal can supply an atomic attachment snapshot.
- An output sequence can separate snapshot data from live data.
- A slow browser can disconnect without pausing the PTY.

That design did not survive an API daemon restart and retained concepts from the previous runtime.

Treeport uses one detached terminal host for each Treeport data directory. The terminal host is the only terminal process and canonical-state owner.

## Process boundary

The API daemon starts or adopts the terminal host. The host continues when the API daemon exits.

The terminal host owns these resources for each terminal:

- one `node-pty` process;
- one `@xterm/headless` model;
- one bounded parser queue;
- terminal identity and launch metadata;
- terminal size, status, exit code, and output sequence;
- title, command, progress, and BEL metadata.

The API daemon owns browser connections and controller leases. It does not own terminal child processes or canonical terminal state.

A normal API daemon shutdown only closes its IPC connection. It does not send a terminal-host shutdown request.

An explicit product cleanup can kill one terminal or all terminals for one worktree. A separate explicit request can stop an empty host.

## Discovery and local authentication

The data directory identifies one terminal host. Treeport hashes the absolute data directory to make a short host key.

The runtime directory contains a host record. The record contains the protocol version, host identifier, PID, socket path, and start time.

The socket uses a short path below the system temporary directory. Its parent directory and the socket permit access only to the current user.

The data directory contains a random authentication token. The token file permits access only to the current user.

The daemon sends the token in the first IPC frame. The host rejects all other frames before authentication succeeds.

The daemon uses this discovery sequence:

1. Read the host record.
2. Connect to the recorded socket.
3. Authenticate and compare the host identifier.
4. Compare the IPC protocol version.
5. Adopt the host and read its inventory.

If the socket is absent and the recorded PID is absent, remove the stale record and socket. Then, start a new detached host.

If the recorded PID exists but the host does not authenticate, stop the daemon startup. Do not signal that PID.

If a host uses an incompatible protocol, report the incompatibility. Never kill an incompatible host that reports live terminals.

The host process uses `detached: true` and does not keep a parent IPC channel. The daemon calls `unref()` after startup.

## IPC protocol

The IPC protocol uses length-prefixed JSON frames over a local stream socket. Each frame has a bounded byte length.

The current protocol version is `3`. Each frame contains a version and one of these message shapes:

- a request identifier, method, and input;
- a request identifier and result;
- a request identifier and structured error;
- an event name and event data.

The protocol supports handshake, create, inventory, atomic attach, output detach, runtime subscription, state, resize, capture, rename, process inspection, input, query-authority transitions, signal, terminal/worktree kill, and empty-host shutdown.

The host emits ordered output and runtime events. Runtime events carry title, command, progress, BEL, and exit changes. The daemon can reconnect and create new attachments after adoption.

Requests that mutate or observe terminal control state remain ordered on each connection. A terminal-specific kill waits for preceding control work, performs logical removal, and then leaves its response pending while physical cleanup runs outside that control queue. Requests for unrelated terminals can therefore complete out of order and are correlated by request identifier. Worktree-wide kill remains an ordered barrier, and shutdown stops admission and drains all cleanup before the host exits.

The host keeps terminal metadata in memory. Therefore, terminal inventory and canonical history survive API daemon replacement.

The host starts ordinary login shells directly. It does not start a second Node.js launcher for these terminals.

The host uses the launcher for setup tasks and command fallback. This path preserves setup output and fallback signal behavior.

The host does not survive its own crash or a computer restart. Treeport can create replacement terminals after either event.

## Atomic attachment

The daemon's atomic `attach` request installs its output subscription before taking a snapshot. The host completes these actions as one ordered operation:

1. Subscribe the attachment to terminal output.
2. Record the current output sequence as the fence.
3. Drain all parser work through the fence.
4. Serialize the active screen, alternate screen, cursor state, modes, and scrollback.
5. Send the snapshot result.
6. Send only output with a sequence greater than the fence.

The daemon buffers output events that arrive before the attach response, with a strict byte limit. It sends the snapshot to the browser before only the buffered events whose owner sequence is greater than the fence.

Each browser stream gets its own sequence and acknowledgement window. A reconnect performs a new atomic attach and establishes a new fence.

The browser resets its local model and parses the snapshot while its terminal is hidden. It shows the terminal after the snapshot write callback.

Browser readiness means that xterm rendered the snapshot and applied focus. A socket `ready` event alone does not make the browser ready.

The browser then parses ordered live output. Snapshot replay cannot contain an old terminal query.

Kitty image data belongs to each browser client. Snapshot serialization does not include image data. A new client receives only subsequent image output.

## Terminal query authority

Exactly one emulator can answer terminal queries at one time.

The headless model answers queries when no ready browser controller exists. This behavior keeps detached programs functional.

A browser controller becomes the authority only after it parses its snapshot through the attachment fence. The host pauses the PTY for this short transition.

The host drains its parser before it disables headless responses. It then records the browser attachment and output fence as the authority.

Only input from the current authority generation can carry a browser terminal response. Other browser responses are rejected.

Before a normal handoff, the host pauses at a drained parser fence. The new browser enables responses and acknowledges that transition before the host disables headless responses and resumes output.

When the last controller disconnects, the host pauses the PTY and drains its parser. The headless model becomes the authority before the PTY resumes.

Historical snapshots use a headless model with responses disabled during serialization. Thus, snapshot replay cannot answer a query.

Tests must cover detached authority, attached authority, browser handoff, and return to detached authority.

## Bounded output

The host receives PTY output in chunks. It does not create one IPC message for each byte.

Each terminal has a parser high watermark and a parser low watermark. The host pauses only that terminal PTY at the high watermark.

The host resumes the PTY after the canonical parser reaches the low watermark. Browser speed never controls this pause.

Each host IPC connection and each browser connection has a separate byte limit. Treeport disconnects a slow connection when its limit is reached.

A disconnected viewer can recover from a new snapshot. Other viewers and the child process continue.

## Shell metadata

Treeport shell integration must not invoke another terminal multiplexer.

The zsh, bash, and fish integrations preserve the user startup sequence. They emit a Treeport-owned OSC command event at pre-execution and prompt boundaries.

The terminal host parses that event and removes control characters from its value. It limits the command value to 256 characters.

Applications can continue to use OSC 0 or OSC 2 for terminal titles. They can continue to use OSC 9;4 for progress.

The terminal host observes BEL directly. Process and listener discovery starts from the hosted PTY PID and follows the operating-system process tree.

## Data migration and cutover

Active records use `terminalId` and `worktreeId`. A terminal does not need a second session name or a worktree socket name.

A database migration removes the active historical `tmux_socket_name` worktree column. Historical migration files and this migration note retain that name only to describe the cutover.

Shared and API records remove the historical `tmuxSocketName` and `tmuxSessionName` fields. Resumable cleanup uses the existing worktree identifier.

The cutover preserves projects, worktrees, panels, presets, operations, and settings. It deliberately does not adopt live terminals from the pre-cutover runtime; those processes remain outside Treeport after upgrade and can be stopped separately.

There is no runtime switch or dual backend. Treeport starts and operates without an external terminal multiplexer.

## Terminal creation boundary

Terminal creation verifies only the selected launch target. It does not discover or reconcile unrelated Git worktrees.

The check verifies the stored path, repository identity, Git common directory, and Git worktree key. The PTY spawn remains the final path check.

A terminal tab represents a PTY that the host owns. The web application does not add a temporary terminal tab before host creation.

Terminal creation and terminal cleanup use independent mutation lanes. Cleanup remains ordered with destructive worktree mutations, but a backlog of terminal removals does not delay new PTY creation.

Removal has two phases. Logical removal synchronously detaches the session from inventory, listeners, parser state, and canonical terminal resources. Physical cleanup then removes any launcher spec and terminates the PTY process tree, including the graceful SIGTERM/SIGKILL escalation period. The session manager owns every pending physical-cleanup promise: terminal and worktree kill callers observe its result, and shutdown drains cleanup even if the requesting socket disconnects.

Ordering is preserved for operations targeting the same terminal. Unrelated creation can proceed after a kill's logical phase while that old terminal's physical cleanup remains pending. Worktree-wide kill and host shutdown retain draining, exclusive semantics.

The browser removes closed terminals immediately from its authoritative project cache, applies repeated `terminal.removed` events idempotently, and recovers with a project refresh only when the target worktree is missing. It submits rapid close requests in order so pending HTTP/1 responses cannot consume the browser's entire per-origin connection pool and starve terminal creation.

Measure creation from the new-terminal command to output from input in the new xterm. Use warm p95 of 250 ms as the local target. The benchmark's delete/recreate churn profile also verifies that replacement latency does not form a 500 ms staircase behind old process cleanup.

## Verification boundaries

Behavior coverage includes real API daemon crash and normal restart adoption, atomic snapshot/live fencing, normal and alternate screens, Unicode, resize/reflow, large history, detached/attached/handoff query authority, bounded parser and viewer queues, local browser scrolling and selection, shell startup metadata, descendant process termination, and replacement creation while terminal cleanup is deliberately stalled.
