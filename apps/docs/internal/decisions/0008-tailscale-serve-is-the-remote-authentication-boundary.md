# Decision 0008: Tailscale Serve is the remote authentication boundary

- Status: Accepted
- Date: 2026-08-15

## Context

Treeport gives full terminal access and can change registered repositories.

A caller with HTTP API or terminal socket access has authority similar to the daemon user.

A network location is not a sufficient user identity, including on a private LAN.

Treeport uses a loopback daemon for local access. Its supported remote workflow uses Tailscale Serve.

Serve supplies private HTTPS, authenticates the user and device, and applies tailnet policy.

It removes identity headers from the client. Then, it adds authenticated identity headers before proxying to the loopback backend.

Application-managed OIDC would add account, session, secret, callback, recovery, and migration requirements.

Browser sessions alone would not authenticate the CLI.

Tailscale `tsidp` would add another service and client configuration to an ingress that already has authentication.

## Decision

Treeport accepts direct requests only on an explicit loopback listener.

The local operating-system account is the security boundary for these requests.

Treeport accepts remote requests only through Tailscale Serve.

The daemon stays on loopback and requires `Tailscale-User-Login` on a proxied request.

Optional Tailscale name and profile headers do not control authentication.

Treeport applies this rule before HTTP application processing and during each WebSocket upgrade.

Treeport does not verify identity headers with cryptography.

It trusts them because the backend peer and listener are loopback.

Serve removes client copies of the headers before it adds authenticated values.

A local process can make false identity headers. However, a local process already has direct Treeport authority.

Treeport trusts forwarded host and protocol values only after it accepts the Tailscale identity.

Browser origin checks use the effective external origin.

Forwarded headers do not give more authority to direct local requests.

Treeport rejects non-loopback listeners.

It does not support these access methods:

- direct LAN or Tailscale IP binding;
- arbitrary reverse proxies;
- Tailscale Funnel;
- tagged devices without a user identity;
- public deployment.

Tailscale controls login, tailnet membership, policy, device key expiration, access removal, and credential rotation.

Treeport does not create another account or session for this access method.

## Consequences

Local browser, desktop, CLI, and managed terminal use does not require a credential.

Remote clients also do not need a Treeport credential because Serve adds identity at the connection point.

This design has an intentional Tailscale dependency.

A user cannot replace Serve with another proxy by copying the header names.

An old non-loopback listener setting causes startup failure. The user must repair it before Treeport starts.

Treeport does not have a logout operation. Tailscale controls access removal and expiration.

A tagged device cannot connect because it does not identify a user.

A future remote provider needs a separate design for all these traffic types:

- browser HTTP and Effect RPC;
- terminal and Browser WebSocket channels;
- desktop traffic;
- CLI traffic.

The design must not put credentials in arguments or URLs.

It must define HTTPS, origin, trusted ingress, false-header prevention, expiration, access removal, setup, recovery, and safe listener failure.

A new provider must not weaken the loopback and Tailscale defaults.
