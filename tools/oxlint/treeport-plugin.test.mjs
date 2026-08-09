import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, test } from 'vitest'

const temporaryDirectories = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true }))
  )
})

test('rejects Record<string, unknown> without rejecting other record types', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'treeport-oxlint-'))
  temporaryDirectories.push(directory)
  const pluginPath = fileURLToPath(
    new URL('./treeport-plugin.mjs', import.meta.url)
  )
  const oxlintPath = fileURLToPath(
    new URL('../../node_modules/.bin/oxlint', import.meta.url)
  )
  await fs.writeFile(
    path.join(directory, '.oxlintrc.json'),
    JSON.stringify({
      jsPlugins: [pluginPath],
      rules: {
        'no-unused-vars': 'off',
        'treeport/no-record-string-unknown': 'error'
      }
    })
  )
  await fs.writeFile(
    path.join(directory, 'fixture.ts'),
    [
      'type Rejected = Record<string, unknown>',
      'type AllowedValue = Record<string, string>',
      'type AllowedKey = Record<number, unknown>'
    ].join('\n')
  )

  let output = ''
  try {
    execFileSync(oxlintPath, ['--format=unix', 'fixture.ts'], {
      cwd: directory,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (error) {
    output = `${error.stdout ?? ''}${error.stderr ?? ''}`
  }

  expect(output).toContain(
    'Replace this generic record with a domain type, and parse the data as early and as close to its I/O boundary as possible.'
  )
  expect(output).toContain('1 problem')
})
