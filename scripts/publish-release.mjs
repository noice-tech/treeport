#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import {
  compareVersions,
  fail,
  git,
  githubRepositoryFromUrl,
  parseVersion,
  run
} from './release-utils.mjs'

const githubRepository = 'noice-tech/treeport'
const packageDirectories = ['packages/panel-sdk', 'apps/treeport']
const packageManifests = packageDirectories.map((directory) =>
  JSON.parse(readFileSync(`${directory}/package.json`, 'utf8'))
)
const [version, ...extraArguments] = process.argv.slice(2)
if (!version || extraArguments.length > 0) {
  fail('Usage: pnpm release:publish <X.Y.Z>')
}

if (!parseVersion(version)) {
  fail(
    `Invalid version: ${version}. Expected canonical X.Y.Z without leading zeroes`
  )
}

for (const manifest of packageManifests) {
  if (manifest.version !== version) {
    fail(`${manifest.name} is at ${manifest.version}, not ${version}`)
  }
}

const tag = `v${version}`
const originUrl = git(['config', '--get', 'remote.origin.url'])
if (githubRepositoryFromUrl(originUrl) !== githubRepository) {
  fail(
    `origin must be the canonical ${githubRepository} repository; found ${originUrl}`
  )
}

if (git(['rev-parse', '--abbrev-ref', 'HEAD']) !== 'main') {
  fail('Release publication must run from main')
}

if (git(['status', '--porcelain'])) {
  fail('Working tree must be clean before publishing a release')
}

function verifyRelease() {
  try {
    git(['fetch', 'origin', 'main', '--tags'], { stdio: 'inherit' })
  } catch {
    fail('Could not fetch origin/main and tags; publication stopped')
  }
  const localHead = git(['rev-parse', 'HEAD'])
  if (localHead !== git(['rev-parse', 'refs/remotes/origin/main'])) {
    fail('Local main must exactly match origin/main before publishing')
  }

  try {
    git(['show-ref', '--verify', '--quiet', `refs/tags/${tag}`])
  } catch (error) {
    if (error.status === 1) {
      fail(`Tag does not exist locally: ${tag}`)
    }

    throw error
  }
  if (git(['rev-list', '-n', '1', tag]) !== localHead) {
    fail(`${tag} must point to the current main commit`)
  }

  const localTagObject = git(['rev-parse', `refs/tags/${tag}`])
  const remoteTagObject = git([
    'ls-remote',
    '--tags',
    'origin',
    `refs/tags/${tag}`
  ])
    .split('\n')
    .find((line) => line.endsWith(`refs/tags/${tag}`))
    ?.split(/\s+/)[0]
  if (!remoteTagObject || remoteTagObject !== localTagObject) {
    fail(`Local and origin tags differ or ${tag} is missing on origin`)
  }

  let release
  try {
    release = JSON.parse(
      run('gh', [
        'release',
        'view',
        tag,
        '--repo',
        githubRepository,
        '--json',
        'isDraft,isPrerelease,tagName,url'
      ])
    )
  } catch {
    fail(
      `Could not read the GitHub Release for ${tag}. Create it and authenticate gh before publishing.`
    )
  }
  if (release.tagName !== tag || release.isDraft || release.isPrerelease) {
    fail(`GitHub Release ${tag} must be published and must not be a prerelease`)
  }

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
  console.log(release.url)
  process.exit(0)
}

try {
  run('pnpm', ['check'], { stdio: 'inherit' })
} catch {
  fail('Repository checks failed; nothing was published')
}
if (git(['status', '--porcelain'])) {
  fail('Repository checks changed the working tree; publication stopped')
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

console.log(release.url)
