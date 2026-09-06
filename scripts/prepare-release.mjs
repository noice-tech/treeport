#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import {
  compareVersions,
  fail,
  git,
  parseVersion,
  readRelease,
  releaseManifestPaths,
  run,
  verifySource
} from './release-utils.mjs'

const help = `Usage: pnpm release:prepare <X.Y.Z>

Run from clean main, exactly matching origin/main in noice-tech/treeport.
Synchronize versions, run pnpm ci:local, commit, tag, and atomically push.
This command does not build desktop artifacts or publish GitHub/npm releases.
After preparation, run pnpm release:desktop X.Y.Z on your Mac.
Read pnpm release:desktop --help for local Apple credential setup first.

An existing local or remote tag is never changed. For an already-pushed tag,
use release:desktop only if that tag still points to current clean main.
On check failure, inspect and restore the version edits before retrying.
On push failure, inspect origin and the local commit/tag before retrying the
reported atomic push. Do not delete or recreate a release tag.`
const [version, ...extra] = process.argv.slice(2)
if (version === '--help' && !extra.length) {
  console.log(help)
  process.exit(0)
}

if (!version || extra.length) {
  fail(help)
}

const requested = parseVersion(version)
if (!requested) {
  fail(
    `Invalid version: ${version}. Expected canonical X.Y.Z without leading zeroes`
  )
}

const head = verifySource()
const manifests = releaseManifestPaths.map((file) =>
  JSON.parse(readFileSync(file, 'utf8'))
)
for (const manifest of manifests) {
  const current = parseVersion(manifest.version)
  if (!current) {
    fail(
      `The current ${manifest.name} version is not canonical: ${manifest.version}`
    )
  }

  if (compareVersions(requested, current) < 0) {
    fail(
      `Requested version ${version} must not be lower than ${manifest.version}`
    )
  }
}
for (const manifest of manifests.slice(2)) {
  if (manifest.version !== manifests[0].version) {
    fail(`${manifest.name} and ${manifests[0].name} must have the same version`)
  }
}
const tag = `v${version}`
for (const [args, absentStatus, location] of [
  [['show-ref', '--verify', '--quiet', `refs/tags/${tag}`], 1, 'locally'],
  [
    ['ls-remote', '--exit-code', '--tags', 'origin', `refs/tags/${tag}`],
    2,
    'on origin'
  ]
]) {
  const result = spawnSync('git', args, { encoding: 'utf8' })
  if (result.status === 0) {
    fail(`Tag already exists ${location}: ${tag}`)
  }

  if (result.status !== absentStatus) {
    fail(`Could not check tag ${tag} ${location}; stopped`)
  }
}
if (readRelease(tag)) {
  fail(`GitHub Release already exists: ${tag}`)
}

const expectedFiles = []
for (const [index, file] of releaseManifestPaths.entries()) {
  if (manifests[index].version === version) {
    continue
  }

  manifests[index].version = version
  expectedFiles.push(file)
  writeFileSync(file, `${JSON.stringify(manifests[index], null, 2)}\n`)
}
try {
  run('pnpm', ['ci:local'], { stdio: 'inherit' })
} catch {
  fail(
    `Repository checks failed. Release files remain updated to ${version}; fix the failure or restore them before retrying.`
  )
}
const actualFiles = [
  ...new Set(
    [
      ...git(['diff', '--name-only']).split('\n'),
      ...git(['diff', '--cached', '--name-only']).split('\n'),
      ...git(['ls-files', '--others', '--exclude-standard']).split('\n')
    ].filter(Boolean)
  )
].sort()
if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles.sort())) {
  fail(
    `Expected only version files to change: ${expectedFiles.join(', ')}. Found: ${actualFiles.join(', ') || 'none'}`
  )
}

git(['fetch', 'origin', 'main'], { stdio: 'inherit' })
if (
  git(['rev-parse', 'HEAD']) !== head ||
  git(['rev-parse', 'origin/main']) !== head
) {
  fail('main changed during checks; inspect the version edits before retrying')
}

if (readRelease(tag)) {
  fail(`GitHub Release appeared during checks: ${tag}; stopped`)
}

if (expectedFiles.length) {
  git(['add', '--', ...expectedFiles])
}

git(['commit', '--allow-empty', '-m', `Release ${version}`], {
  stdio: 'inherit'
})
git(['tag', '-a', tag, '-m', `Release ${version}`])
try {
  git(['push', '--atomic', 'origin', 'main', tag], { stdio: 'inherit' })
} catch {
  fail(
    `Atomic push failed. The release commit and tag remain local. Inspect origin before retrying \`git push --atomic origin main ${tag}\`.`
  )
}
console.log(
  `\nPrepared and pushed ${tag}. Nothing has been published to GitHub Releases or npm.`
)
console.log(`Next, on your Mac: pnpm release:desktop ${version}`)
