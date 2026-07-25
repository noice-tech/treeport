import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from './config'

const directories: string[] = []

afterEach(() => {
  directories
    .splice(0)
    .forEach((directory) =>
      fs.rmSync(directory, { recursive: true, force: true })
    )
})

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'treeport-config-'))
  directories.push(directory)
  return directory
}

describe('configuration', () => {
  it('defaults to loopback and XDG data locations', () => {
    const config = loadConfig({
      XDG_DATA_HOME: '/tmp/data home',
      XDG_RUNTIME_DIR: '/tmp/run',
      SHELL: '/bin/zsh'
    })
    expect(config.host).toBe('127.0.0.1')
    expect(config.databasePath).toBe('/tmp/data home/treeport/treeport.db')
    expect(config.shell).toBe('/bin/zsh')
  })

  it('allows a non-loopback binding', () => {
    expect(loadConfig({ TREEPORT_HOST: '0.0.0.0' }).host).toBe('0.0.0.0')
  })

  it('prefers canonical variables while accepting legacy configuration', () => {
    const root = temporaryDirectory()
    const config = loadConfig({
      TREEPORT_DATA_DIR: path.join(root, 'canonical-data'),
      TASKTTY_DATA_DIR: path.join(root, 'legacy-data'),
      TREEPORT_HOST: '127.0.0.2',
      TASKTTY_HOST: '127.0.0.3',
      TASKTTY_API_URL: 'http://127.0.0.1:9999',
      TASKTTY_SHELL: '/bin/bash'
    })

    expect(config.dataDir).toBe(path.join(root, 'canonical-data'))
    expect(config.databasePath).toBe(
      path.join(root, 'canonical-data', 'treeport.db')
    )
    expect(config.host).toBe('127.0.0.2')
    expect(config.apiUrl).toBe('http://127.0.0.1:9999')
    expect(config.shell).toBe('/bin/bash')
  })

  it('continues using a lone legacy default database without copying it', () => {
    const root = temporaryDirectory()
    const legacyDirectory = path.join(root, 'tasktty')
    fs.mkdirSync(legacyDirectory)
    fs.writeFileSync(path.join(legacyDirectory, 'tasktty.db'), '')

    const config = loadConfig({ XDG_DATA_HOME: root })

    expect(config.dataDir).toBe(legacyDirectory)
    expect(config.databasePath).toBe(path.join(legacyDirectory, 'tasktty.db'))
  })

  it('does not select the legacy data directory with an explicit database path', () => {
    const root = temporaryDirectory()
    const legacyDirectory = path.join(root, 'tasktty')
    const explicitDatabasePath = path.join(root, 'custom', 'treeport.db')
    fs.mkdirSync(legacyDirectory)
    fs.writeFileSync(path.join(legacyDirectory, 'tasktty.db'), '')

    const config = loadConfig({
      XDG_DATA_HOME: root,
      TREEPORT_DATABASE_PATH: explicitDatabasePath
    })

    expect(config.dataDir).toBe(path.join(root, 'treeport'))
    expect(config.databasePath).toBe(explicitDatabasePath)
  })

  it('refuses to guess when both default databases exist', () => {
    const root = temporaryDirectory()
    for (const [directory, database] of [
      ['treeport', 'treeport.db'],
      ['tasktty', 'tasktty.db']
    ] as const) {
      fs.mkdirSync(path.join(root, directory))
      fs.writeFileSync(path.join(root, directory, database), '')
    }

    expect(() => loadConfig({ XDG_DATA_HOME: root })).toThrow(
      /Both Treeport and legacy TaskTTY databases exist/
    )
  })
})
