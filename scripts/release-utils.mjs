import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

export const githubRepository = 'noice-tech/treeport'
export const releaseManifestPaths = [
  'apps/treeport/package.json',
  'apps/desktop/package.json',
  'packages/panel-sdk/package.json',
  'packages/pi/package.json'
]

export function verifyVersions(version) {
  for (const file of releaseManifestPaths) {
    const manifest = JSON.parse(readFileSync(file, 'utf8'))
    if (manifest.version !== version) {
      throw new Error(`${file} is at ${manifest.version}, not ${version}`)
    }
  }
}

export function verifySource(tag = null) {
  const origin = git(['config', '--get', 'remote.origin.url'])
  if (githubRepositoryFromUrl(origin) !== githubRepository) {
    throw new Error(
      `origin must be the canonical ${githubRepository} repository; found ${origin}`
    )
  }

  if (git(['rev-parse', '--show-prefix'])) {
    throw new Error('Run release commands from the repository root')
  }

  if (git(['rev-parse', '--abbrev-ref', 'HEAD']) !== 'main') {
    throw new Error('Release commands must run from main')
  }

  if (git(['status', '--porcelain'])) {
    throw new Error('Working tree must be clean before releasing')
  }

  git(['fetch', 'origin', 'main'], { stdio: 'inherit' })
  const head = git(['rev-parse', 'HEAD'])
  if (head !== git(['rev-parse', 'refs/remotes/origin/main'])) {
    throw new Error(
      'Local main must exactly match origin/main before releasing'
    )
  }

  if (tag) {
    // Fetch only the requested tag. Never replace an existing local tag.
    git(['fetch', 'origin', `refs/tags/${tag}:refs/tags/${tag}`])
    if (git(['rev-list', '-n', '1', tag]) !== head) {
      throw new Error(
        `${tag} must point to the current main commit; never move the tag`
      )
    }

    const remote = git([
      'ls-remote',
      '--tags',
      'origin',
      `refs/tags/${tag}`
    ]).split(/\s+/)[0]
    if (remote !== git(['rev-parse', `refs/tags/${tag}`])) {
      throw new Error(
        `Local and origin tags differ or ${tag} is missing on origin`
      )
    }
  }

  return head
}

export function desktopAssetNames(version) {
  return ['dmg', 'zip'].map(
    (extension) => `Treeport-${version}-darwin-universal.${extension}`
  )
}

export function fileDigest(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

export function readRelease(tag, command = run) {
  // A failed API call is never treated as an absent release.
  const releases = JSON.parse(
    command('gh', [
      'api',
      '--paginate',
      '--slurp',
      `repos/${githubRepository}/releases?per_page=100`
    ])
  ).flat()
  const requested = parseVersion(tag.slice(1))
  const newer = releases.find((release) => {
    const published = release.tag_name.startsWith('v')
      ? parseVersion(release.tag_name.slice(1))
      : null
    return (
      !release.draft &&
      !release.prerelease &&
      requested &&
      published &&
      compareVersions(published, requested) > 0
    )
  })
  if (newer) {
    throw new Error(
      `A newer stable GitHub Release exists: ${newer.tag_name}; do not move latest backward`
    )
  }

  const matches = releases.filter((release) => release.tag_name === tag)
  if (matches.length > 1) {
    throw new Error(
      `Expected at most one GitHub Release for ${tag}; found ${matches.length}`
    )
  }

  return matches[0] ?? null
}

export function verifyReleaseAssets(
  release,
  version,
  { partial = false } = {}
) {
  const expected = desktopAssetNames(version)
  const names = release.assets.map((asset) => asset.name)
  if (
    new Set(names).size !== names.length ||
    names.some((name) => !expected.includes(name)) ||
    (!partial && names.length !== expected.length)
  ) {
    throw new Error(
      `GitHub Release must contain exactly: ${expected.join(', ')}. Found: ${names.join(', ') || 'none'}`
    )
  }

  for (const asset of release.assets) {
    if (asset.size <= 0 || asset.state !== 'uploaded') {
      throw new Error(
        `Release asset is incomplete: ${asset.name}; inspect the draft, do not overwrite it`
      )
    }
  }
}

const canonicalVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

export function fail(message) {
  console.error(message)
  process.exit(1)
}

export function run(command, args, options = {}) {
  const output =
    execFileSync(command, args, {
      cwd: options.cwd,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
      env: options.env ?? process.env
    })?.toString() ?? ''

  return options.trim === false ? output : output.trim()
}

export function git(args, options = {}) {
  return run('git', args, options)
}

export function parseVersion(value) {
  const match = canonicalVersionPattern.exec(value)
  return match ? match.slice(1).map((part) => BigInt(part)) : undefined
}

export function compareVersions(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] > right[index]) {
      return 1
    }

    if (left[index] < right[index]) {
      return -1
    }
  }
  return 0
}

function githubRepositoryFromUrl(url) {
  const scpMatch = /^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/.exec(url)
  if (scpMatch) {
    return scpMatch[1]
  }

  try {
    const parsedUrl = new URL(url)
    if (parsedUrl.hostname !== 'github.com') {
      return undefined
    }

    return parsedUrl.pathname.replace(/^\//, '').replace(/\.git$/, '')
  } catch {
    return undefined
  }
}
