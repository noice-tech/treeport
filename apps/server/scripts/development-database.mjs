#!/usr/bin/env node
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

export async function cloneDevelopmentDatabase(
  source,
  destination,
  options = {}
) {
  const sourcePath = path.resolve(source)
  const destinationPath = path.resolve(destination)
  const force = options.force === true
  const preserveTmuxSockets = options.preserveTmuxSockets === true

  if (sourcePath === destinationPath) {
    throw new Error('Source and destination databases must be different')
  }

  if (
    !(await fs
      .stat(sourcePath)
      .then((entry) => entry.isFile())
      .catch(() => false))
  ) {
    return { copied: false, reason: 'missing-source' }
  }

  if (
    !force &&
    (await fs
      .stat(destinationPath)
      .then(() => true)
      .catch(() => false))
  ) {
    return { copied: false, reason: 'existing-destination' }
  }

  const destinationDirectory = path.dirname(destinationPath)
  await fs.mkdir(destinationDirectory, { recursive: true, mode: 0o700 })
  await fs.chmod(destinationDirectory, 0o700)
  const temporaryPath = path.join(
    destinationDirectory,
    `.${path.basename(destinationPath)}.${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`
  )

  try {
    const sourceDatabase = new Database(sourcePath, {
      readonly: true,
      fileMustExist: true
    })
    try {
      await sourceDatabase.backup(temporaryPath)
    } finally {
      sourceDatabase.close()
    }

    const destinationDatabase = new Database(temporaryPath)
    try {
      const worktrees = preserveTmuxSockets
        ? []
        : destinationDatabase.prepare('SELECT id FROM worktrees').all()
      const updateSocket = preserveTmuxSockets
        ? null
        : destinationDatabase.prepare(
            'UPDATE worktrees SET tmux_socket_name = ? WHERE id = ?'
          )
      destinationDatabase.transaction(() => {
        destinationDatabase.prepare('DELETE FROM operations').run()
        destinationDatabase
          .prepare(
            `UPDATE worktrees
             SET status = 'active', cleanup_error = NULL
             WHERE status IN ('cleaning', 'cleanup_failed')`
          )
          .run()
        for (const worktree of worktrees) {
          updateSocket.run(
            `treeport-wt-${crypto.randomBytes(8).toString('hex')}`,
            worktree.id
          )
        }
      })()
      destinationDatabase.pragma('wal_checkpoint(TRUNCATE)')
    } finally {
      destinationDatabase.close()
    }

    await fs.chmod(temporaryPath, 0o600)
    if (force) {
      await Promise.all(
        ['', '-shm', '-wal'].map((suffix) =>
          fs.rm(`${destinationPath}${suffix}`, { force: true })
        )
      )
      await fs.rename(temporaryPath, destinationPath)
    } else {
      try {
        await fs.link(temporaryPath, destinationPath)
      } catch (error) {
        if (error?.code === 'EEXIST') {
          return { copied: false, reason: 'existing-destination' }
        }

        throw error
      }

      await fs.rm(temporaryPath)
    }

    return { copied: true }
  } finally {
    await Promise.all(
      ['', '-shm', '-wal'].map((suffix) =>
        fs.rm(`${temporaryPath}${suffix}`, { force: true })
      )
    )
  }
}

async function main() {
  const args = process.argv.slice(2)
  const sourceIndex = args.indexOf('--from')
  const destinationIndex = args.indexOf('--to')
  const source = sourceIndex >= 0 ? args[sourceIndex + 1] : undefined
  const destination =
    destinationIndex >= 0 ? args[destinationIndex + 1] : undefined
  if (!source || !destination) {
    throw new Error(
      'Usage: development-database.mjs --from <database> --to <database> [--force] [--preserve-tmux-sockets]'
    )
  }

  const result = await cloneDevelopmentDatabase(source, destination, {
    force: args.includes('--force'),
    preserveTmuxSockets: args.includes('--preserve-tmux-sockets')
  })
  if (result.copied) {
    console.log(`Cloned Treeport development database to ${destination}`)
  } else if (result.reason === 'missing-source') {
    console.log(`No Treeport development database found at ${source}; skipping`)
  } else {
    console.log(
      `Treeport development database already exists at ${destination}`
    )
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
