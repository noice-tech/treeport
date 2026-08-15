# Decision 0008: Tailscale Serve is the remote authentication boundary

- Status: Accepted
- Date: 2026-08-15

## Context

Treeport provides arbitrary terminal access and can operate on registered repositories. A caller that reaches its HTTP API or terminal socket has authority similar to the local user who runs the daemon. Network location alone is not a sufficient user identity, even on a private LAN.

Treeport already uses a loopback daemon for local access and Tailscale Serve for its supported remote workflow. Serve terminates private HTTPS, authenticates the Tailscale user and device, applies tailnet policy, removes client-supplied Tailscale identity headers, and adds authenticated identity headers before it proxies to the loopback backend.

Application-managed OIDC would add account, session, secret, callback, recovery, and migration responsibilities. Browser sessions would not by themselves authenticate the CLI. Tailscale's experimental `tsidp` service would also add a separate service and client configuration to a workflow that already has an authenticated ingress.

## Decision

Treeport supports direct requests only through an explicit loopback listener. The local operating-system account is the trust boundary for these requests.

Treeport supports remote requests only through Tailscale Serve. The daemon remains on loopback and requires `Tailscale-User-Login` on a proxied request. Optional Tailscale name and profile headers do not determine authentication. Treeport applies this decision before HTTP application handling and during every Socket.IO upgrade.

The identity headers are not cryptographically verified by Treeport. Treeport trusts them only because the backend peer and listener are loopback and Serve strips incoming copies before it adds its own values. A local process can forge the headers, but a local process already has direct authority to use Treeport.

Treeport trusts forwarded host and protocol values only after it accepts the Tailscale identity. Browser origin checks use that effective external origin. Direct local requests do not gain authority from forwarded headers.

Treeport refuses non-loopback listeners. It does not support direct LAN or Tailscale-IP binding, arbitrary reverse proxies, Tailscale Funnel, tagged devices without a user identity, or public deployment.

Tailscale owns login, tailnet membership, policy, device-key expiration, revocation, and credential rotation. Treeport does not create a second account or session for this access path.

## Consequences

Local browser, desktop, CLI, and managed-terminal workflows remain credential-free. Remote browser, desktop, and CLI requests also need no Treeport credential because Serve adds identity at ingress.

The design has a deliberate Tailscale dependency. Users cannot replace Serve with another proxy by copying header names. An old non-loopback listener preference now fails and must be repaired before Treeport starts.

There is no Treeport logout action. Revocation and expiration occur in Tailscale. A tagged Tailscale device cannot connect because it does not identify a user.

A future remote provider needs a separate design. The design must authenticate browser HTTP, both Socket.IO namespaces, desktop traffic, and CLI traffic without credentials in arguments or URLs. It must define HTTPS, origin, trusted-ingress, spoofing, expiration, revocation, setup, recovery, and fail-closed listener behavior. Adding such a provider must not weaken the loopback and Tailscale defaults.
