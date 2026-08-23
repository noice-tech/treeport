# Decision 0006: Vite is the web panel toolchain

- Status: Accepted
- Date: 2026-08-04

## Context

Package authors could compile web panels and commit the output.

This design would put generated files in reviews and make local and installed behavior different.

It would also prevent one Treeport contract for TypeScript, React, dependency resolution, and caching.

Alternatively, Treeport could run the build configuration from each package.

This design would give package code privileged execution in the daemon.

## Decision

Treeport supports source-distributed web panels with a fixed Vite profile that Treeport controls.

Treeport resolves package dependencies from the installed dependency graph and includes them in the panel bundle.

The host API is an exception.

Treeport maps `@treeport/panel-sdk` to its runtime copy. Panel packages use this package as a development dependency for types.

Local project panels and local packages use in-process Vite middleware with HMR.

Treeport compiles installed npm panels into fixed, content-addressed cache entries.

Treeport controls the compiler configuration, cache keys, routes, response policy, and development server lifecycle.

Treeport does not find or run these package items:

- `vite.config.*`;
- executable Babel or PostCSS configuration;
- compiler plug-ins;
- build scripts;
- package-manager lifecycle scripts.

## Consequences

Panel packages publish source and browser dependencies instead of generated output.

They do not bundle or select the host bridge.

The compiler profile and panel SDK are package-author compatibility contracts.

Update public documentation when these contracts change.

A compiler change can change output.

In this case, change the web panel compiler ABI so old cache entries cannot appear current.

Local and installed panels have different service lifecycles.

They use the same source format and fixed transformation profile.
