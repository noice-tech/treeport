#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
)
const repositoryRoot = path.resolve(packageDirectory, '../..')
const outputDirectory = path.join(packageDirectory, 'dist')

await Promise.all([
  fs.cp(
    path.join(repositoryRoot, 'apps/server/dist'),
    path.join(outputDirectory, 'server'),
    { recursive: true, filter: (source) => !source.endsWith('.map') }
  ),
  fs.cp(
    path.join(repositoryRoot, 'apps/web/dist'),
    path.join(outputDirectory, 'web'),
    { recursive: true }
  ),
  fs.copyFile(
    path.join(repositoryRoot, 'skills/treeport/SKILL.md'),
    path.join(outputDirectory, 'treeport-skill.md')
  ),
  fs.copyFile(
    path.join(repositoryRoot, 'LICENSE'),
    path.join(packageDirectory, 'LICENSE')
  )
])
await fs.chmod(path.join(packageDirectory, 'bin/treeport.mjs'), 0o755)
await fs.chmod(path.join(outputDirectory, 'index.js'), 0o755)
