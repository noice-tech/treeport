# Desktop distribution and updates

This document describes the maintainer-facing macOS desktop release contract introduced for issue #124. Public installation instructions belong in the Starlight documentation; credentials and recovery procedures remain internal here.

## Distribution boundary

The Electron application is a client for a separately installed Treeport backend. It contains the native shell, saved-computer store, preload bridges, and local connection UI. It does not contain the daemon, tmux launcher, database migrations, or npm distribution.

The first desktop target is a universal macOS application containing `arm64` and `x86_64`. One artifact works on Apple Silicon and Intel Macs, and `update.electronjs.org` can use a `darwin-universal` ZIP for either architecture.

The npm and desktop packages use the same `X.Y.Z`, tag, and stable-release identity. Private workspace packages are not separate release surfaces.

## One-release artifact contract

Every `vX.Y.Z` tag has exactly one GitHub Release:

```text
vX.Y.Z
├── Treeport-X.Y.Z-darwin-universal.dmg
└── Treeport-X.Y.Z-darwin-universal.zip
```

The DMG is the user-facing installer. The ZIP is the Squirrel.Mac payload selected by `update.electronjs.org`. No `RELEASES.json` attachment is needed with the public Electron GitHub update service.

CI first creates or reuses one draft for the tag. It uploads and verifies both assets, then changes that same release ID from draft to published. Draft and published are states of one release. Neither maintainers nor the release skill run `gh release create`.

Publishing `@treeport/treeport@X.Y.Z` to npm is a separate registry operation and does not create another GitHub Release.

## Signing and notarization

A stable desktop release requires:

- An Apple Developer Program team.
- A Developer ID Application certificate and private key exported as a password-protected P12.
- An App Store Connect Team API key with App Manager access.
- Xcode/notarytool on the macOS runner.

Configure these GitHub Actions secrets, preferably on the protected `release` environment:

| Secret                       | Contents                                    |
| ---------------------------- | ------------------------------------------- |
| `MACOS_CERTIFICATE_P12`      | Base64-encoded Developer ID Application P12 |
| `MACOS_CERTIFICATE_PASSWORD` | Password used when exporting the P12        |
| `APPLE_API_KEY_P8`           | Base64-encoded App Store Connect `.p8` key  |
| `APPLE_API_KEY_ID`           | App Store Connect API key ID                |
| `APPLE_API_ISSUER`           | Team API issuer UUID                        |
| `APPLE_TEAM_ID`              | Expected Apple Developer team ID            |

The workflow imports the certificate into a temporary keychain, requires exactly one Developer ID Application identity for the expected team, and deletes the keychain and decoded key files in an `always()` cleanup step. Rotate the certificate or API key by replacing the associated secret and validating a release dry run; never commit decoded credentials.

Signing/notarization order matters:

1. Forge packages the universal `.app`.
2. Electron's nested code is signed with hardened runtime.
3. The application is submitted to Apple, accepted, and stapled.
4. The ZIP maker archives that finished application.
5. The DMG maker creates the installer from that application.
6. The post-make hook signs the DMG, submits it separately, and staples it.
7. Artifact filenames are normalized without changing their signed contents.

An ordinary local `pnpm --filter @treeport/desktop make` is ad-hoc signed so Forge can merge and launch a universal app, but it has no Developer ID identity or Apple notarization. CI sets `TREEPORT_DESKTOP_RELEASE=1`; in that mode Forge configuration fails before packaging if any signing or notarization value is missing. Never distribute a local make as a stable release.

## Automatic-update architecture

A packaged macOS application checks `https://update.electronjs.org/noice-tech/treeport` at startup and every ten minutes. The service reads the latest public, stable GitHub Release and maps both macOS architectures to the universal ZIP. Drafts and prereleases are not offered.

After Squirrel.Mac downloads an update, the Electron-owned prompt offers to restart Treeport or defer. This replaces only the desktop client. It does not upgrade, restart, or migrate the selected local or remote backend. Backend-aware update orchestration remains tracked by #166.

Updater initialization is disabled for development, non-macOS, and `TREEPORT_DESKTOP_E2E=1` launches so tests and local development never poll the public feed.

## Normal release procedure

From clean `main` exactly matching `origin/main`:

```sh
pnpm release:prepare X.Y.Z
```

The script synchronizes the npm package, desktop client, curl installer manifest, and installer script; runs `pnpm check`; creates `Release X.Y.Z`; creates annotated tag `vX.Y.Z`; and atomically pushes both refs.

The pushed tag starts `.github/workflows/desktop-release.yml`. It:

1. Validates the tag and synchronized package versions.
2. Runs repository checks.
3. Imports Apple credentials.
4. Runs Forge publish as a dry run for `darwin/universal`.
5. Verifies package contents, architectures, fuses, signatures, Gatekeeper assessment, stapled tickets, and packaged startup.
6. Resumes the dry run to attach the DMG and ZIP to one draft.
7. Verifies exactly one matching draft and exactly two complete assets.
8. Publishes that same release ID.

After CI succeeds, the maintainer publishes npm:

```sh
npm login
pnpm release:publish X.Y.Z
```

The publication script rechecks the Git refs, repository, public stable release, exact asset inventory, and npm state before publishing with the `latest` tag. It does not create or edit the GitHub Release.

## Local verification

An ad-hoc-signed local universal make can exercise packaging and package-boundary checks, but Developer ID and notarization verification require release credentials:

```sh
pnpm --filter @treeport/desktop exec electron-forge make --platform darwin --arch universal
pnpm --filter @treeport/desktop check:release X.Y.Z out
```

The release workflow additionally runs:

```sh
codesign --verify --deep --strict --verbose=2 Treeport.app
spctl --assess --type execute --verbose=4 Treeport.app
xcrun stapler validate Treeport.app
codesign --verify --verbose=2 Treeport-X.Y.Z-darwin-universal.dmg
xcrun stapler validate Treeport-X.Y.Z-darwin-universal.dmg
```

A release is not fully accepted until an installed N-1 application detects, downloads, and restarts into public version N on a clean Mac.

## Recovery

### Failure before upload

No release exists. Correct code/configuration failures through the normal release policy. Credential or transient CI failures can be retried for the same immutable tag.

### Partial upload or failed draft verification

The single release stays draft and is invisible to update clients. Rerun the same workflow. The Forge publisher finds the draft by tag and, with force enabled, replaces same-named partial assets. If more than one draft exists for the tag, the workflow deliberately fails; delete the incorrect drafts manually before retrying.

### Already-published release

The workflow refuses to modify a published release. Do not move or rebuild a stable tag. For a bad release, document the withdrawal, remove or mark the release according to the broader release policy in #127, and issue a new patch version. Remember that the update service can cache release data briefly.

### npm publication failure

The GitHub Release may already be public. Fix npm authentication or the transient registry problem and rerun:

```sh
pnpm release:publish X.Y.Z
```

The script detects an existing exact npm version and prevents moving `latest` backward. It never creates another GitHub Release.

## Security and issue boundaries

Local HTTP is accepted only on loopback and relies on the local OS-user boundary. Remote computers require operating-system-trusted HTTPS; the supported setup is Tailscale Serve, where Tailscale identity and ACLs/grants authorize network access. Treeport still has no application login, and must not be exposed through Funnel or a public proxy. Application authentication remains #28.

Broader channels, rollback, and end-to-end release policy remain #127. Desktop/backend compatibility and coordinated backend upgrades remain #166. Database migration ownership stays with the daemon.
