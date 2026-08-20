# Desktop distribution and updates

This document defines the macOS desktop release contract for maintainers.

Put user installation instructions in the public Starlight documentation. Keep credentials and recovery procedures in this document.

## Distribution boundary

The Electron application is a client for a separately installed Treeport backend.

It contains the native shell, saved computer data, preload bridges, and local connection interface.

It does not contain the daemon, tmux launcher, database migrations, or npm distribution.

The desktop target is a universal macOS application for `arm64` and `x86_64`.

One artifact supports Apple Silicon and Intel Macs.

`update.electronjs.org` uses one `darwin-universal` ZIP for both architectures.

The npm and desktop packages use the same `X.Y.Z`, Git tag, and stable release identity.

Private workspace packages are not separate release products.

## One release and two artifacts

Each `vX.Y.Z` tag has exactly one GitHub Release:

```text
vX.Y.Z
├── Treeport-X.Y.Z-darwin-universal.dmg
└── Treeport-X.Y.Z-darwin-universal.zip
```

The DMG is the installer for users. The ZIP is the Squirrel.Mac update file.

The public Electron GitHub update service does not require a `RELEASES.json` file.

CI creates or uses one draft for the tag.

It uploads and verifies both files. Then, it changes the same release from draft to published.

A draft and a published release are two states of one release.

Maintainers and the release skill must not run `gh release create`.

Publishing `@treeport/treeport@X.Y.Z` to npm is a separate registry operation.

It does not create another GitHub Release.

## Sign and notarize the application

A stable desktop release requires these items:

- an Apple Developer Program team;
- a Developer ID Application certificate;
- the certificate private key in a password-protected P12 file;
- an App Store Connect Team API key with App Manager access;
- Xcode and `notarytool` on the macOS runner.

Configure these GitHub Actions secrets in the protected `release` environment:

| Secret                       | Contents                            |
| ---------------------------- | ----------------------------------- |
| `MACOS_CERTIFICATE_P12`      | Base64 Developer ID Application P12 |
| `MACOS_CERTIFICATE_PASSWORD` | P12 export password                 |
| `APPLE_API_KEY_P8`           | Base64 App Store Connect `.p8` key  |
| `APPLE_API_KEY_ID`           | App Store Connect API key ID        |
| `APPLE_API_ISSUER`           | Team API issuer UUID                |
| `APPLE_TEAM_ID`              | Expected Apple Developer team ID    |

The workflow imports the certificate into a temporary keychain.

It requires exactly one Developer ID Application identity for the specified team.

An `always()` cleanup operation removes the keychain and decoded key files.

To rotate a certificate or API key, replace its secret. Then, validate a release test.

Do not commit decoded credentials.

Use this signing and notarization order:

1. Forge packages the universal `.app`.
2. Forge signs nested Electron code with the hardened runtime.
3. Forge sends the application to Apple, gets approval, and staples the ticket.
4. The ZIP maker archives the completed application.
5. The DMG maker creates the installer from the completed application.
6. The post-make hook signs, submits, and staples the DMG.
7. The workflow standardizes file names without a change to signed content.

A local `pnpm --filter @treeport/desktop make` uses an ad hoc signature.

This signature lets Forge merge and start a universal application. It is not a Developer ID signature or Apple notarization.

CI sets `TREEPORT_DESKTOP_RELEASE=1`.

In this mode, Forge stops before packaging when a signing or notarization value is absent.

Do not distribute a local build as a stable release.

## Automatic update design

A packaged macOS application checks `https://update.electronjs.org/noice-tech/treeport` at startup.

It checks again every ten minutes.

The service reads the latest public stable GitHub Release.

It maps both macOS architectures to the universal ZIP. It does not offer drafts or prereleases.

After Squirrel.Mac downloads an update, the Electron prompt offers a restart or delay.

The update replaces only the desktop client.

It does not update, restart, or migrate the selected backend.

Backend-aware update control is in issue #166.

Update checks are off for development, non-macOS, and `TREEPORT_DESKTOP_E2E=1` starts.

Thus, tests and local development do not contact the public update service.

## Release procedure

Start from a clean `main` that is equal to `origin/main`.

Prepare the release:

```sh
pnpm release:prepare X.Y.Z
```

This command performs these operations:

1. Synchronize the npm package, desktop client, and panel SDK version.
2. Run `pnpm check`.
3. Create the `Release X.Y.Z` commit.
4. Create the annotated `vX.Y.Z` tag.
5. Push both Git references as one operation.

The tag starts `.github/workflows/desktop-release.yml`.

The workflow performs these operations:

1. Validate the tag and package versions.
2. Run repository checks.
3. Import Apple credentials.
4. Run Forge publish as a `darwin/universal` test.
5. Verify package content, architectures, fuses, signatures, tickets, and startup.
6. Continue Forge to put the DMG and ZIP in one draft.
7. Verify one draft and exactly two complete files.
8. Publish the same release.

After CI succeeds, publish npm:

```sh
npm login
pnpm release:publish X.Y.Z
```

This command checks Git references, the repository, the stable release, exact files, and npm state.

It does not run `pnpm check`.

Release preparation and tagged CI already run the repository checks.

It then publishes with the `latest` tag.

It does not create or change the GitHub Release.

## Verify a local package

A local universal build can test packaging and package boundaries.

Developer ID and notarization checks require release credentials.

```sh
pnpm --filter @treeport/desktop exec electron-forge make --platform darwin --arch universal
pnpm --filter @treeport/desktop check:release X.Y.Z out
```

The release workflow also runs:

```sh
codesign --verify --deep --strict --verbose=2 Treeport.app
spctl --assess --type execute --verbose=4 Treeport.app
xcrun stapler validate Treeport.app
codesign --verify --verbose=2 Treeport-X.Y.Z-darwin-universal.dmg
xcrun stapler validate Treeport-X.Y.Z-darwin-universal.dmg
```

To accept a release fully, test update from installed version N-1 to public version N on a clean Mac.

## Recover from a release failure

### Failure before upload

No release exists.

Correct code or configuration through the standard release process.

For credential or temporary CI failures, start the same immutable tag workflow again.

### Partial upload or failed draft check

The single release stays as a draft. Update clients cannot see it.

Start the same workflow again.

Forge finds the tag draft and replaces incomplete files with the same names.

If the tag has multiple drafts, the workflow stops.

Remove the incorrect drafts manually before you start it again.

### Published release failure

The workflow does not change a published release.

Do not move or rebuild a stable tag.

For a bad release, document its withdrawal and apply the release policy in issue #127.

Then, make a new patch release.

The update service can temporarily cache release data.

### npm publication failure

The GitHub Release can already be public.

Correct npm authentication or the temporary registry problem.

Run the publication command again:

```sh
pnpm release:publish X.Y.Z
```

The command finds an existing exact npm version and prevents a change of `latest` to an earlier version.

It does not create another GitHub Release.

## Security and issue boundaries

Local HTTP is available only on loopback. It uses the local operating-system user as the security boundary.

Remote computers require operating-system-trusted HTTPS.

The supported remote method is Tailscale Serve, with Tailscale identity and policy.

Treeport does not have an application login.

Do not expose Treeport through Funnel or a public proxy.

Issue #28 controls application authentication.

Issue #127 controls release channels, rollback, and complete release policy.

Issue #166 controls desktop and backend compatibility and coordinated updates.

The daemon continues to own database migrations.
