#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const directory = fileURLToPath(new URL('..', import.meta.url))

const manifest = JSON.parse(
  await fs.readFile(path.join(directory, 'package.json'), 'utf8')
)

assert.deepEqual(manifest.pi.extensions, ['./extensions/treeport/index.ts'])

assert.deepEqual(manifest.pi.skills, ['./skills/treeport'])

for (const resource of [...manifest.pi.extensions, ...manifest.pi.skills]) {
  await fs.access(path.join(directory, resource))
}

assert.equal(
  await fs.readFile(path.join(directory, 'skills/treeport/SKILL.md'), 'utf8'),
  await fs.readFile(
    path.join(directory, '../../skills/treeport/SKILL.md'),
    'utf8'
  ),
  'The local Pi skill must match the Treeport skill'
)

for (const name of ['@earendil-works/pi-coding-agent', 'typebox']) {
  assert.equal(manifest.peerDependencies?.[name], '*')
  assert.equal(manifest.dependencies?.[name], undefined)
}

console.log(`Local package checks passed for ${manifest.name}`)
