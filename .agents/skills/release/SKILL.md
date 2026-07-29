---
name: release
description: Prepare a stable Treeport release, push its release commit and tag, and create the published GitHub Release. Use when asked to cut, prepare, make, or create a Treeport release. Stops before npm publication so the user can publish from their machine.
compatibility: Repository-specific to noice-tech/treeport. Requires git, gh, Node.js 24, pnpm 11, network access, and permission to push and create GitHub Releases.
---

# Release Treeport

Prepare one stable Treeport release and create its GitHub Release. Leave npm publication to the user.

## Boundaries

- Work only in `noice-tech/treeport` from the repository root.
- Never run `pnpm release:publish`, `npm publish`, or a package-level publish command.
- Do not manually edit release versions, create the release commit, create the tag, or push them. `pnpm release:prepare` owns those operations and validation.
- Use canonical `X.Y.Z` versions only.
- Treat `release:prepare` as irreversible because it atomically pushes `main` and the tag. Obtain confirmation of the exact version unless the user supplied it in the current request.

## Choose the version

If the user supplied `X.Y.Z`, verify that it is greater than `apps/treeport/package.json`'s current version.

If no version was supplied:

1. Read `apps/treeport/package.json` and find the latest `vX.Y.Z` tag.
2. Inspect commits and the diff from that tag through `HEAD`.
3. Recommend a SemVer bump: breaking behavior is major, backward-compatible functionality is minor, and fixes or maintenance are patch.
4. Ask the user to confirm the exact version.

## Preflight

1. Confirm the repository root and that `origin` is `noice-tech/treeport`.
2. Confirm `git`, `gh`, `node`, and `pnpm` are available.
3. Confirm GitHub authentication and access with `gh auth status` and `gh repo view noice-tech/treeport`.
4. Confirm the requested tag and GitHub Release do not already exist.
5. Require a clean `main` branch exactly matching `origin/main`.

Do not work around failed checks, authentication failures, a dirty tree, another branch, divergence, or version conflicts.

## Prepare the release

Set `version` to the confirmed version and `tag` to `v${version}`. Run:

```bash
pnpm release:prepare "$version"
```

This updates the npm package and installer versions, runs the complete repository checks, commits `Release X.Y.Z`, creates an annotated tag, and atomically pushes `main` and the tag. It does not publish to npm.

If it fails, stop and preserve the state for diagnosis. Follow the recovery instructions from the script rather than rerunning blindly.

## Create and verify the GitHub Release

After preparation succeeds:

```bash
gh release create "$tag" \
  --repo noice-tech/treeport \
  --verify-tag \
  --title "$tag" \
  --generate-notes
```

Do not create a draft or mark the release as a prerelease. Verify it:

```bash
gh release view "$tag" \
  --repo noice-tech/treeport \
  --json isDraft,isPrerelease,tagName,url
```

Verify that the tag is correct, the release is published, and the local and remote tags point to the current `main` commit.

## Finish

Report the version and GitHub Release URL, state that npm publication has not happened, and give the user the only remaining command:

```bash
pnpm release:publish X.Y.Z
```

Never run that command for the user.
