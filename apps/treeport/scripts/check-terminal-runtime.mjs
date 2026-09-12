#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = fileURLToPath(new URL('..', import.meta.url))
const runtimeRoot = path.join(appRoot, 'src/terminal-runtime')
const files = (await fs.readdir(runtimeRoot))
  .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
  .sort()
const violations = []
for (const name of files) {
  const source = await fs.readFile(path.join(runtimeRoot, name), 'utf8')
  for (const match of source.matchAll(
    /(?:from\s*|import\s*)['"]([^'"]+)['"]/g
  )) {
    const specifier = match[1]
    const allowed =
      specifier.startsWith('node:') ||
      specifier.startsWith('effect/') ||
      specifier.startsWith('@effect/') ||
      specifier.startsWith('@xterm/') ||
      specifier === 'node-pty' ||
      specifier === 'zod' ||
      (specifier.startsWith('./') && !specifier.startsWith('../'))
    if (!allowed) {
      violations.push(`${name}: ${specifier}`)
    }
  }
}

assert.deepEqual(
  violations,
  [],
  'The persistent terminal runtime must not depend on daemon, database, worktree, UI, or product-shared modules'
)
for (const required of [
  'contract.ts',
  'api.ts',
  'sessions.ts',
  'server.ts',
  'entry.ts',
  'launcher.ts'
]) {
  assert(
    files.includes(required),
    `Missing terminal runtime boundary file: ${required}`
  )
}
console.log(
  `Terminal runtime dependency boundary passed (${files.length} files)`
)
