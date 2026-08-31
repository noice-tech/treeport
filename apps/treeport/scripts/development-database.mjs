#!/usr/bin/env node
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createClient } from '@libsql/client'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/libsql'

export async function cloneDevelopmentDatabase(
  source,
  destination,
  options = {}
) {
  const sourcePath = path.resolve(source)
  const destinationPath = path.resolve(destination)
  const force = options.force === true

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
    const sourceClient = createClient({ url: pathToFileURL(sourcePath).href })
    try {
      await drizzle(sourceClient).run(
        sql.raw(`VACUUM INTO '${temporaryPath.replaceAll("'", "''")}'`)
      )
    } finally {
      sourceClient.close()
    }

    const destinationClient = createClient({
      url: pathToFileURL(temporaryPath).href
    })
    const destinationDatabase = drizzle(destinationClient)
    try {
      await destinationDatabase.run(sql`DELETE FROM operations`)
      await destinationDatabase.run(sql`PRAGMA wal_checkpoint(TRUNCATE)`)
    } finally {
      destinationClient.close()
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
      'Usage: development-database.mjs --from <database> --to <database> [--force]'
    )
  }

  const result = await cloneDevelopmentDatabase(source, destination, {
    force: args.includes('--force')
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
