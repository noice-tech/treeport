import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadTreeContextFields } from './tree-context'

const directories: string[] = []

async function directory(name: string): Promise<string> {
  const result = await fs.mkdtemp(path.join(os.tmpdir(), `treeport-${name}-`))
  directories.push(result)
  return result
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((item) => fs.rm(item, { recursive: true, force: true }))
  )
})

describe('tree context field settings', () => {
  it('merges global and project fields and lets the project replace a field', async () => {
    const dataDir = await directory('context-data')
    const projectRoot = await directory('context-project')
    await fs.mkdir(path.join(projectRoot, '.treeport'))
    await fs.writeFile(
      path.join(dataDir, 'settings.json'),
      JSON.stringify({
        packages: [],
        treeContext: {
          fields: [
            { id: 'issue', label: 'Issue', input: 'text' },
            { id: 'requester', label: 'Requester', input: 'text' }
          ]
        }
      })
    )
    await fs.writeFile(
      path.join(projectRoot, '.treeport', 'settings.json'),
      JSON.stringify({
        treeContext: {
          fields: [
            { id: 'issue', label: 'Linear issue', input: 'text' },
            { id: 'brief', label: 'Description', input: 'textarea' }
          ]
        }
      })
    )

    await expect(
      loadTreeContextFields({ dataDir, projectRoot })
    ).resolves.toEqual({
      fields: [
        { id: 'issue', label: 'Linear issue', input: 'text' },
        { id: 'requester', label: 'Requester', input: 'text' },
        { id: 'brief', label: 'Description', input: 'textarea' }
      ],
      diagnostics: []
    })
  })

  it('keeps valid fields and reports invalid settings', async () => {
    const dataDir = await directory('context-invalid-data')
    const projectRoot = await directory('context-invalid-project')
    await fs.mkdir(path.join(projectRoot, '.treeport'))
    await fs.writeFile(
      path.join(dataDir, 'settings.json'),
      JSON.stringify({
        treeContext: {
          fields: [
            { id: 'valid', label: 'Valid field', input: 'text' },
            { id: 'Not Valid', label: '', input: 'select' },
            { id: 'valid', label: 'Duplicate', input: 'text' }
          ]
        }
      })
    )
    await fs.writeFile(
      path.join(projectRoot, '.treeport', 'settings.json'),
      '{ invalid'
    )

    const result = await loadTreeContextFields({ dataDir, projectRoot })
    expect(result.fields).toEqual([
      { id: 'valid', label: 'Valid field', input: 'text' }
    ])
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        scope: 'global',
        message: expect.stringContaining('treeContext.fields[1] is invalid')
      }),
      expect.objectContaining({
        scope: 'global',
        message: expect.stringContaining(
          'contains duplicate tree context field valid'
        )
      }),
      expect.objectContaining({
        scope: 'project',
        message: expect.stringContaining('Could not parse')
      })
    ])
  })
})
