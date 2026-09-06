import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { publishDesktopRelease } from './github-release.mjs'
import { desktopAssetNames, fileDigest } from './release-utils.mjs'

const directories = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

// Real temporary artifact bytes, but no network, git mutations, or Apple keys.
function fixture() {
  const directory = mkdtempSync(
    path.join(os.tmpdir(), 'treeport-publish-test-')
  )
  directories.push(directory)
  const artifacts = desktopAssetNames('0.7.0').map((name) => {
    const file = path.join(directory, name)
    writeFileSync(file, `verified ${name}`)
    return {
      name,
      path: file,
      size: readFileSync(file).length,
      sha256: fileDigest(file)
    }
  })
  const state = {
    releases: [],
    mutations: [],
    failAfter: null,
    corruptDownload: false,
    sourceChecks: 0
  }
  const draft = () => ({
    id: 42,
    tag_name: 'v0.7.0',
    draft: true,
    prerelease: false,
    html_url: 'https://github.com/noice-tech/treeport/releases/tag/v0.7.0',
    assets: []
  })
  const command = (program, args, options) => {
    expect(program).toBe('gh')
    if (args.includes('--paginate')) {
      return JSON.stringify([state.releases])
    }

    if (args.includes('Accept: application/octet-stream')) {
      const id = Number(args.at(-1).split('/').at(-1))
      writeFileSync(
        options.stdio[1],
        state.corruptDownload
          ? 'corrupted'
          : readFileSync(artifacts[id - 1].path)
      )
      return ''
    }

    state.mutations.push(args)
    if (args[1] === 'create') {
      expect(state.releases).toHaveLength(0)
      expect(args).toContain('--verify-tag')
      expect(args).toContain('--draft')
      state.releases.push(draft())
    } else if (args[1] === 'upload') {
      expect(args).not.toContain('--clobber')
      const artifact = artifacts.find((entry) => entry.path === args[3])
      const assets = state.releases[0].assets
      expect(assets.some((entry) => entry.name === artifact.name)).toBe(false)
      assets.push({
        id: artifacts.indexOf(artifact) + 1,
        name: artifact.name,
        size: artifact.size,
        state: 'uploaded'
      })
    } else if (args.includes('PATCH')) {
      expect(state.releases[0].assets).toHaveLength(2)
      state.releases[0].draft = false
    } else {
      throw new Error(`Unexpected command ${args.join(' ')}`)
    }

    if (state.failAfter && args.includes(state.failAfter)) {
      state.failAfter = null
      throw new Error('Connection lost after remote mutation')
    }

    return ''
  }
  const publish = () =>
    publishDesktopRelease(
      '0.7.0',
      artifacts,
      () => {
        state.sourceChecks += 1
      },
      command
    )
  return { state, artifacts, draft, command, publish }
}

describe('single local GitHub release publication', () => {
  it('creates one draft, verifies uploaded bytes, then publishes the same release', () => {
    const { state, publish } = fixture()
    expect(publish()).toContain('/tag/v0.7.0')
    expect(state.releases).toHaveLength(1)
    expect(state.releases[0].draft).toBe(false)
    expect(state.mutations.map((args) => args[1])).toEqual([
      'create',
      'upload',
      'upload',
      '--method'
    ])
    expect(state.sourceChecks).toBeGreaterThanOrEqual(4)
  })

  it.each(['create', 'upload', 'PATCH'])(
    'resumes an ambiguous %s failure without replacing anything',
    (operation) => {
      const { state, publish } = fixture()
      state.failAfter = operation
      expect(publish).toThrow('Connection lost')
      expect(publish()).toContain('/tag/v0.7.0')
      expect(
        state.mutations.filter((args) => args[1] === 'create')
      ).toHaveLength(1)
      expect(
        state.mutations.filter((args) => args[1] === 'upload')
      ).toHaveLength(2)
      expect(
        state.mutations.filter((args) => args.includes('PATCH'))
      ).toHaveLength(1)
      const count = state.mutations.length
      publish()
      expect(state.mutations).toHaveLength(count)
    }
  )

  it('refuses different remote bytes even when names and sizes match', () => {
    const { state, publish } = fixture()
    state.failAfter = 'upload'
    expect(publish).toThrow('Connection lost')
    state.corruptDownload = true
    const count = state.mutations.length
    expect(publish).toThrow('Uploaded bytes differ')
    expect(state.mutations).toHaveLength(count)
    expect(state.releases[0].draft).toBe(true)
  })

  it.each([
    'duplicate releases',
    'prerelease',
    'unexpected asset',
    'incomplete asset',
    'duplicate assets',
    'published partial',
    'newer stable'
  ])('stops on %s before any mutation', (scenario) => {
    const { state, draft, artifacts, publish } = fixture()
    const release = draft()
    const asset = {
      id: 1,
      name: artifacts[0].name,
      size: artifacts[0].size,
      state: 'uploaded'
    }
    state.releases.push(release)
    if (scenario === 'duplicate releases') {
      state.releases.push(draft())
    }

    if (scenario === 'prerelease') {
      release.prerelease = true
    }

    if (scenario === 'unexpected asset') {
      release.assets.push({ ...asset, name: 'wrong.zip' })
    }

    if (scenario === 'incomplete asset') {
      release.assets.push({ ...asset, state: 'starter' })
    }

    if (scenario === 'duplicate assets') {
      release.assets.push(asset, asset)
    }

    if (scenario === 'published partial') {
      release.draft = false
    }

    if (scenario === 'newer stable') {
      state.releases.push({ ...draft(), tag_name: 'v0.8.0', draft: false })
    }

    expect(publish).toThrow()
    expect(state.mutations).toHaveLength(0)
  })

  it('leaves a complete draft unpublished if source changes before publication', () => {
    const { state, artifacts, command, publish } = fixture()
    let checks = 0
    expect(() =>
      publishDesktopRelease(
        '0.7.0',
        artifacts,
        () => {
          checks += 1
          if (checks === 4) {
            throw new Error('main advanced')
          }
        },
        command
      )
    ).toThrow('main advanced')
    expect(state.releases[0].draft).toBe(true)
    expect(state.releases[0].assets).toHaveLength(2)
    expect(state.mutations.some((args) => args.includes('PATCH'))).toBe(false)
    expect(publish()).toContain('/tag/v0.7.0')
  })

  it('rejects changed local artifacts during resume', () => {
    const { state, artifacts, publish } = fixture()
    state.failAfter = 'upload'
    expect(publish).toThrow('Connection lost')
    const count = state.mutations.length
    writeFileSync(artifacts[0].path, 'different local build')
    expect(publish).toThrow('Asset does not match the verified build')
    expect(state.mutations).toHaveLength(count)
  })

  it('does not treat API failure as a missing release', () => {
    const { artifacts } = fixture()
    expect(() =>
      publishDesktopRelease(
        '0.7.0',
        artifacts,
        () => {},
        () => {
          throw new Error('GitHub unavailable')
        }
      )
    ).toThrow('GitHub unavailable')
  })

  it('stops before creating a release when source validation fails', () => {
    const { state, artifacts, command } = fixture()
    expect(() =>
      publishDesktopRelease(
        '0.7.0',
        artifacts,
        () => {
          throw new Error('Tag differs from main')
        },
        command
      )
    ).toThrow('Tag differs')
    expect(state.mutations).toHaveLength(0)
  })
})
