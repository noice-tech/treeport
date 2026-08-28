import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('release publication', () => {
  it('publishes prepared packages without running repository checks', () => {
    const temporaryDirectory = mkdtempSync(
      path.join(os.tmpdir(), 'treeport-publish-release-test-')
    )
    const repository = path.join(temporaryDirectory, 'repository')
    const bin = path.join(temporaryDirectory, 'bin')
    const callsPath = path.join(temporaryDirectory, 'pnpm-calls')
    mkdirSync(path.join(repository, 'scripts'), { recursive: true })
    mkdirSync(path.join(repository, 'apps/treeport'), { recursive: true })
    mkdirSync(path.join(repository, 'apps/desktop'), { recursive: true })
    mkdirSync(path.join(repository, 'packages/panel-sdk'), { recursive: true })
    mkdirSync(path.join(repository, 'packages/pi'), { recursive: true })
    mkdirSync(bin)

    const executable = (name, source) => {
      const filePath = path.join(bin, name)
      writeFileSync(filePath, `#!/usr/bin/env node\n${source}`)
      chmodSync(filePath, 0o755)
    }

    try {
      cpSync(
        path.resolve('scripts/publish-release.mjs'),
        path.join(repository, 'scripts/publish-release.mjs')
      )
      cpSync(
        path.resolve('scripts/release-utils.mjs'),
        path.join(repository, 'scripts/release-utils.mjs')
      )
      writeFileSync(
        path.join(repository, 'apps/treeport/package.json'),
        '{\n  "name": "@treeport/treeport",\n  "version": "0.4.0"\n}\n'
      )
      writeFileSync(
        path.join(repository, 'apps/desktop/package.json'),
        '{\n  "name": "@treeport/desktop",\n  "version": "0.4.0"\n}\n'
      )
      writeFileSync(
        path.join(repository, 'packages/panel-sdk/package.json'),
        '{\n  "name": "@treeport/panel-sdk",\n  "version": "0.4.0"\n}\n'
      )
      writeFileSync(
        path.join(repository, 'packages/pi/package.json'),
        '{\n  "name": "@treeport/pi",\n  "version": "0.4.0"\n}\n'
      )

      executable(
        'git',
        `const args = process.argv.slice(2).join(' ')
const values = new Map([
  ['config --get remote.origin.url', 'git@github.com:noice-tech/treeport.git'],
  ['rev-parse --abbrev-ref HEAD', 'main'],
  ['rev-parse HEAD', 'release-commit'],
  ['rev-parse refs/remotes/origin/main', 'release-commit'],
  ['rev-list -n 1 v0.4.0', 'release-commit'],
  ['rev-parse refs/tags/v0.4.0', 'annotated-tag'],
  ['ls-remote --tags origin refs/tags/v0.4.0', 'annotated-tag\\trefs/tags/v0.4.0']
])
if (values.has(args)) process.stdout.write(values.get(args) + '\\n')
else if (args === 'status --porcelain' || args === 'fetch origin main --tags' || args === 'show-ref --verify --quiet refs/tags/v0.4.0') process.exit(0)
else { console.error('Unexpected git call: ' + args); process.exit(1) }
`
      )
      executable(
        'gh',
        `const args = process.argv.slice(2)
if (args[0] === 'release' && args[1] === 'view') {
  process.stdout.write(JSON.stringify({
    assets: [
      { name: 'Treeport-0.4.0-darwin-universal.dmg', size: 1, state: 'uploaded' },
      { name: 'Treeport-0.4.0-darwin-universal.zip', size: 1, state: 'uploaded' }
    ],
    isDraft: false,
    isPrerelease: false,
    tagName: 'v0.4.0',
    url: 'https://github.com/noice-tech/treeport/releases/tag/v0.4.0'
  }))
} else if (args[0] === 'api') {
  process.stdout.write(JSON.stringify([[{ tag_name: 'v0.4.0' }]]))
} else {
  console.error('Unexpected gh call: ' + args.join(' '))
  process.exit(1)
}
`
      )
      executable(
        'npm',
        `const args = process.argv.slice(2)
if (args[0] === 'whoami') {
  process.stdout.write('treeport-maintainer\\n')
} else if (args[0] === 'view' && args[2] === 'version') {
  console.error('npm error code E404')
  process.exit(1)
} else if (args[0] === 'view' && args[2] === 'dist-tags.latest') {
  process.stdout.write(JSON.stringify('0.3.0'))
} else {
  console.error('Unexpected npm call: ' + args.join(' '))
  process.exit(1)
}
`
      )
      executable(
        'pnpm',
        `const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.TREEPORT_TEST_PNPM_CALLS, args.join(' ') + '\\n')
if (args[0] === 'check') process.exit(9)
if (args[0] !== '--filter' || args[2] !== 'publish') process.exit(1)
`
      )

      const result = spawnSync(
        process.execPath,
        ['scripts/publish-release.mjs', '0.4.0'],
        {
          cwd: repository,
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            TREEPORT_TEST_PNPM_CALLS: callsPath
          }
        }
      )
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
      expect(readFileSync(callsPath, 'utf8').trim().split('\n')).toEqual([
        '--filter @treeport/panel-sdk publish --access public --tag latest --publish-branch main',
        '--filter @treeport/pi publish --access public --tag latest --publish-branch main',
        '--filter @treeport/treeport publish --access public --tag latest --publish-branch main'
      ])
      expect(result.stdout).toContain(
        'https://github.com/noice-tech/treeport/releases/tag/v0.4.0'
      )
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true })
    }
  })
})
