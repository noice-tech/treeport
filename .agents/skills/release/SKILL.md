---
name: release
description: Prepare a stable Treeport release, push its release commit and tag, and wait for CI to publish the single GitHub Release with desktop artifacts. Use when asked to cut, prepare, make, or create a Treeport release. Stops before npm publication so the user can publish from their machine.
compatibility: Repository-specific to noice-tech/treeport. Requires git, gh, Node.js 24, pnpm 11, network access, and permission to push releases.
---

# Release Treeport

Prepare one stable Treeport release and wait for its desktop workflow to publish exactly one GitHub Release. Leave npm publication to the user.

## Boundaries

- Work only in `noice-tech/treeport` from the repository root.
- Never run `pnpm release:publish`, `npm publish`, or a package-level publish command.
- Do not manually edit release versions, create the release commit, create the tag, or push them. `pnpm release:prepare` owns those operations and validation.
- Use canonical `X.Y.Z` versions only.
- Treat `release:prepare` as irreversible because it atomically pushes `main` and the tag. Obtain confirmation of the exact version unless the user supplied it in the current request.

## Choose the version

If the user supplied `X.Y.Z`, verify that it is not lower than `apps/treeport/package.json`'s current version. An equal version is valid when preparing an initial or already-versioned release whose tag and GitHub Release do not exist yet.

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
5. Review user-visible changes since the prior release. Use the writing documentation skill to update affected public documentation.
6. Run `pnpm --filter @treeport/docs check`.
7. Require a clean `main` branch exactly matching `origin/main`.

Stop when the documentation does not match a supported release workflow. Do not work around failed checks, authentication failures, a dirty tree, another branch, divergence, or version conflicts.

## Prepare the release

Set `version` to the confirmed version and `tag` to `v${version}`. Run:

```bash
pnpm release:prepare "$version"
```

This updates the npm package, desktop client, and panel SDK versions when needed. It runs the complete repository checks. It commits `Release X.Y.Z`, creates an annotated tag, and atomically pushes `main` and the tag. It uses an empty release commit when each version is aligned. It does not publish to npm.

If it fails, stop and preserve the state for diagnosis. Follow the recovery instructions from the script rather than rerunning blindly.

## Wait for and verify the GitHub Release

The pushed tag triggers `.github/workflows/desktop-release.yml`. Never run `gh release create`: CI creates one draft release, attaches the signed/notarized universal DMG and updater ZIP, verifies them, and publishes that same release.

Find the workflow run for the exact release commit and wait for it:

```bash
sha="$(git rev-list -n 1 "$tag")"
run_id="$(gh run list \
  --repo noice-tech/treeport \
  --workflow desktop-release.yml \
  --commit "$sha" \
  --json databaseId \
  --jq '.[0].databaseId')"
test -n "$run_id"
gh run watch "$run_id" --repo noice-tech/treeport --exit-status
```

If the workflow fails, stop and report the run URL. Do not create a replacement release manually. After it succeeds, verify the single published release and both exact assets:

```bash
gh release view "$tag" \
  --repo noice-tech/treeport \
  --json assets,isDraft,isPrerelease,tagName,url
```

For version `X.Y.Z`, require exactly:

- `Treeport-X.Y.Z-darwin-universal.dmg`
- `Treeport-X.Y.Z-darwin-universal.zip`

Verify that the tag is correct, the release is published and stable, and the local and remote tags point to the current `main` commit.

## Finish

Report the version and GitHub Release URL, state that npm publication has not happened, and give the user the only remaining command:

```bash
pnpm release:publish X.Y.Z
```

Never run that command for the user.
