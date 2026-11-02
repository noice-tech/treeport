#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

console.log(`Packaging Treeport for ${root}…`)

const packaged = spawnSync(
  'pnpm',
  ['--filter', '@treeport/desktop', 'package'],
  { cwd: root, stdio: 'inherit' }
)

if (packaged.status !== 0) {
  console.error('Failed to package the Treeport app.')
  process.exit(packaged.status ?? 1)
}

const out = path.join(root, 'apps', 'desktop', 'out')

const build = fs
  .readdirSync(out)
  .find((name) => name.startsWith(`Treeport-${process.platform}-`))

if (!build) {
  console.error(`No Treeport build for ${process.platform} under ${out}.`)
  process.exit(1)
}

if (process.platform !== 'darwin') {
  console.log(`Built ${path.join(out, build)}`)
  process.exit(0)
}

const target = '/Applications/Treeport.app'

fs.rmSync(target, { recursive: true, force: true })

// EXTERNAL: ditto preserves the bundle's framework symlinks and code signature.
const copied = spawnSync(
  'ditto',
  [path.join(out, build, 'Treeport.app'), target],
  { stdio: 'inherit' }
)

if (copied.status !== 0) {
  console.error(`Failed to install ${target}.`)
  process.exit(copied.status ?? 1)
}

console.log(
  `Installed ${target}. Open Treeport from Launchpad or Spotlight; quit and reopen it if it was running.`
)
