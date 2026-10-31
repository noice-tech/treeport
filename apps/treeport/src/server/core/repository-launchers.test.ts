import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { loadRepositoryLaunchers } from './repository-launchers.ts'

const temporary: string[] = []

afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true }))
  )
})

it('reads launchers from the current tree settings alongside other sections', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'treeport-launchers-'))
  temporary.push(root)

  for (const tree of ['main', 'topic']) {
    await fs.mkdir(path.join(root, tree, '.treeport'), { recursive: true })
    await fs.writeFile(
      path.join(root, tree, '.treeport', 'settings.json'),
      JSON.stringify({
        setup: { commands: [] },
        packages: [],
        launchers: {
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

  const result = await loadRepositoryLaunchers(
    'project',
    path.join(root, 'topic')
  )

  expect(result.diagnostics).toEqual([])
  expect(result.definitions).toEqual([
    {
      id: 'repository:project:launcher:shell',
      name: 'topic',
      executable: 'bash',
      args: ['-l'],
      shellCommand: null,
      cwd: null,
      env: {},
      closeOnSuccess: true,
      treeTitle: null,
      source: { type: 'repository', format: 'treeport' }
    }
  ])
})

it('allows absent launchers and diagnoses invalid settings and individual launchers', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'treeport-launchers-'))
  temporary.push(root)
  await fs.mkdir(path.join(root, '.treeport'))
  const file = path.join(root, '.treeport', 'settings.json')
  expect(await loadRepositoryLaunchers('project', root)).toEqual({
    definitions: [],
    diagnostics: []
  })

  for (const settings of [
    {},
    { setup: { commands: [] }, packages: [] },
    { launchers: {} }
  ]) {
    await fs.writeFile(file, JSON.stringify(settings))
    expect(await loadRepositoryLaunchers('project', root)).toEqual({
      definitions: [],
      diagnostics: []
    })
  }

  for (const content of [
    'null',
    '[]',
    '{"launchers":[]}',
    '{"launchers":null}',
    '{ /* comment */ }',
    '{ "launchers": {}, }'
  ]) {
    await fs.writeFile(file, content)
    const result = await loadRepositoryLaunchers('project', root)
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
      launchers: {
        invalid: { name: 'Invalid', executable: '', args: [] },
        valid: { name: 'Valid', executable: 'bash', args: [] }
      }
    })
  )
  const result = await loadRepositoryLaunchers('project', root)
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
