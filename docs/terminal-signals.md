# Terminal signals and progressive enhancement

TaskTTY runs normal terminal applications. It does not need an application-specific integration to keep a process alive, render its TUI, or let the user reconnect.

Applications can optionally publish additional terminal signals so TaskTTY can provide richer status and attention behavior.

## Capability levels

### Baseline: process lifecycle

Every TaskTTY terminal provides:

* persistent process execution;
* running or exited status;
* exit code where available;
* terminal rendering and input;
* reconnect from another browser or device.

No application integration is required.

### Terminal title

Applications may set the terminal title using standard terminal title sequences.

TaskTTY can display the observed title as contextual information.

Useful examples include:

```text
Implementing authentication
Waiting for review
PR #123
PR MERGED
Development server
```

Titles should be concise and describe the most useful current state of the terminal.

Applications should not assume that the title is durable. It is runtime metadata and may be reset after the daemon or observer restarts.

### BEL attention

Applications may emit the terminal BEL character:

```text
\u0007
```

TaskTTY treats a real BEL as an attention signal.

Suitable uses include:

* the application is waiting for user input;
* a long-running operation finished;
* checks passed or failed;
* approval is required;
* an error needs attention.

BEL should be emitted for meaningful transitions rather than continuously.

TaskTTY may show unread attention until the corresponding terminal is viewed or explicitly acknowledged.

### OSC progress

Applications may publish progress through OSC `9;4`.

TaskTTY uses this to distinguish active work from an idle or cleared state.

An active progress signal should be refreshed periodically. TaskTTY may expire progress that has not been refreshed, because an application can crash or stop emitting updates without sending an explicit clear.

Applications should emit an explicit clear when work finishes whenever possible.

Progress is optional. The absence of progress does not mean that the process is idle, finished, or unsupported.

### Process exit

When the foreground process exits, TaskTTY reports its exited state and exit code where available.

Applications that return to a shell after completion will remain represented as running because the shell itself is still active.

## Progressive enhancement

TaskTTY’s interface should improve as applications provide more information:

```text
No integration
└── Pi — running

Title only
└── Pi — PR #123

Title + progress
└── Pi — PR #123 · working

Title + progress + BEL
└── Pi — PR #123 · needs attention
```

None of these signals is required for terminal persistence or control.

## Application responsibilities

Applications and extensions should publish semantic state they understand better than TaskTTY does.

For example, a Pi extension may:

* update the title when a pull request is created or merged;
* emit progress while Pi is working;
* clear progress when it is waiting;
* emit BEL when checks pass or user action is required.

TaskTTY should not independently duplicate that same provider-specific state unless it has a separate product reason to do so.

## TaskTTY responsibilities

TaskTTY owns:

* observing supported terminal signals;
* presenting them consistently;
* synchronizing attention across connected clients;
* avoiding stale state where possible;
* degrading gracefully when signals are absent;
* documenting the supported protocols.

TaskTTY does not guarantee that arbitrary terminal applications publish accurate semantic state.

## Integration guidance

Prefer standard terminal protocols before adding a TaskTTY-specific integration.

Use:

1. process lifecycle for universal status;
2. terminal titles for short semantic context;
3. BEL for attention;
4. OSC progress for active or idle transitions;
5. TaskTTY CLI or API only when structured lifecycle operations are required.

A provider-specific TaskTTY integration should be introduced only when standard terminal mechanisms cannot represent the needed behavior safely.
