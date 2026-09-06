#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import {
  compareVersions,
  fail,
  readRelease,
  verifyReleaseAssets,
  verifySource,
  verifyVersions,
  parseVersion,
  run
} from './release-utils.mjs'

const packageDirectories = [
  'packages/panel-sdk',
  'packages/pi',
  'apps/treeport'
]
const packageManifests = packageDirectories.map((directory) =>
  JSON.parse(readFileSync(`${directory}/package.json`, 'utf8'))
)
const [version, ...extraArguments] = process.argv.slice(2)
const help = `Usage: pnpm release:publish <X.Y.Z>

Manual npm publication only. Run after release:desktop succeeds.
Requires npm authentication, clean main matching origin/main and vX.Y.Z,
aligned package versions, and exactly one published stable GitHub Release
with the universal DMG and updater ZIP. Existing npm versions are skipped.
Partial npm publication can be retried. This command never builds desktop
artifacts, pushes Git refs, or changes GitHub Releases.
Agents must leave this command to the user.`
if (version === '--help' && !extraArguments.length) {
  console.log(help)
  process.exit(0)
}

if (!version || extraArguments.length) {
  fail(help)
}

if (!parseVersion(version)) {
  fail(
    `Invalid version: ${version}. Expected canonical X.Y.Z without leading zeroes`
  )
}

verifyVersions(version)
const tag = `v${version}`

function verifyRelease() {
  verifySource(tag)
  const release = readRelease(tag)
  if (!release || release.draft || release.prerelease) {
    fail(
      `GitHub Release ${tag} must be published and stable. Complete release:desktop first.`
    )
  }

  verifyReleaseAssets(release, version)
  return release
}

function npmNotFound(result) {
  return /E404|404 Not Found|No match found for version/i.test(
    `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  )
}

function npmVersionExists(spec) {
  const result = spawnSync('npm', ['view', spec, 'version', '--json'], {
    encoding: 'utf8'
  })
  if (result.status === 0) {
    try {
      return JSON.parse(result.stdout) === version
    } catch {
      fail(`npm returned an unreadable version for ${spec}`)
    }
  }

  if (npmNotFound(result)) {
    return false
  }

  fail(
    `Could not inspect ${spec} on npm:\n${(result.stderr || result.stdout).trim()}`
  )
}

let release = verifyRelease()
let npmUser
try {
  npmUser = run('npm', ['whoami'])
} catch {
  fail('npm authentication failed. Run `npm login`, then retry.')
}
console.log(`Authenticated to npm as ${npmUser}.`)

const packagesToPublish = []
for (const manifest of packageManifests) {
  const spec = `${manifest.name}@${version}`
  if (npmVersionExists(spec)) {
    console.log(`${spec} is already published.`)
    continue
  }

  const latestResult = spawnSync(
    'npm',
    ['view', manifest.name, 'dist-tags.latest', '--json'],
    { encoding: 'utf8' }
  )
  if (latestResult.status === 0) {
    let latest
    try {
      latest = JSON.parse(latestResult.stdout)
    } catch {
      fail(`npm returned an unreadable latest version for ${manifest.name}`)
    }
    const parsedLatest = parseVersion(latest)
    if (!parsedLatest) {
      fail(`${manifest.name}'s latest tag is not canonical: ${latest}`)
    }

    if (compareVersions(parseVersion(version), parsedLatest) < 0) {
      fail(
        `Publishing ${manifest.name}@${version} would move latest backward from ${latest}`
      )
    }
  } else if (!npmNotFound(latestResult)) {
    fail(
      `Could not inspect ${manifest.name}'s latest tag:\n${(latestResult.stderr || latestResult.stdout).trim()}`
    )
  }

  packagesToPublish.push(manifest)
}

if (packagesToPublish.length === 0) {
  console.log('All packages are already published.')
  console.log(release.html_url)
  process.exit(0)
}

release = verifyRelease()

for (const manifest of packagesToPublish) {
  const spec = `${manifest.name}@${version}`
  console.log(`Publishing ${spec} with npm tag latest...`)
  try {
    run(
      'pnpm',
      [
        '--filter',
        manifest.name,
        'publish',
        '--access',
        'public',
        '--tag',
        'latest',
        '--publish-branch',
        'main'
      ],
      { stdio: 'inherit' }
    )
  } catch {
    fail(
      `npm publication failed. Inspect npm, then retry \`pnpm release:publish ${version}\`; existing exact versions will be detected safely.`
    )
  }

  console.log(`Published ${spec}.`)
}

console.log(release.html_url)
