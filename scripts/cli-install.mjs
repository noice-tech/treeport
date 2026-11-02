#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const install = spawnSync(
  'pnpm',
  ['add', '-g', `link:${path.join(root, 'apps', 'treeport')}`],
  { cwd: root, encoding: 'utf8' }
)

const output = `${install.stdout ?? ''}${install.stderr ?? ''}`

if (install.status === 0) {
  console.log('Installed the treeport command. Try: treeport status')
  process.exit(0)
}

if (
  output.includes('ERR_PNPM_GLOBAL_BIN_DIR_NOT_IN_PATH') ||
  output.includes('ERR_PNPM_NO_GLOBAL_BIN_DIR')
) {
  console.error(
    'pnpm is not set up for global commands yet. Run pnpm setup, open a new terminal, then run pnpm cli:install again.'
  )
  process.exit(1)
}

process.stderr.write(install.error ? `${install.error.message}\n` : output)

process.exit(install.status ?? 1)
