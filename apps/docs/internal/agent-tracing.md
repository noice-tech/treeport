# Agent-readable tracing

This document describes the internal tracing mode for performance investigations.
This mode is not a supported user interface.

Treeport disables trace export by default.
Treeport does not start or require a dashboard.

## Output

Set `TREEPORT_TRACE=jsonl` to enable OpenTelemetry span export.
Treeport writes one JSON object for each completed span.
Each object has stable correlation fields, span timing, status, and approved attributes.

Set `TREEPORT_TRACE_FILE` to an absolute path to write a private JSONL file.
If you omit this variable, the daemon writes JSONL records to standard error.
The detached terminal host cannot use daemon standard error.
Use a file to capture terminal-host spans.

The exporter permits only approved HTTP and `treeport.*` attributes.
It does not export span events, terminal content, commands, environment values, or error messages.
The file mode is `0600`.

The application `ManagedRuntime` owns the `@effect/opentelemetry` `NodeSdk` layer.
The terminal host owns a separate trace runtime for its process.
Each runtime flushes and shuts down its span processor before its scope closes.

## Capture issue 369

Run these commands from the required worktree:

```sh
TRACE_FILE="$(pwd)/apps/treeport/.treeport-dev/issue-369-trace.jsonl"
rm -f "$TRACE_FILE"
TREEPORT_TRACE=jsonl TREEPORT_TRACE_FILE="$TRACE_FILE" pnpm dev
```

If Treeport runs in a persistent terminal, apply the variables to that terminal command.
Do not apply them to another worktree daemon.

Enable Browser events in the application DevTools console:

```js
localStorage.setItem('treeport.trace', 'jsonl')
location.reload()
```

Keep the console open and preserve log records.
Browser records use `treeport.browser.trace` as their `type` value.
Server records use `treeport.trace.span` as their `type` value.

Complete this sequence:

1. Open a tree that has one terminal.
2. Press `Cmd+T` 10 times quickly.
3. Close the 10 new terminals quickly.
4. Press `Cmd+T` 10 times quickly.
5. Stop Treeport normally to force the final trace flush.

Save the Browser console as JSONL if the Browser timeline is required.
The `correlationId` in Browser output equals the HTTP `treeport.request.id` attribute.
Use `terminalId` to correlate render, attachment, and focus events.

Inspect the server and terminal-host waterfall:

```sh
jq -s '
  sort_by(.timestamp)
  | map(select(
      .name
      | test("terminal|mutation|http")
    ))
  | map({
      timestamp,
      service,
      traceId,
      spanId,
      parentSpanId,
      name,
      durationMs,
      attributes
    })
' "$TRACE_FILE"
```

Compare these values between the first and second bursts:

- Browser command-to-request time;
- HTTP request duration;
- `treeport.mutation.wait` duration;
- `treeport.mutation.queue_wait_ms` on execution spans;
- daemon-to-host IPC duration;
- terminal-host request queue time;
- PTY create or remove duration;
- attachment, render, and focus timestamps.

## Correlation boundaries

The Browser supplies a random request ID for terminal create and remove requests.
The HTTP span records that ID without recording request bodies.
The daemon sends the active trace and parent span IDs through authenticated terminal-host IPC.
The terminal host then creates a child span in the same trace.

The Browser emits events instead of OpenTelemetry spans.
This avoids a Browser exporter and keeps tracing opt-in without a collector.

## Blind spots

The first Browser event occurs after the desktop command reaches the React callback.
The trace cannot measure delay inside Electron command dispatch before that callback.

The server HTTP span starts when Effect admits the request handler.
Compare its timestamp with the Browser request event to infer Browser connection wait.

Browser and server clocks can differ.
Use durations within one process when clock synchronization is uncertain.

A terminal host that started without file tracing cannot export host spans.
A host from an older build also omits these spans.
Start a new host with the trace variables before the reproduction.
