---
name: release
description: Prepare a stable Treeport release and build, verify, and publish its desktop artifacts locally on a Mac. Use when asked to cut, prepare, make, or create a Treeport release. Leave npm publication to the user.
compatibility: Repository-specific to noice-tech/treeport. Requires macOS, an Apple Developer ID identity, a notarization Keychain profile, git, gh, Node.js 24, pnpm 11, and release permission.
---

# Release Treeport

Publish one stable GitHub Release from a local Mac. GitHub hosts the files; GitHub Actions does not build releases.

## Boundaries

- Work only in `noice-tech/treeport` from the repository root.
- Leave npm publication to the user. Never run `release:publish`, `npm publish`, or package-level publication.
- Let `release:prepare` change versions, create the commit and tag, and push them.
- Let `release:desktop` create, upload, and publish the single GitHub Release.
- Never create a second release or overwrite an asset manually.
- Never move, replace, or delete a release tag.
- Never access or export signing secrets. Ask the user to configure the local Keychain.
- Run one release operator at a time. Do not rerun a legacy desktop CI job.
- Obtain confirmation of the exact canonical `X.Y.Z` version unless the current request supplies it.
- Treat preparation and desktop publication as remote mutations. Do not run either command for an implementation-only request.

## Choose the version

If the user supplies a version, compare it with the package versions. Do not use a lower version.

An equal version is valid for preparation only when neither the tag nor the GitHub Release exists.

If the user does not supply a version:

1. Read `apps/treeport/package.json` and find the latest stable tag.
2. Inspect commits and changes since that tag.
3. Recommend a SemVer version for the user-visible changes.
4. Ask the user to confirm the version.

## Check prerequisites

1. Read `pnpm release:prepare --help` and `pnpm release:desktop --help`.
2. Confirm that the user configured the signing identity and notarization Keychain profile on this Mac.
3. Confirm that the signing team matches the existing desktop release team.
4. Confirm GitHub authentication and repository access with `gh auth status` and `gh repo view noice-tech/treeport`.
5. Require clean `main` exactly matching `origin/main`.
6. Review user-visible changes with the writing-docs skill. Update affected public documentation before preparation.

The scripts validate versions, source, tags, and release state. Do not repeat their checks with alternate publication commands.

## Prepare a new release

Run the confirmed version:

```sh
pnpm release:prepare X.Y.Z
```

Preparation synchronizes all four release manifests and runs `pnpm ci:local`.
It creates an annotated tag and atomically pushes the release commit and tag.
It creates an empty release commit when the versions already match.
It does not build artifacts or publish a GitHub Release.

If checks fail, preserve and inspect the version edits. Fix the failure or restore those edits before retrying.

If the atomic push fails, inspect local and remote refs. Follow the script's recovery instruction only after that review.

## Build and publish locally

Run on the configured Mac:

```sh
pnpm release:desktop X.Y.Z
```

The command requires the tag to match current clean `main` and `origin/main`.
It runs the local gate again because it also supports an independently prepared tag.
It builds a signed and notarized universal application, DMG, and updater ZIP.
It verifies both distributed application copies, signatures, tickets, signing team, package contents, fuses, and an isolated launch.

The command records source and artifact digests in `apps/desktop/out/release-receipt.json`.
It creates or reuses one stable draft release and uploads only missing assets.
It downloads each asset and compares its SHA-256 digest before publishing that same release.
It then verifies the public updater feed for both Mac architectures.

The release contains exactly:

- `Treeport-X.Y.Z-darwin-universal.dmg`
- `Treeport-X.Y.Z-darwin-universal.zip`

## Recover an interrupted publication

Preserve `apps/desktop/out`, including the build receipt. Read the script error before another command.

If the source, tag, signing team, and artifact bytes are unchanged, run:

```sh
pnpm release:desktop X.Y.Z --resume
```

Resume verifies the artifacts again. It uploads missing assets without replacing existing assets.
It verifies identical bytes for each existing asset. It does not rebuild the application.

If publication succeeded but the updater check failed, resume treats the published release as read-only.
A missing receipt, conflicting asset, changed source, or incomplete upload requires maintainer review.
Never delete assets automatically to make a retry pass.

Before any upload, a failed build can be rebuilt without `--resume` if no receipt exists.
Archive the output before a new version. Remove a stale lock only after confirming that its owner exited.

### An existing unpublished tag

Skip preparation only when the tag still matches current clean `main` and the checkout contains this workflow.
Without a previous local receipt, start a normal desktop build only if the release is absent or an empty stable draft.

If `main` has advanced, stop. Do not build newer code under the old tag.
Ask the maintainer to choose a new version or separately review release tooling for the exact tagged source.
The normal workflow has no old-tag override.

## Finish

Report the version, GitHub Release URL, artifact verification, and updater check result.
State that npm publication has not happened.
Give the user this manual command, but do not run it:

```sh
pnpm release:publish X.Y.Z
```
