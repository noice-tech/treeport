# Decision 0010: Playwright hosts first-class Browser panel sessions

- Status: Accepted
- Date: 2026-08-24

## Context

Treeport must open daemon-local applications and sites that prevent iframe use.

Users and agents must share one page without exposing Playwright, CDP, or a personal browser profile.

A package web panel cannot own the required Treeport lifecycle and authorization directly.

## Decision

Add `BrowserPanel` with kind `browser` to the `Panel` union.

Store Browser panels separately from terminal and web-panel storage. Do not add a generic panel storage layer.

Browser panels use the existing tree ownership, workspace route, sidebar, title, shortcut, event, open-request, and close workflows.

Keep the iframe Browser web panel and its definition identity.

Remove the daemon Browser implementation from the web-panel package. Remove its privileged permission and MessagePort bridge.

Put the Browser toolbar, server list, streamed viewport, and accessible controls in the Treeport web application.

### Browser ownership

Each Browser panel owns one daemon Playwright process, one persistent context, and one page.

The context uses a Treeport runtime directory. Treeport deletes this directory when the session closes or resets.

Treeport never imports, copies, or opens a personal browser profile.

The target runs as a top-level Chromium page. Treeport does not add a reverse proxy.

The daemon stores the current top-level URL and title on the Browser panel record.

The daemon restores the URL before it accepts the first client or agent command.

A daemon restart creates a new empty browser context and restores only the saved URL.

### Authorization and transport

A client requests a one-use connection ticket for a Browser panel.

The daemon checks the Browser panel and its owning tree before it issues or accepts the ticket.

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

Modifier-click on an HTTP or HTTPS terminal link creates a Browser panel in the terminal's tree.

The server validates the URL. It rejects credentials and unsupported protocols.

The open request selects the new panel only in a window that shows the source terminal.

A browser popup creates another Browser panel in the same tree.

The popup open request selects the new panel in a window that shows the source Browser panel.

File links continue to use the desktop file flow.

### Data removal and accessibility

Resetting or closing a Browser panel requires user confirmation before Treeport deletes browser data or live state.

The Treeport browser controls have accessible names and keyboard operation.

The JPEG viewport does not provide semantic accessibility information.

The agent snapshot command supplies a separate semantic page view.

Audio, downloads, file selection, uploads, and clipboard synchronization remain unsupported.

## Consequences

Browser panels are durable Treeport resources instead of package web-panel instances.

Package permission grants no longer authorize daemon browser access.

HTTP links and browser popups stay inside the Treeport workspace.

Each active Browser panel uses a separate browser process and more memory than a shared browser context.
