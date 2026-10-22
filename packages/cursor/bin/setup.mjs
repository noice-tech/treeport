#!/usr/bin/env node
/* eslint-disable anti-slop/no-runtime-typeof -- Preserve user-owned Cursor JSON while validating the object and hook arrays at this file boundary. */
import { randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  rmdir,
  writeFile
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

const [operation, ...args] = process.argv.slice(2)
if (!operation || operation === '--help' || args.includes('--help')) {
  console.log(
    'Usage: npx @treeport/cursor <install-hooks|uninstall-hooks> [--project]'
  )
  console.log(
    'Install the Treeport skill and Cursor hooks, then run agent normally.'
  )
  console.log(
    'Default: ~/.cursor. Use --project for .cursor in the current directory.'
  )
  process.exit(0)
}

if (
  !['install-hooks', 'uninstall-hooks'].includes(operation) ||
  args.some((arg) => arg !== '--project')
) {
  console.error(
    'Usage: npx @treeport/cursor <install-hooks|uninstall-hooks> [--project]'
  )
  process.exit(1)
}

const uninstall = operation === 'uninstall-hooks'
const root = join(
  args.includes('--project') ? process.cwd() : homedir(),
  '.cursor'
)
const configPath = join(root, 'hooks.json')
const skillPath = join(root, 'skills/treeport/SKILL.md')
const runtimePath = join(root, 'treeport')
const runtimeMarkerPath = join(runtimePath, '.managed-by-treeport-cursor')
const runtimeMarker = '@treeport/cursor runtime\n'
const readOptional = (path) =>
  readFile(path, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') {
      return null
    }

    throw error
  })
const source = await readOptional(configPath)
const config = source === null ? { version: 1, hooks: {} } : JSON.parse(source)
if (
  config === null ||
  typeof config !== 'object' ||
  Array.isArray(config) ||
  (config.version !== undefined && config.version !== 1) ||
  (config.hooks !== undefined &&
    (config.hooks === null ||
      typeof config.hooks !== 'object' ||
      Array.isArray(config.hooks)))
) {
  throw new Error('Invalid Cursor hooks configuration: ' + configPath)
}

const existingSkill = await readOptional(skillPath)
const marker = '<!-- Managed by @treeport/cursor. -->'
if (existingSkill !== null && !existingSkill.includes(marker)) {
  throw new Error(
    'Refusing to overwrite an existing Treeport skill: ' + skillPath
  )
}

const runtime = await lstat(runtimePath).catch((error) => {
  if (error.code === 'ENOENT') {
    return null
  }

  throw error
})
if (
  runtime !== null &&
  (!runtime.isDirectory() ||
    (await readOptional(runtimeMarkerPath)) !== runtimeMarker)
) {
  throw new Error('Refusing to overwrite an existing directory: ' + runtimePath)
}

config.version = 1
config.hooks ??= {}
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'"
// Never point hooks into npx's disposable package cache or pin its Node binary.
const command = 'node ' + quote(join(runtimePath, 'hook.mjs'))
for (const [event, state] of [
  ['sessionStart', 'context'],
  ['beforeSubmitPrompt', 'working'],
  ['stop', 'stopped'],
  ['sessionEnd', 'ended']
]) {
  const hooks = config.hooks[event] ?? []
  if (!Array.isArray(hooks)) {
    throw new Error('Invalid Cursor hook array: ' + event)
  }

  const entry = command + ' ' + state
  const others = hooks.filter((hook) => hook?.command !== entry)
  if (!uninstall) {
    others.push({ command: entry })
  }

  if (others.length > 0) {
    config.hooks[event] = others
  } else {
    delete config.hooks[event]
  }
}

async function writeAtomic(path, content) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = join(
    dirname(path),
    '.' + basename(path) + '-' + randomUUID()
  )
  await writeFile(temporary, content, { mode: 0o600, flag: 'wx' })
  await rename(temporary, path).finally(() => rm(temporary, { force: true }))
}

if (!uninstall) {
  await mkdir(runtimePath, { recursive: true, mode: 0o700 })
  await writeAtomic(runtimeMarkerPath, runtimeMarker)
  for (const file of ['hook.mjs', 'status-worker.mjs']) {
    await writeAtomic(
      join(runtimePath, file),
      await readFile(new URL(file, import.meta.url))
    )
  }

  await writeAtomic(
    skillPath,
    await readFile(new URL('../skills/treeport/SKILL.md', import.meta.url))
  )
}

if (!uninstall || source !== null) {
  await writeAtomic(configPath, JSON.stringify(config, null, 2) + '\n')
}

if (uninstall) {
  if (existingSkill !== null) {
    await rm(skillPath)
    await rmdir(dirname(skillPath)).catch((error) => {
      if (error.code !== 'ENOTEMPTY') {
        throw error
      }
    })
  }

  if (runtime !== null) {
    for (const file of [
      'hook.mjs',
      'status-worker.mjs',
      '.managed-by-treeport-cursor'
    ]) {
      await rm(join(runtimePath, file), { force: true })
    }

    await rmdir(runtimePath).catch((error) => {
      if (error.code !== 'ENOTEMPTY') {
        throw error
      }
    })
  }

  console.log('Removed Treeport Cursor hooks and skill from ' + root)
} else {
  console.log('Installed Treeport Cursor hooks and skill in ' + root)
  console.log('Run agent normally inside a Treeport terminal.')
}
