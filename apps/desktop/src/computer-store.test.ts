import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ComputerStore, computerName } from './computer-store'

const directories: string[] = []

async function settingsPath(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'treeport-store-'))
  directories.push(directory)
  return path.join(directory, 'computers.json')
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true }))
  )
})

describe('desktop computer store', () => {
  it('persists selection, inferred names, edits, and active removal fallback', async () => {
    const filePath = await settingsPath()
    const store = await ComputerStore.load(filePath, 'http://127.0.0.1:8733')
    const local = store.selectedComputer!
    expect(computerName(local)).toBe('This computer')

    const remote = await store.add('https://vps.example.test/worktree?view=1')
    expect(remote.origin).toBe('https://vps.example.test')
    expect(store.selectedComputer?.id).toBe(remote.id)
    await store.rememberHostname(remote.id, 'development-vps')
    expect(computerName(store.getComputer(remote.id)!)).toBe('development-vps')

    await store.update(remote.id, {
      origin: remote.origin,
      nameOverride: 'Work VPS'
    })
    await store.rememberHostname(remote.id, 'renamed-by-os')
    expect(computerName(store.getComputer(remote.id)!)).toBe('Work VPS')
    expect(store.summaries()[0]?.id).toBe(local.id)

    await store.remove(remote.id)
    expect(store.selectedComputer?.id).toBe(local.id)
    const reopened = await ComputerStore.load(filePath, 'http://localhost:9999')
    expect(reopened.selectedComputer?.id).toBe(local.id)

    const originalRename = fs.rename.bind(fs)
    let releaseRename!: () => void
    const renameReleased = new Promise<void>((resolve) => {
      releaseRename = resolve
    })
    let reportRenameStarted!: () => void
    const renameStarted = new Promise<void>((resolve) => {
      reportRenameStarted = resolve
    })
    let delayNextRename = true
    const rename = vi
      .spyOn(fs, 'rename')
      .mockImplementation(async (oldPath, newPath) => {
        if (delayNextRename) {
          delayNextRename = false
          reportRenameStarted()
          await renameReleased
        }

        await originalRename(oldPath, newPath)
      })

    const concurrentRemotePromise = reopened.add('https://second.example.test')
    await renameStarted
    const selectLocalPromise = reopened.select(local.id)
    await new Promise((resolve) => setTimeout(resolve, 25))
    releaseRename()
    const [concurrentRemote] = await Promise.all([
      concurrentRemotePromise,
      selectLocalPromise
    ])
    rename.mockRestore()

    const serialized = await ComputerStore.load(
      filePath,
      'http://localhost:9999'
    )
    expect(serialized.selectedComputer?.id).toBe(local.id)

    await reopened.remove(concurrentRemote.id)
    await reopened.remove(local.id)
    expect(reopened.selectedComputer).toBeUndefined()
    expect(reopened.summaries()).toEqual([])
  })

  it('recovers an invalid settings file to the seeded local connection', async () => {
    const filePath = await settingsPath()
    await fs.writeFile(filePath, '{"version":1,"computers":"invalid"}')

    const store = await ComputerStore.load(filePath, 'http://localhost:9000')
    expect(store.selectedComputer?.origin).toBe('http://localhost:9000')
    expect(
      (await fs.readdir(path.dirname(filePath))).some((name) =>
        name.startsWith('computers.json.invalid-')
      )
    ).toBe(true)
  })

  it('preserves invalid settings when creating the recovery backup fails', async () => {
    const filePath = await settingsPath()
    const invalidContents = '{"version":1,"computers":"invalid"}'
    const timestamp = 1_700_000_000_000
    await fs.writeFile(filePath, invalidContents)
    await fs.mkdir(`${filePath}.invalid-${timestamp}`)
    vi.spyOn(Date, 'now').mockReturnValue(timestamp)

    await expect(
      ComputerStore.load(filePath, 'http://localhost:9000')
    ).rejects.toMatchObject({ code: 'EISDIR' })
    await expect(fs.readFile(filePath, 'utf8')).resolves.toBe(invalidContents)
  })
})
