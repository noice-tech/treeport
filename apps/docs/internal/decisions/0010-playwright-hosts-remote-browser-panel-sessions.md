# Decision 0010: Playwright hosts Remote Browser panel sessions

- Status: Accepted
- Date: 2026-08-14

## Context

A normal cross-origin iframe does not let Treeport observe the target's exact location. Cooperative URL messages require target-application source changes and do not work for applications such as Remotion Studio. A browser running on the remote client also interprets localhost as the client computer instead of the Treeport daemon host.

Treeport needs a separate Remote Browser panel to reach daemon-host development servers, report browser navigation without target cooperation, remain shareable between clients and agents, and preserve the existing web-panel workspace model.

## Decision

The existing client-side Browser keeps its iframe implementation and definition identity. The Remote Browser is a second web panel in the same package. Its toolbar and streamed viewport run in the existing opaque panel iframe. A private MessagePort bridge connects that first-party package to a daemon BrowserSessionManager after server-side permission checks.

Each Remote Browser panel owns one daemon-launched Playwright Browser process, one empty BrowserContext, and an active Page. The context is disposable and never uses or attaches to a personal browser profile. The daemon owns the current address. It restores the address from panel launch data or panel storage before it runs a command. The daemon saves validated top-level address changes in panel storage.

Treeport uses Playwright's supported navigation, input, lifecycle, and browser-binding APIs. A Chromium CDP session supplies navigation history, same-document navigation signals, and bounded screencast frames. Raw Playwright, browser-server, and CDP endpoints do not cross the daemon/web-client boundary.

One bounded scheduler runs control changes, browser commands, agent operations, viewport changes, resets, and closes. The scheduler checks control ownership when each operation runs. It combines queued pointer movement, wheel, and resize operations.

The restricted browser protocol carries navigation commands, input, state, and JPEG frames. The producer limits the frame rate and keeps only its newest queued frame. CDP acknowledgements apply backpressure before Chromium produces more frames. Treeport permits one outstanding frame per client and replaces stale pending frames. A cooperative control lease selects one web client or agent at a time. Inactive clients remain attached but do not require screencast frames.

The official Remote Browser panel requests the reserved `host-browser` permission. Treeport stores explicit source-scoped grants and requires a new confirmation after the source scope or requested permission set changes.

Playwright `Browser.bind()` exposes the same browser through a local endpoint to Treeport's pinned Playwright Agent CLI. Treeport invokes the CLI on the daemon host through a command whitelist and does not send the endpoint to web clients. Playwright Dashboard remains a development tool, not an embedded product dependency.

Remote browser tabs remain pages inside the Remote Browser web panel. They do not add a new Treeport workspace panel kind. The visual transport can move from Playwright screencast to WebRTC later without changing browser ownership, permissions, or the web-panel boundary.

## Consequences

Remote Browser panels can open daemon-local services and observe History API navigation without target changes. User and agent actions operate on the same isolated page. Sessions use more memory than shared browser contexts because each panel has an independent process and attachment endpoint.

The daemon now owns a managed Chromium installation and must report missing binaries and system dependencies. Closing, resetting, revoking, or deleting a panel must close its browser and remove temporary state. Audio, downloads, file pickers, and popup windows are outside the first supported version.
