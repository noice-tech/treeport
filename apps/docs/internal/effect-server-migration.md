# Effect network server architecture

This document describes the Effect v3 HTTP, RPC, and WebSocket architecture.
It is an internal architecture record. It is not a supported wire contract.

## Stack

Treeport uses the Effect v3 package line selected in the workspace:

- `effect` 3.22.x;
- `@effect/platform` 0.97.x for HTTP routing, requests, responses, and sockets;
- `@effect/platform-node` 0.108.x for the Node HTTP adapter;
- `@effect/rpc` 0.76.x with NDJSON for typed project event streams;
- `@effect/opentelemetry` 0.64.x with OpenTelemetry 2.x for opt-in trace export;
- Effect Schema for request and protocol validation;
- `ws` as the Node WebSocket implementation used by Effect Socket.

Treeport does not use Hono or Socket.IO. API choices must be checked against
the published Effect v3 documentation and the declarations/source installed
for these versions; Effect v4 `main` examples are not compatible evidence.

`TreeportService` owns the application `ManagedRuntime` and its Layer.
HTTP and RPC handlers run domain Effects in that runtime.
The process resource scope owns the database, terminal host, browser manager,
HTTP server, RPC streams, socket connections, Vite servers, and update polling.

## Preserved contract inventory

| Contract surface                                                                                       | Source of truth and verification surface                                                                                        |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| REST paths, methods, statuses, errors, headers, static files, uploads, and SPA fallback                | `server/app.ts`, `server/app.test.ts`, and request-security tests                                                               |
| CLI HTTP and event behavior                                                                            | `cli/application.ts`, `cli/lifecycle.ts`, `cli/update.ts`, and `cli/index.test.ts`                                              |
| Desktop health negotiation and Browser ownership                                                       | `desktop/src/main.ts`, `desktop/src/browser-webview-policy.ts`, and `desktop/e2e/desktop.spec.ts`                               |
| Ordered project snapshots and events                                                                   | `shared/network-rpc.ts`, `server/rpc-server.ts`, and RPC tests                                                                  |
| Terminal auth, snapshots, ordering, control, binary input, acknowledgements, reconnect, and watermarks | `shared/terminal-protocol.ts`, `server/terminal-attachments.ts`, socket tests, and terminal-session tests                       |
| Browser auth, ownership, command ordering, binary frames, acknowledgements, and reconnect              | `shared/browser-protocol.ts`, `server/browser-sessions.ts`, Browser tests, and desktop E2E                                      |
| Loopback, origin, Tailscale, and upgrade security                                                      | `server/request-security.ts` and request-security tests                                                                         |
| Application and web-panel Vite HMR dispatch                                                            | `server/index.ts`, `core/web-panel-vite-runtime.ts`, and web-panel runtime tests                                                |
| Resource ownership and shutdown                                                                        | `server/index.ts`, application runtime/lifecycle services, socket shutdown tests, and terminal-host lifecycle integration tests |

## HTTP

`server/app.ts` builds the REST and static application with `HttpRouter`.
It preserves the existing paths, methods, status codes, JSON error envelope,
upload limits, response headers, panel assets, and SPA fallback.

Effect Schema decodes request bodies, query values, and successful and failed
JSON responses with excess properties rejected. The web and CLI clients decode
the same shared response schemas before exposing data to callers. A malformed
JSON body returns `INVALID_JSON`. A schema failure returns `VALIDATION_ERROR`.
Domain failures keep their code, message, details, and HTTP status. An
unexpected failure returns `INTERNAL_ERROR` with a request ID.

The Node HTTP adapter interrupts the request fiber when a client closes the
response before completion. Effect HTTP creates a server span and accepts W3C
trace context from request headers.

## RPC

`server/rpc-server.ts` serves `TreeportRpcs` at `POST /api/rpc`.
`packages/shared/src/network-rpc.ts` is the contract source.

`WatchProjectEvents` is a typed server stream. Each client gets this sequence:

1. subscribe to product events;
2. read the already-initialized terminal metadata and panel state;
3. send one authoritative snapshot;
4. send only events that the snapshot does not represent;
5. continue with ordered product events.

Each client has an independent bounded queue. A client that fills its queue
gets a typed `ProjectEventsFailure`. Its failure does not stop another client.
The stream scope removes the event subscription and updates connection metrics.
The web application and CLI use the same RPC schema and NDJSON protocol.

## Specialized WebSocket channels

Effect RPC does not carry terminal input/output or Browser binary frames.
`server/socket-server.ts` therefore uses Effect Socket for these channels:

| Path                         | Purpose                                                                                               |
| ---------------------------- | ----------------------------------------------------------------------------------------------------- |
| `/api/socket/terminals`      | Terminal control, text and binary input, ordered output, output acknowledgements, and control handoff |
| `/api/socket/browsers`       | Hosted Browser commands, state, and binary JPEG frames                                                |
| `/api/socket/browser-owners` | Desktop Browser ownership and runtime control                                                         |

A connection must send a strict schema-validated handshake before any channel
message. The handshake includes the channel protocol version and channel auth.
Protocol versions change when the wire format changes.

The server bounds inbound and outbound queues. Terminal output uses per-viewer
high, low, and hard byte watermarks. Browser frames use one in-flight frame per
viewer and coalesce later frames. Browser command queues are bounded and
coalesce only commands with the same semantic key. Invalid input closes only
the affected connection.

The browser client owns one Effect connection fiber and one bounded write
queue. Disconnect interrupts that fiber. Reconnect delay is explicit and
bounded. The server scope owns every connection reader and writer fiber.
Shutdown closes clients, forces unresponsive clients closed after a short
grace period, waits for connection fibers, and then closes the WebSocket
server.

## Upgrade dispatch

`server/index.ts` installs one Node `upgrade` listener.
It authenticates the request and dispatches by path in this order:

1. Effect Socket channels;
2. the exact web-panel Vite HMR path;
3. the exact application Vite HMR path.

Unknown paths are destroyed. Vite must register one upgrade callback when it
starts. Treeport captures that callback, removes it from the Node server, and
calls it only from the path-aware dispatcher. Dynamic web-panel Vite servers
use the same rule. This prevents two listeners from handling one upgrade.

## Security

`request-security.ts` remains the common HTTP and WebSocket gate.
Direct requests must come from loopback. Remote requests must come through the
trusted loopback Tailscale Serve ingress and contain its user identity.
Forwarded host and protocol headers have authority only after this check.
Browser origin checks use the accepted external origin.

## Schema ownership

Network request, handshake, message, frame, event, RPC success, and typed RPC
failure contracts live in `@treeport/shared` as Effect Schemas.
Production decoders reject excess properties. The schemas supply the TypeScript
types used by the server, web application, CLI, and desktop test backend.

Zod remains only for contracts that are not part of the migrated network wire,
such as selected package manifests and desktop-local IPC where migration is not
required.

## Observability

Effect HTTP and RPC create spans and preserve incoming HTTP trace context.
Socket connections create channel spans.
The application runtime owns the OpenTelemetry exporter and flushes it during shutdown.
Terminal-host IPC carries trace context for traced create, remove, and attachment work.
The terminal host owns and flushes its process-local exporter.
See [Agent-readable tracing](agent-tracing.md) for the internal capture procedure.

Structured logs put request IDs and connection channels in log fields.
They also put WebSocket close codes, wire reasons, and application close reasons in log fields.

`server/network-telemetry.ts` defines low-cardinality metrics for:

- active HTTP, RPC, terminal, and Browser connections;
- inbound and outbound messages and bytes;
- decode failures, reconnects, interruptions, and bounded application close
  reasons, with exact WebSocket codes and wire reasons in logs;
- observed queue-depth distributions, dropped work, and coalesced work;
- HTTP request latency, RPC snapshot/queue/lifetime latency, socket
  write-and-drain time, and Browser operation and queue wait time;
- terminal pending-input, pre-ready-output, and unacknowledged-output
  watermark distributions;
- terminal output and Browser frame acknowledgement lag.

Channel, direction, operation, and drop kind are bounded metric labels.
Request, terminal, panel, and connection identifiers stay in spans or logs.

## Retained Promise boundaries

Promise and callback code remains only where an external API requires it:

- Node process startup and shutdown;
- filesystem, SQLite, Git, GitHub, npm, Vite, Playwright, Electron, and PTY
  adapters;
- Node HTTP and WebSocket callbacks;
- terminal-host IPC framing.

Domain services return Effects. Network handlers must not start a second Effect
runtime for domain work. Callback adapters attach finite work to supervised
`ApplicationFibers`; connection readers and writers remain connection-scoped.
Application shutdown drains those fibers before disposing the managed runtime.

## Review checklist

Before merge, verify all of these items from current command output and source:

- targeted HTTP, request-security, RPC, socket, terminal, Browser, CLI,
  desktop, lifecycle, package, and HMR tests pass;
- malformed input, cancellation, reconnect, ordering, binary frames, forced
  backpressure, and shutdown have behavior coverage;
- node, web, shared, and desktop typechecks pass;
- production builds and package smoke checks pass;
- `pnpm ci:local` and `git diff --check` pass;
- no production Hono or Socket.IO import or dependency remains;
- no second Node upgrade listener remains after Vite startup;
- no duplicate Zod and Effect network schema remains;
- no network handler uses a nested runtime interpreter for domain Effects;
- all server and connection fibers have a scope or application owner.
