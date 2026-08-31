# Terminal host persistence and lifecycle

## Decision status

This document replaces the experimental daemon-owned design from commit `9745947`.

The experimental design proved these parts:

- One PTY can serve multiple browser clients.
- A headless terminal can supply an atomic attachment snapshot.
- An output sequence can separate snapshot data from live data.
- A slow browser can disconnect without pausing the PTY.

The design did not survive an API daemon restart. It also kept tmux names, paths, browser behavior, and service abstractions.

Treeport will use one detached terminal host for each Treeport data directory. The terminal host is the only terminal process owner.

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

The first protocol version is `1`. Each frame contains a version and one of these message shapes:

- a request identifier, method, and input;
- a request identifier and result;
- a request identifier and structured error;
- an event name and event data.

The protocol supports these requests:

- `handshake`;
- `create`;
- `inventory`;
- `attach` and `detach`;
- `input`;
- `resize`;
- `capture`;
- `metadata`;
- `processes`;
- `signal` and `kill`;
- `killWorktree`;
- `queryAuthority`;
- `shutdown`.

The host emits ordered output, metadata, query-authority, and exit events. The daemon can reconnect and create new attachments after adoption.

The host keeps terminal metadata in memory. Therefore, terminal inventory and canonical history survive API daemon replacement.

The host does not survive its own crash or a computer restart. Treeport can create replacement terminals after either event.

## Atomic attachment

Each host attachment has an identifier and a bounded output queue. The host completes these actions as one ordered operation:

1. Subscribe the attachment to terminal output.
2. Record the current output sequence as the fence.
3. Drain all parser work through the fence.
4. Serialize the active screen, alternate screen, cursor state, modes, and scrollback.
5. Send the snapshot result.
6. Send only output with a sequence greater than the fence.

The host queues output for the attachment while it creates the snapshot. It sends the snapshot result before queued live output.

The daemon preserves the host sequence when it fans output to browser clients. A reconnect starts a new host attachment and a new fence.

The browser resets its local model and parses the snapshot while its terminal is hidden. It shows the terminal after the snapshot write callback.

The browser then parses ordered live output. Snapshot replay cannot contain an old terminal query.

## Terminal query authority

Exactly one emulator can answer terminal queries at one time.

The headless model answers queries when no ready browser controller exists. This behavior keeps detached programs functional.

A browser controller becomes the authority only after it parses its snapshot through the attachment fence. The host pauses the PTY for this short transition.

The host drains its parser before it disables headless responses. It then records the browser attachment and output fence as the authority.

Only input from the current authority generation can carry a browser terminal response. Other browser responses are rejected.

Before a normal handoff, the old authority acknowledges output through the transition fence. The host then enables the new authority.

When the last controller disconnects, the host pauses the PTY and drains its parser. The headless model becomes the authority before the PTY resumes.

Historical snapshots use a headless model with responses disabled during serialization. Thus, snapshot replay cannot answer a query.

Tests must cover detached authority, attached authority, browser handoff, and return to detached authority.

## Bounded output

The host receives PTY output in chunks. It does not create one IPC message for each byte.

Each terminal has a parser high watermark and a parser low watermark. The host pauses only that terminal PTY at the high watermark.

The host resumes the PTY after the canonical parser reaches the low watermark. Browser speed never controls this pause.

Each host attachment and each browser connection has a separate byte limit. Treeport disconnects a slow viewer when either limit is reached.

A disconnected viewer can recover from a new snapshot. Other viewers and the child process continue.

## Shell metadata

Treeport shell integration must not invoke another terminal multiplexer.

The zsh, bash, and fish integrations preserve the user startup sequence. They emit a Treeport-owned OSC command event at pre-execution and prompt boundaries.

The terminal host parses that event and removes control characters from its value. It limits the command value to 256 characters.

Applications can continue to use OSC 0 or OSC 2 for terminal titles. They can continue to use OSC 9;4 for progress.

The terminal host observes BEL directly. It also inspects the foreground process tree through the PTY PID.

## Data migration and cutover

Active records use `terminalId` and `worktreeId`. A terminal does not need a second session name or a worktree socket name.

A database migration removes the active `tmux_socket_name` worktree column. Historical migration files can keep the historical name.

Shared and API records remove `tmuxSocketName` and `tmuxSessionName`. Resumable cleanup uses the existing worktree identifier.

The cutover preserves projects, worktrees, panels, presets, operations, and settings. It does not adopt live terminals from older tmux servers.

After the detached host passes lifecycle tests, remove the experimental switch and all tmux runtime code.

## Implementation order

Use these review boundaries:

1. Add the host process, IPC client, discovery, adoption, and restart tests.
2. Move attachment, metadata, process, and query authority behavior across IPC.
3. Replace shell metadata and browser copy behavior.
4. Migrate active names and remove tmux runtime code.
5. Run the complete validation and source audit.

After each boundary, run the affected lifecycle tests. Inspect the diff for remaining tmux assumptions before the next boundary.
