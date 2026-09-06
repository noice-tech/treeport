import { closeSync, mkdtempSync, openSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  fileDigest,
  githubRepository,
  readRelease,
  run,
  verifyReleaseAssets
} from './release-utils.mjs'

// Never replace an asset. A retry must prove that uploaded bytes are identical
// to the locally verified build, including after an ambiguous upload/PATCH failure.
export function publishDesktopRelease(
  version,
  artifacts,
  verifySource,
  command = run
) {
  const tag = `v${version}`
  let release = readRelease(tag, command)
  const verifyRemote = (candidate, partial) => {
    if (!candidate || candidate.tag_name !== tag || candidate.prerelease) {
      throw new Error(`Expected one stable release for ${tag}`)
    }

    verifyReleaseAssets(candidate, version, { partial })
    const directory = mkdtempSync(
      path.join(os.tmpdir(), 'treeport-release-download-')
    )
    try {
      for (const asset of candidate.assets) {
        const local = artifacts.find((artifact) => artifact.name === asset.name)
        if (
          !local ||
          asset.size !== local.size ||
          fileDigest(local.path) !== local.sha256
        ) {
          throw new Error(
            `Asset does not match the verified build: ${asset.name}`
          )
        }

        const download = path.join(directory, asset.name)
        const descriptor = openSync(download, 'wx')
        try {
          command(
            'gh',
            [
              'api',
              '-H',
              'Accept: application/octet-stream',
              `repos/${githubRepository}/releases/assets/${asset.id}`
            ],
            { stdio: ['ignore', descriptor, 'pipe'] }
          )
        } finally {
          closeSync(descriptor)
        }
        if (fileDigest(download) !== local.sha256) {
          throw new Error(
            `Uploaded bytes differ for ${asset.name}; stop and inspect the release, never clobber`
          )
        }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
  verifySource()
  if (release) {
    verifyRemote(release, release.draft)
  }

  if (!release) {
    command('gh', [
      'release',
      'create',
      tag,
      '--repo',
      githubRepository,
      '--verify-tag',
      '--draft',
      '--title',
      tag,
      '--generate-notes'
    ])
    release = readRelease(tag, command)
    if (!release?.draft) {
      throw new Error('Expected one draft after creation; stopped')
    }

    verifyRemote(release, true)
  }

  const releaseId = release.id
  if (release.draft) {
    for (const artifact of artifacts) {
      release = readRelease(tag, command)
      if (release?.id !== releaseId || !release.draft) {
        throw new Error('Release changed during upload; stopped')
      }

      verifyRemote(release, true)
      if (release.assets.some((asset) => asset.name === artifact.name)) {
        continue
      }

      if (fileDigest(artifact.path) !== artifact.sha256) {
        throw new Error(`Local artifact changed: ${artifact.name}`)
      }

      verifySource()
      command('gh', [
        'release',
        'upload',
        tag,
        artifact.path,
        '--repo',
        githubRepository
      ])
    }
    release = readRelease(tag, command)
    if (release?.id !== releaseId || !release.draft) {
      throw new Error('Release changed before publication; stopped')
    }

    verifyRemote(release, false)
    verifySource()
    command('gh', [
      'api',
      '--method',
      'PATCH',
      `repos/${githubRepository}/releases/${releaseId}`,
      '-F',
      'draft=false',
      '-F',
      'prerelease=false',
      '-f',
      'make_latest=true'
    ])
  }

  // A published release is read-only on resume, including updater-feed failures.
  release = readRelease(tag, command)
  if (release?.id !== releaseId || release.draft) {
    throw new Error(
      'The GitHub Release did not become a published stable release'
    )
  }

  verifyRemote(release, false)
  return release.html_url
}
