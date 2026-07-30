import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('release preparation', () => {
  it('prepares an initial release whose version is already in the manifests', () => {
    const temporaryDirectory = mkdtempSync(
      path.join(os.tmpdir(), 'treeport-prepare-release-test-')
    )
    const repository = path.join(temporaryDirectory, 'repository')
    const remote = path.join(temporaryDirectory, 'origin.git')
    const home = path.join(temporaryDirectory, 'home')
    const bin = path.join(temporaryDirectory, 'bin')
    mkdirSync(repository)
    mkdirSync(home)
    mkdirSync(bin)

    const environment = {
      ...process.env,
      GIT_ALLOW_PROTOCOL: 'file',
      GIT_CONFIG_NOSYSTEM: '1',
      HOME: home,
      PATH: `${bin}:${process.env.PATH}`
    }
    const git = (arguments_, options = {}) =>
      execFileSync('git', arguments_, {
        cwd: options.cwd ?? repository,
        encoding: 'utf8',
        env: environment,
        stdio: options.stdio ?? ['ignore', 'pipe', 'pipe']
      }).trim()

    try {
      git(['init', '--bare', remote], { cwd: temporaryDirectory })
      git(['init', '-b', 'main'])
      git(['config', 'user.name', 'Treeport Release Test'])
      git(['config', 'user.email', 'release-test@treeport.local'])
      git([
        'config',
        '--global',
        `url.file://${remote}.insteadOf`,
        'git@github.com:noice-tech/treeport.git'
      ])

      mkdirSync(path.join(repository, 'scripts'))
      mkdirSync(path.join(repository, 'apps/treeport'), { recursive: true })
      mkdirSync(path.join(repository, 'apps/docs/public'), { recursive: true })
      cpSync(
        path.resolve('scripts/prepare-release.mjs'),
        path.join(repository, 'scripts/prepare-release.mjs')
      )
      cpSync(
        path.resolve('scripts/release-utils.mjs'),
        path.join(repository, 'scripts/release-utils.mjs')
      )
      writeFileSync(
        path.join(repository, 'apps/treeport/package.json'),
        '{\n  "name": "@treeport/treeport",\n  "version": "0.1.0"\n}\n'
      )
      writeFileSync(
        path.join(repository, 'apps/docs/public/install-manifest.json'),
        '{\n  "treeportVersion": "0.1.0"\n}\n'
      )
      writeFileSync(
        path.join(repository, 'apps/docs/public/install.sh'),
        'TREEPORT_VERSION="${TREEPORT_VERSION:-0.1.0}"\n'
      )
      const fakePnpm = path.join(bin, 'pnpm')
      writeFileSync(fakePnpm, '#!/bin/sh\nexit 0\n')
      chmodSync(fakePnpm, 0o755)

      git(['add', '.'])
      git(['commit', '-m', 'Initial version'])
      git(['remote', 'add', 'origin', 'git@github.com:noice-tech/treeport.git'])
      git(['push', '-u', 'origin', 'main'])
      const initialCommit = git(['rev-parse', 'HEAD'])

      const lowerVersion = spawnSync(
        process.execPath,
        ['scripts/prepare-release.mjs', '0.0.9'],
        { cwd: repository, encoding: 'utf8', env: environment }
      )
      expect(lowerVersion.status).toBe(1)
      expect(lowerVersion.stderr).toContain(
        'Requested version 0.0.9 must not be lower than 0.1.0'
      )
      expect(git(['rev-parse', 'HEAD'])).toBe(initialCommit)

      const release = spawnSync(
        process.execPath,
        ['scripts/prepare-release.mjs', '0.1.0'],
        { cwd: repository, encoding: 'utf8', env: environment }
      )
      expect(release.status, `${release.stdout}\n${release.stderr}`).toBe(0)

      const releaseCommit = git(['rev-parse', 'HEAD'])
      expect(releaseCommit).not.toBe(initialCommit)
      expect(git(['log', '-1', '--pretty=%s'])).toBe('Release 0.1.0')
      expect(
        git(['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'])
      ).toBe('')
      expect(git(['status', '--porcelain'])).toBe('')
      expect(git(['cat-file', '-t', 'refs/tags/v0.1.0'])).toBe('tag')
      expect(git(['rev-list', '-n', '1', 'v0.1.0'])).toBe(releaseCommit)
      expect(git(['--git-dir', remote, 'rev-parse', 'refs/heads/main'])).toBe(
        releaseCommit
      )
      expect(
        git(['--git-dir', remote, 'rev-parse', 'refs/tags/v0.1.0^{}'])
      ).toBe(releaseCommit)
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true })
    }
  })
})
