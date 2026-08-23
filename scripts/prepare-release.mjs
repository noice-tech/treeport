#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs'
import {
  compareVersions,
  fail,
  git,
  githubRepositoryFromUrl,
  parseVersion,
  run
} from './release-utils.mjs'

const githubRepository = 'noice-tech/treeport'
const [version, ...extraArguments] = process.argv.slice(2)
if (!version || extraArguments.length > 0) {
  fail('Usage: pnpm release:prepare <X.Y.Z>')
}

const requestedVersion = parseVersion(version)
if (!requestedVersion) {
  fail(
    `Invalid version: ${version}. Expected canonical X.Y.Z without leading zeroes`
  )
}

const originUrl = git(['config', '--get', 'remote.origin.url'])
if (githubRepositoryFromUrl(originUrl) !== githubRepository) {
  fail(
    `origin must be the canonical ${githubRepository} repository; found ${originUrl}`
  )
}

if (git(['rev-parse', '--abbrev-ref', 'HEAD']) !== 'main') {
  fail('Release preparation must run from main')
}

if (git(['status', '--porcelain'])) {
  fail('Working tree must be clean before preparing a release')
}

try {
  git(['fetch', 'origin', 'main'], { stdio: 'inherit' })
} catch {
  fail('Could not fetch origin/main; release preparation stopped')
}
if (
  git(['rev-parse', 'HEAD']) !== git(['rev-parse', 'refs/remotes/origin/main'])
) {
  fail('Local main must exactly match origin/main before preparing a release')
}

const packageManifestPath = 'apps/treeport/package.json'
const desktopManifestPath = 'apps/desktop/package.json'
const panelSdkManifestPath = 'packages/panel-sdk/package.json'
const packageManifest = JSON.parse(readFileSync(packageManifestPath, 'utf8'))
const panelSdkManifest = JSON.parse(readFileSync(panelSdkManifestPath, 'utf8'))
const currentVersion = parseVersion(packageManifest.version)
if (!currentVersion) {
  fail(
    `The current package version is not canonical: ${packageManifest.version}`
  )
}

if (panelSdkManifest.version !== packageManifest.version) {
  fail(
    `${panelSdkManifest.name} (${panelSdkManifest.version}) and ${packageManifest.name} (${packageManifest.version}) must have the same version`
  )
}

if (compareVersions(requestedVersion, currentVersion) < 0) {
  fail(
    `Requested version ${version} must not be lower than ${packageManifest.version}`
  )
}

const desktopManifest = JSON.parse(readFileSync(desktopManifestPath, 'utf8'))
const currentDesktopVersion = parseVersion(desktopManifest.version)
if (!currentDesktopVersion) {
  fail(
    `The current desktop version is not canonical: ${desktopManifest.version}`
  )
}

if (compareVersions(requestedVersion, currentDesktopVersion) < 0) {
  fail(
    `Requested version ${version} must not be lower than desktop ${desktopManifest.version}`
  )
}

const tag = `v${version}`
try {
  git(['show-ref', '--verify', '--quiet', `refs/tags/${tag}`])
  fail(`Tag already exists locally: ${tag}`)
} catch (error) {
  if (error.status !== 1) {
    throw error
  }
}
try {
  git(['ls-remote', '--exit-code', '--tags', 'origin', `refs/tags/${tag}`])
  fail(`Tag already exists on origin: ${tag}`)
} catch (error) {
  if (error.status !== 2) {
    throw error
  }
}

const expectedFiles = []
if (packageManifest.version !== version) {
  packageManifest.version = version
  expectedFiles.push(packageManifestPath)
  writeFileSync(
    packageManifestPath,
    `${JSON.stringify(packageManifest, null, 2)}\n`
  )
}

if (desktopManifest.version !== version) {
  expectedFiles.push(desktopManifestPath)
  desktopManifest.version = version
  writeFileSync(
    desktopManifestPath,
    `${JSON.stringify(desktopManifest, null, 2)}\n`
  )
}

if (panelSdkManifest.version !== version) {
  expectedFiles.push(panelSdkManifestPath)
  panelSdkManifest.version = version
  writeFileSync(
    panelSdkManifestPath,
    `${JSON.stringify(panelSdkManifest, null, 2)}\n`
  )
}

try {
  run('pnpm', ['check'], { stdio: 'inherit' })
} catch {
  fail(
    `Repository checks failed. Release files remain updated to ${version}; fix the failure or restore them before retrying.`
  )
}

expectedFiles.sort()
const changedFiles = new Set([
  ...git(['diff', '--name-only']).split('\n').filter(Boolean),
  ...git(['diff', '--cached', '--name-only']).split('\n').filter(Boolean),
  ...git(['ls-files', '--others', '--exclude-standard'])
    .split('\n')
    .filter(Boolean)
])
const actualFiles = [...changedFiles].sort()
if (
  actualFiles.length !== expectedFiles.length ||
  actualFiles.some((file, index) => file !== expectedFiles[index])
) {
  fail(
    `Release preparation expected only these files to change: ${expectedFiles.join(', ')}. Found: ${actualFiles.join(', ') || 'none'}`
  )
}

git(['add', '--all'])
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

console.log(`\nPrepared and pushed ${tag}. Nothing has been published to npm.`)
console.log('\nNext:')
console.log(
  `  1. Wait for the desktop-release workflow to publish the single GitHub Release for ${tag}.`
)
console.log(`  2. Run: pnpm release:publish ${version}`)
