# Decision 0006: Vite is the web-panel toolchain

- Status: Accepted
- Date: 2026-08-04

## Context

Requiring package authors to precompile and commit web-panel output makes generated files part of reviews, splits local and installed behavior, and prevents Treeport from providing a consistent TypeScript, React, dependency-resolution, and caching contract. Allowing each package to run its own build configuration would create a privileged code-execution path in the daemon.

## Decision

Treeport supports source-distributed web panels through a fixed, Treeport-owned Vite profile. Package dependencies are resolved normally from the package's installed dependency graph and bundled with the panel. The host API is the exception: Treeport resolves `@treeport/panel-sdk` to its own runtime copy, while panel packages use the package as a development dependency for types.

Local project panels and local-path packages run through in-process Vite middleware with HMR. Npm-installed package panels compile into immutable, content-addressed Treeport cache entries. Treeport owns the compiler configuration, cache keys, routes, response policy, and development-server lifecycle.

Treeport never discovers or executes package `vite.config.*`, executable Babel or PostCSS configuration, package-provided compiler plugins, build scripts, or package-manager lifecycle scripts.

## Consequences

Panel packages publish source and normal browser dependencies rather than generated browser output. They do not bundle or select the host bridge. The supported compiler profile and panel SDK API are author-facing compatibility contracts and must be documented when they change.

Compiler changes that can alter output require an explicit web-panel compiler ABI change so old cache entries cannot be mistaken for current output. Local and installed panels intentionally use different serving lifecycles but share the same fixed transformation profile and source package format.
