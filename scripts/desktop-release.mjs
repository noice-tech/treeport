#!/usr/bin/env node

import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'
import { publishDesktopRelease } from './github-release.mjs'
import {
  desktopAssetNames,
  fail,
  fileDigest,
  git,
  parseVersion,
  readRelease,
  run,
  verifySource,
  verifyVersions
} from './release-utils.mjs'

const help = `Usage: pnpm release:desktop <X.Y.Z> [--resume]

Build and publish one stable GitHub Release locally on macOS.
Requires clean main exactly matching origin/main and the existing vX.Y.Z tag.
Run release:prepare first for a new version. Never move an existing tag.
This command never pushes Git refs or publishes npm packages.

Local prerequisites:
  Node.js 24, pnpm 11, git, gh, tmux, Xcode command-line tools, and a Mac GUI session.
  Authenticate gh with repository contents write permission.
  Install a Developer ID Application certificate and its private key with
  Keychain Access. Unlock that keychain and allow codesign to use the key.
  Use the existing release signing team to preserve updater compatibility.
  Set TREEPORT_MAC_SIGNING_IDENTITY to that certificate's name or SHA-1.
  Set TREEPORT_APPLE_TEAM_ID to the corresponding ten-character Apple team ID.
  Run: xcrun notarytool store-credentials treeport-release
  Enter Apple notarization credentials at its prompts, not in shell arguments.
  Set TREEPORT_NOTARY_PROFILE=treeport-release (or your Keychain profile name).
  The signing key and notarization credentials stay in your macOS Keychain.
  Do not export secrets, commit credential files, or enable shell tracing.
  This script does not import keys, modify keychains, or print credentials.

The command runs pnpm ci:local, clears generated apps/desktop/out, and makes
signed/notarized universal DMG and updater ZIP files. It verifies the packaged
app, both distributed copies, signing team, tickets, fuses, and an isolated
launch. It records source and SHA-256 digests in out/release-receipt.json.
It uploads only missing assets to one draft, downloads and compares every
asset, publishes that same release, and checks both public Mac update feeds.

Recovery:
  Run only one release operator at a time. Stop any legacy CI release run first.
  After any publication failure, preserve out/ and run this command with --resume.
  Resume requires the same clean main/tag, signing team, receipt, and bytes.
  It rechecks artifacts; it never rebuilds, overwrites assets, or edits a
  published release. A feed failure can be retried after publication.
  Missing receipts, changed source, unexpected assets, and differing remote
  bytes require maintainer review. Do not delete remote assets automatically.
  Before any upload, a failed build can be retried without --resume.
  A receipt prevents accidental rebuilds. Archive out/ before starting a new
  version or deliberately abandoning a build with no uploaded assets.
  A stale lock path is reported. Remove it only after confirming its owner exited.
  If main advanced beyond an unpublished tag, this flow refuses recovery.
  Choose a new release version, or separately review tooling for the exact tag.
  Never copy newer application code into an older tagged release.

After success, the user can explicitly run pnpm release:publish X.Y.Z for npm.`
const [version, mode, ...extra] = process.argv.slice(2)
if (version === '--help' && !mode && !extra.length) {
  console.log(help)
  process.exit(0)
}

if (
  !version ||
  !parseVersion(version) ||
  extra.length ||
  (mode && mode !== '--resume')
) {
  fail(help)
}

if (process.platform !== 'darwin') {
  fail('Desktop releases must be built and verified on macOS')
}

const resume = mode === '--resume'
const tag = `v${version}`
const head = verifySource(tag)
verifyVersions(version)
const teamId = process.env.TREEPORT_APPLE_TEAM_ID?.trim()
if (!teamId || !/^[A-Z0-9]{10}$/.test(teamId)) {
  fail('Set TREEPORT_APPLE_TEAM_ID; see --help')
}

const output = path.resolve('apps/desktop/out')
const receiptPath = path.join(output, 'release-receipt.json')
// A repository-wide lock excludes simultaneous releases in linked worktrees.
const lock = path.resolve(
  git(['rev-parse', '--git-common-dir']),
  'treeport-release.lock'
)
if (existsSync(lock)) {
  fail(
    `Release lock exists: ${lock}. Confirm its owner exited before removing it.`
  )
}

mkdirSync(lock)
writeFileSync(
  path.join(lock, 'owner.json'),
  JSON.stringify({ pid: process.pid, cwd: process.cwd(), version })
)
try {
  const release = readRelease(tag)
  if (!resume) {
    if (existsSync(receiptPath)) {
      throw new Error(
        'A verified build receipt exists; use --resume or archive out/ after review'
      )
    }

    if (
      release &&
      (!release.draft || release.prerelease || release.assets.length)
    ) {
      throw new Error(
        'Release already has assets or is not a stable draft; recovery requires --resume and the original build'
      )
    }

    for (const name of [
      'TREEPORT_MAC_SIGNING_IDENTITY',
      'TREEPORT_NOTARY_PROFILE'
    ]) {
      if (!process.env[name]?.trim()) {
        throw new Error(`Set ${name}; see --help`)
      }
    }
    // Probe tools without reading or exporting Keychain credentials.
    run('xcrun', ['--find', 'notarytool'])
    run('xcrun', ['--find', 'stapler'])
    run('pnpm', ['ci:local'], { stdio: 'inherit' })
    if (verifySource(tag) !== head) {
      throw new Error('Source changed during checks')
    }

    rmSync(output, { recursive: true, force: true })
    run(
      'pnpm',
      [
        'exec',
        'electron-forge',
        'make',
        '--platform',
        'darwin',
        '--arch',
        'universal'
      ],
      {
        cwd: 'apps/desktop',
        stdio: 'inherit',
        env: { ...process.env, TREEPORT_DESKTOP_RELEASE: '1' }
      }
    )
  }

  accessSync(output, constants.R_OK)
  const names = desktopAssetNames(version)
  const artifacts = readdirSync(output, { recursive: true })
    .filter((file) => /\.(dmg|zip)$/.test(file))
    .map((file) => ({
      name: path.basename(file),
      path: path.join(output, file),
      size: statSync(path.join(output, file)).size,
      sha256: fileDigest(path.join(output, file))
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
  if (
    JSON.stringify(artifacts.map((artifact) => artifact.name)) !==
    JSON.stringify(names)
  ) {
    throw new Error(`Expected exactly ${names.join(', ')}`)
  }

  const receipt = {
    version,
    head,
    tagObject: git(['rev-parse', `refs/tags/${tag}`]),
    teamId,
    artifacts: artifacts.map(({ name, size, sha256 }) => ({
      name,
      size,
      sha256
    }))
  }
  if (
    resume &&
    JSON.stringify(JSON.parse(readFileSync(receiptPath, 'utf8'))) !==
      JSON.stringify(receipt)
  ) {
    throw new Error(
      'Build receipt does not match source, signing team, or artifact bytes; stopped'
    )
  }

  run(
    'pnpm',
    ['--filter', '@treeport/desktop', 'check:release', version, output, teamId],
    { stdio: 'inherit' }
  )
  const verifyBuildSource = () => {
    if (verifySource(tag) !== head) {
      throw new Error('Source changed since artifact verification')
    }

    verifyVersions(version)
    for (const artifact of artifacts) {
      if (fileDigest(artifact.path) !== artifact.sha256) {
        throw new Error(`Artifact changed: ${artifact.name}`)
      }
    }
  }
  verifyBuildSource()
  if (!resume) {
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
      flag: 'wx'
    })
  }

  const url = publishDesktopRelease(version, artifacts, verifyBuildSource)
  console.log(`Published and verified one stable release: ${url}`)
  run('pnpm', ['--filter', '@treeport/desktop', 'check:update-feed', version], {
    stdio: 'inherit'
  })
  console.log(
    `Nothing was published to npm. User action: pnpm release:publish ${version}`
  )
} catch (error) {
  // Do not dump subprocess environments or signing-tool error objects.
  console.error(`Desktop release stopped: ${error.message}`)
  console.error(
    `Preserve apps/desktop/out. See --help before retrying pnpm release:desktop ${version} --resume.`
  )
  process.exitCode = 1
} finally {
  rmSync(lock, { recursive: true, force: true })
}
