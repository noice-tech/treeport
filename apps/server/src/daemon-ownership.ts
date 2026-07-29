import fs from 'node:fs/promises'
import path from 'node:path'
import type { AppConfig } from './core/config'

interface DaemonRecord {
  pid: number
  instanceId: string
  version: string
  apiUrl: string
  dataDir: string
  startedAt: string
  installationMethod: string
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export async function acquireDaemonOwnership(config: AppConfig): Promise<{
  publish(): Promise<void>
  release(): Promise<void>
}> {
  const instanceId = config.instanceId
  if (!instanceId) {
    throw new Error('TREEPORT_INSTANCE_ID is required to start the daemon')
  }

  await Promise.all([
    fs.mkdir(config.dataDir, { recursive: true, mode: 0o700 }),
    fs.mkdir(config.runtimeDir, { recursive: true, mode: 0o700 })
  ])
  const lockPath = path.join(config.dataDir, 'daemon.lock')
  const statePath = path.join(config.runtimeDir, 'daemon.json')
  const record: DaemonRecord = {
    pid: process.pid,
    instanceId,
    version: config.appVersion ?? 'development',
    apiUrl: config.apiUrl,
    dataDir: config.dataDir,
    startedAt: new Date().toISOString(),
    installationMethod: config.installationMethod ?? 'development'
  }

  const openLock = () =>
    fs.open(lockPath, 'wx', 0o600).then(async (file) => {
      await file.writeFile(`${JSON.stringify(record)}\n`)
      await file.close()
    })

  const firstAttempt = await openLock().then(
    () => true,
    async (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') {
        throw error
      }

      const existing = await fs
        .readFile(lockPath, 'utf8')
        .then((value) => JSON.parse(value) as Partial<DaemonRecord>)
        .catch(() => null)
      if (
        existing?.pid &&
        Number.isInteger(existing.pid) &&
        processExists(existing.pid)
      ) {
        throw new Error(
          `Treeport is already running for ${config.dataDir} (PID ${existing.pid})`
        )
      }

      await fs.rm(lockPath, { force: true })
      return false
    }
  )
  if (!firstAttempt) {
    await openLock()
  }

  const removeOwned = async (filePath: string) => {
    const owned = await fs
      .readFile(filePath, 'utf8')
      .then(
        (value) =>
          (JSON.parse(value) as Partial<DaemonRecord>).instanceId === instanceId
      )
      .catch(() => false)
    if (owned) {
      await fs.rm(filePath, { force: true })
    }
  }

  return {
    async publish() {
      const temporaryPath = `${statePath}.${process.pid}.tmp`
      await fs.writeFile(temporaryPath, `${JSON.stringify(record)}\n`, {
        mode: 0o600
      })
      await fs.rename(temporaryPath, statePath)
    },
    async release() {
      await Promise.all([removeOwned(statePath), removeOwned(lockPath)])
    }
  }
}
