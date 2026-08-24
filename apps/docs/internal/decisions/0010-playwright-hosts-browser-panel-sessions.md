# Decision 0010: Browser uses native Electron and daemon Playwright sessions

- Status: Accepted
- Date: 2026-08-24

## Context

Treeport must open daemon-local applications and sites that prevent iframe use.

Web users and agents must share one daemon page without exposing Playwright, CDP, or a personal browser profile.

Desktop users need native Chromium rendering for audio, graphics, and normal page behavior.

A package web panel cannot own the required Treeport lifecycle and authorization directly.

## Decision

Add `BrowserPanel` with kind `browser` to the `Panel` union.

Store `BrowserPanel` records separately from terminal and web-panel storage. Do not add a generic panel storage layer.

Browser uses the existing tree ownership, workspace route, sidebar, title, shortcut, event, open-request, and close workflows.

Keep iframe Browser and its definition identity.

Remove the daemon Browser implementation from the web-panel package. Remove its privileged permission and MessagePort bridge.

Put the Browser toolbar, server list, viewport boundary, and accessible controls in the Treeport web application.

Use a native Electron `WebContentsView` for the desktop app. Use the streamed Playwright viewport for web clients.

### Browser ownership

Each web-client or agent session owns one daemon Playwright process, one persistent context, and one page.

The context uses a Treeport runtime directory. Treeport deletes this directory when the session closes or resets.

Treeport never imports, copies, or opens a personal browser profile.

The target runs as a top-level Chromium page. Treeport does not add a reverse proxy.

The daemon stores the current top-level URL and title on the `BrowserPanel` record.

The daemon restores the URL before it accepts the first client or agent command.

A daemon restart creates a new empty browser context and restores only the saved URL.

### Desktop rendering

Electron creates one `WebContentsView` for each active Browser.

Each view uses a separate in-memory partition. It never uses a personal browser profile.

The Treeport renderer sends validated commands, visibility, and viewport bounds through the desktop preload bridge.

The Electron main process accepts these messages only from the active Treeport guest and its selected origin.

The native view allows HTTP and HTTPS navigation without credentials. It rejects unsupported navigation and permission requests.

Electron routes popups through durable Browser creation. It runs `beforeunload` when the user closes Browser.

The native page and a daemon agent session are separate runtimes. They synchronize the saved top-level URL and title.

### Authorization and transport

A client requests a one-use connection ticket for Browser.

The daemon checks the `BrowserPanel` record and its owning tree before it issues or accepts the ticket.

The socket protocol contains validated browser commands, state, and JPEG frames.

Treeport does not expose raw Playwright, CDP, or debugging endpoints.

The frame limit is 8 MiB. CDP production is limited to 15 frames each second.

Each client acknowledges one frame before the daemon sends another frame.

The daemon retains only the newest pending frame for each client.

### Control and queues

One bounded scheduler serializes user input, navigation, resize, reset, close, and agent operations.

The scheduler accepts at most 64 operations. It reserves capacity for required lifecycle operations.

Pointer moves, wheel input, viewport resize, and screencast state use coalescing keys.

Queued input checks control ownership again when it runs.

An agent temporarily owns control while its command runs. The scheduler restores a connected user owner afterward.

### Links and popups

Modifier-click on an HTTP or HTTPS terminal link opens Browser in the terminal's tree.

The server validates the URL. It rejects credentials and unsupported protocols.

The open request selects the new panel only in a window that shows the source terminal.

A browser popup opens another Browser in the same tree.

The popup open request selects the new Browser in a window that shows the source Browser.

File links continue to use the desktop file flow.

### Data removal and accessibility

Reset requires confirmation before Treeport deletes browser data and opens an empty session.

Close runs the page-close handlers without a Treeport data warning. Treeport requests confirmation only when `beforeunload` requests it.

The Treeport browser controls have accessible names and keyboard operation.

The JPEG viewport does not provide semantic accessibility information.

The agent snapshot command supplies a separate semantic page view.

The streamed web-client viewport does not support audio, downloads, file selection, uploads, or clipboard synchronization.

## Consequences

Browser is a durable Treeport resource instead of a package web-panel instance.

Package permission grants no longer authorize daemon browser access.

HTTP links and browser popups stay inside the Treeport workspace.

Each active daemon Browser session uses a separate browser process and more memory than a shared browser context.

Each active desktop Browser uses a separate native view and in-memory partition.
