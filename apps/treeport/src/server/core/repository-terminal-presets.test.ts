import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { loadRepositoryTerminalPresets } from './repository-terminal-presets'

const temporary: string[] = []
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true }))
  )
})

it('reads presets from the current tree settings alongside other sections', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'treeport-presets-'))
  temporary.push(root)
  for (const tree of ['main', 'topic']) {
    await fs.mkdir(path.join(root, tree, '.treeport'), { recursive: true })
    await fs.writeFile(
      path.join(root, tree, '.treeport', 'settings.json'),
      JSON.stringify({
        setup: { commands: [] },
        packages: [],
        treeContext: { fields: [] },
        terminalPresets: {
          shell: {
            name: tree,
            executable: 'bash',
            args: ['-l'],
            closeOnSuccess: true
          }
        }
      })
    )
  }
  const result = await loadRepositoryTerminalPresets(
    'project',
    path.join(root, 'topic')
  )
  expect(result.diagnostics).toEqual([])
  expect(result.definitions).toEqual([
    {
      id: 'repository:project:terminal-preset:shell',
      name: 'topic',
      executable: 'bash',
      args: ['-l'],
      shellCommand: null,
      cwd: null,
      env: {},
      closeOnSuccess: true,
      source: { type: 'repository', format: 'treeport' }
    }
  ])
})

it('allows absent presets and diagnoses invalid settings and individual presets', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'treeport-presets-'))
  temporary.push(root)
  await fs.mkdir(path.join(root, '.treeport'))
  const file = path.join(root, '.treeport', 'settings.json')
  expect(await loadRepositoryTerminalPresets('project', root)).toEqual({
    definitions: [],
    diagnostics: []
  })
  for (const settings of [
    {},
    { setup: { commands: [] }, packages: [] },
    { terminalPresets: {} }
  ]) {
    await fs.writeFile(file, JSON.stringify(settings))
    expect(await loadRepositoryTerminalPresets('project', root)).toEqual({
      definitions: [],
      diagnostics: []
    })
  }
  for (const content of [
    'null',
    '[]',
    '{"terminalPresets":[]}',
    '{"terminalPresets":null}',
    '{ /* comment */ }',
    '{ "terminalPresets": {}, }'
  ]) {
    await fs.writeFile(file, content)
    const result = await loadRepositoryTerminalPresets('project', root)
    expect(result.definitions).toEqual([])
    expect(result.diagnostics, content).toEqual([
      expect.objectContaining({
        path: '.treeport/settings.json',
        itemId: null
      })
    ])
  }
  await fs.writeFile(
    file,
    JSON.stringify({
      terminalPresets: {
        invalid: { name: 'Invalid', executable: '', args: [] },
        valid: { name: 'Valid', executable: 'bash', args: [] }
      }
    })
  )
  const result = await loadRepositoryTerminalPresets('project', root)
  expect(result.definitions).toEqual([
    expect.objectContaining({
      name: 'Valid',
      closeOnSuccess: false
    })
  ])
  expect(result.diagnostics).toEqual([
    expect.objectContaining({
      path: '.treeport/settings.json',
      itemId: 'invalid'
    })
  ])
})
