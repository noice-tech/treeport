import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Effect from 'effect/Effect'
import { ComputerStore, computerName } from './computer-store'
import { DesktopRuntime } from './desktop-runtime'

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
    const store = await Effect.runPromise(
      ComputerStore.load(filePath, 'http://127.0.0.1:8733')
    )
    const local = store.selectedComputer!
    expect(computerName(local)).toBe('This computer')
    const remote = await Effect.runPromise(
      store.add('https://vps.example.test/worktree?view=1')
    )
    expect(remote.origin).toBe('https://vps.example.test')
    expect(store.selectedComputer?.id).toBe(remote.id)
    await Effect.runPromise(
      store.rememberHostname(remote.id, 'development-vps')
    )
    expect(computerName(store.getComputer(remote.id)!)).toBe('development-vps')
    await Effect.runPromise(
      store.update(remote.id, {
        origin: remote.origin,
        nameOverride: 'Work VPS'
      })
    )
    await Effect.runPromise(store.rememberHostname(remote.id, 'renamed-by-os'))
    expect(computerName(store.getComputer(remote.id)!)).toBe('Work VPS')
    expect(store.summaries()[0]?.id).toBe(local.id)
    await Effect.runPromise(store.remove(remote.id))
    expect(store.selectedComputer?.id).toBe(local.id)
    const reopened = await Effect.runPromise(
      ComputerStore.load(filePath, 'http://localhost:9999')
    )
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
    const concurrentRemotePromise = Effect.runPromise(
      reopened.add('https://second.example.test')
    )
    await renameStarted
    // Readers see committed settings, not the in-flight draft.
    expect(reopened.selectedComputer?.id).toBe(local.id)
    const selectLocalPromise = Effect.runPromise(reopened.select(local.id))
    releaseRename()
    const [concurrentRemote] = await Promise.all([
      concurrentRemotePromise,
      selectLocalPromise
    ])
    rename.mockRestore()
    const serialized = await Effect.runPromise(
      ComputerStore.load(filePath, 'http://localhost:9999')
    )
    expect(serialized.selectedComputer?.id).toBe(local.id)
    await Effect.runPromise(reopened.remove(concurrentRemote.id))
    await Effect.runPromise(reopened.remove(local.id))
    expect(reopened.selectedComputer).toBeUndefined()
    expect(reopened.summaries()).toEqual([])
  })

  it('synchronizes a selected development server when its dynamic port changes', async () => {
    const filePath = await settingsPath()
    const store = await Effect.runPromise(
      ComputerStore.load(filePath, 'http://localhost:5173')
    )
    const localId = store.selectedComputer!.id
    const remote = await Effect.runPromise(
      store.add('https://vps.example.test')
    )
    await Effect.runPromise(store.select(localId))
    const reopened = await Effect.runPromise(
      ComputerStore.load(filePath, 'http://127.0.0.1:5174', {
        synchronizeSelectedLoopback: true
      })
    )
    expect(reopened.selectedComputer).toMatchObject({
      id: localId,
      origin: 'http://127.0.0.1:5174'
    })
    expect(reopened.summaries()).toHaveLength(2)
    const persisted = await Effect.runPromise(
      ComputerStore.load(filePath, 'http://localhost:9999')
    )
    expect(persisted.selectedComputer?.origin).toBe('http://127.0.0.1:5174')
    const existingLocal = await Effect.runPromise(
      persisted.add('http://127.0.0.1:5175')
    )
    await Effect.runPromise(persisted.select(localId))
    const reused = await Effect.runPromise(
      ComputerStore.load(filePath, 'http://127.0.0.1:5175', {
        synchronizeSelectedLoopback: true
      })
    )
    expect(reused.selectedComputer?.id).toBe(existingLocal.id)
    expect(
      reused.summaries().filter((computer) => computer.origin.endsWith(':5175'))
    ).toHaveLength(1)
    await Effect.runPromise(reused.select(remote.id))
    const remotePreserved = await Effect.runPromise(
      ComputerStore.load(filePath, 'http://localhost:5176', {
        synchronizeSelectedLoopback: true
      })
    )
    expect(remotePreserved.selectedComputer).toMatchObject({
      id: remote.id,
      origin: 'https://vps.example.test'
    })
  })

  it('finishes an admitted settings commit before runtime shutdown', async () => {
    const filePath = await settingsPath()
    const store = await Effect.runPromise(
      ComputerStore.load(filePath, 'http://localhost:9000')
    )
    const runtime = new DesktopRuntime()
    const rename = fs.rename.bind(fs)
    let release!: () => void
    let started!: () => void
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    const admitted = new Promise<void>((resolve) => {
      started = resolve
    })
    vi.spyOn(fs, 'rename').mockImplementationOnce(async (source, target) => {
      started()
      await released
      await rename(source, target)
    })
    const adding = runtime.run(store.add('https://remote.example.test')).then(
      () => undefined,
      () => undefined
    )
    await admitted
    let closed = false
    const closing = Effect.runPromise(runtime.close).then(() => {
      closed = true
    })
    expect(closed).toBe(false)
    expect(store.summaries()).toHaveLength(1)
    release()
    await Promise.all([adding, closing])
    expect(store.summaries()).toHaveLength(2)
    const reopened = await Effect.runPromise(
      ComputerStore.load(filePath, 'http://localhost:9000')
    )
    expect(reopened.summaries()).toEqual(store.summaries())
  })

  it('recovers an invalid settings file to the seeded local connection', async () => {
    const filePath = await settingsPath()
    await fs.writeFile(filePath, '{"version":1,"computers":"invalid"}')
    const store = await Effect.runPromise(
      ComputerStore.load(filePath, 'http://localhost:9000')
    )
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
    const result = await Effect.runPromise(
      Effect.either(ComputerStore.load(filePath, 'http://localhost:9000'))
    )
    expect(result).toMatchObject({
      _tag: 'Left',
      left: { cause: { code: 'EISDIR' } }
    })
    expect(await fs.readFile(filePath, 'utf8')).toBe(invalidContents)
  })

  it('keeps committed memory and disk intact after a failed write, and admits the next mutation', async () => {
    const filePath = await settingsPath()
    const store = await Effect.runPromise(
      ComputerStore.load(filePath, 'http://localhost:9000')
    )
    const before = store.summaries()
    const contents = await fs.readFile(filePath, 'utf8')
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('Disk unavailable'))
    expect(
      (await Effect.runPromiseExit(store.add('https://remote.example.test')))
        ._tag
    ).toBe('Failure')
    expect(store.summaries()).toEqual(before)
    expect(await fs.readFile(filePath, 'utf8')).toBe(contents)
    expect(await fs.readdir(path.dirname(filePath))).toEqual(['computers.json'])
    await Effect.runPromise(store.add('https://remote.example.test'))
    expect(store.summaries()).toHaveLength(2)
  })
})
