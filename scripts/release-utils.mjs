import { execFileSync } from 'node:child_process'

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
      stdio: options.stdio ?? ['ignore', 'pipe', 'pipe']
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

export function githubRepositoryFromUrl(url) {
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
