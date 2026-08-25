# Decision 0010: Browser uses Electron webviews and daemon Playwright sessions

- Status: Accepted
- Date: 2026-08-24

## Context

Treeport must open daemon-local applications and sites that prevent iframe use.

Web users and agents must share one daemon page. Treeport must not expose Playwright, CDP, or a personal browser profile.

Desktop users need native Chromium rendering for audio, graphics, and normal page behavior.

Electron does not support a webview inside another webview. Native views do not follow DOM layout or DOM stacking.

## Decision

Add `BrowserPanel` with kind `browser` to the `Panel` union.

Store `BrowserPanel` records separately from terminal and web-panel storage. Do not add a generic panel storage layer.

Browser uses the existing tree ownership, route, sidebar, title, shortcut, event, open-request, and close workflows.

Replace the former web-panel implementation with the durable Browser resource.

Put the Browser toolbar, server list, viewport boundary, and accessible controls in the Treeport frontend.

Electron packages the same Treeport frontend source that the web build uses. Electron runs this frontend as its top-level renderer.

The renderer uses the selected backend origin. A renderer-session protocol handler supplies only packaged frontend files.

The handler forwards API requests to the selected backend. Socket connections go directly to the selected backend.

Use a first-level Electron `<webview>` when Electron connects to a loopback backend. Use streamed Playwright in all other clients.

### Browser ownership

Each web-client or agent session owns one daemon Playwright process, one persistent context, and one page.

The context uses a Treeport runtime directory. Treeport deletes this directory when the session closes or resets.

Treeport never imports, copies, or opens a personal browser profile.

The target runs as a top-level Chromium page. Treeport does not add a reverse proxy.

The daemon stores the current top-level URL and title on the `BrowserPanel` record.

The daemon restores the URL before it accepts the first client or agent command.

A daemon restart creates a new empty browser context. It restores only the saved URL.

### Desktop rendering

A loopback desktop Browser creates one first-level `<webview>` for each retained Browser panel.

Each webview uses a separate in-memory partition. It never uses a personal browser profile.

The webview stays in one DOM parent for its lifetime. CSS controls its size and retained-panel visibility.

DOM dialogs and popovers paint above the webview. Treeport disables webview pointer input while a blocking dialog is open.

The main process validates each webview attachment. It rejects remote computers, invalid URLs, invalid partitions, and extra guests.

The main process removes supplied preloads. It enforces sandboxing, context isolation, web security, and disabled Node.js integration.

The main process rejects unsupported navigation and permission requests. It routes popups to durable Browser creation.

The main process runs `beforeunload` when the user closes Browser. It clears the temporary partition after a confirmed close.

The local page and a daemon agent session are separate runtimes. They synchronize the saved top-level URL and title.

### Desktop renderer delivery

The desktop renderer uses a separate Electron session partition from Browser guests.

For a selected computer, the renderer URL keeps the computer origin and workspace path.

The renderer-session protocol handler supplies the packaged `index.html` for Treeport route navigations.

It supplies only exact packaged asset paths. It forwards `/api` and all other network requests with Electron `net.fetch`.

It does not run a local HTTP reverse proxy. It does not intercept Browser guest sessions.

The top-level preload exposes computer controls and desktop capabilities. The main process accepts IPC only from this renderer's main frame.

### Authorization and transport

A remote client requests a one-use connection ticket for Browser.

The daemon checks the `BrowserPanel` record and its tree before it issues or accepts the ticket.

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

Close deletes temporary browser data after it runs the page-close handlers. Treeport requests confirmation only when `beforeunload` requests it.

The Treeport browser controls have accessible names and keyboard operation.

The JPEG viewport does not provide semantic accessibility information.

The agent snapshot command supplies a separate semantic page view.

The streamed viewport does not support audio, downloads, file selection, uploads, or clipboard synchronization.

## Consequences

Browser is a durable Treeport resource instead of a package web-panel instance.

Package permission grants no longer authorize daemon browser access.

HTTP links and browser popups stay inside the Treeport workspace.

Each active daemon Browser session uses a separate browser process and more memory than a shared context.

Each retained loopback desktop Browser uses a separate Chromium guest and in-memory partition.

Electron can place Treeport dialogs over Browser without view bounds, clipping, screenshots, or visibility IPC.
