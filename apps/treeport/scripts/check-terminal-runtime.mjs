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
// Lifecycle consumers must ask the native owner, not reimplement ownership
// using discovery PIDs, ps timestamps, or filesystem deletion.
export function sessionOwnershipViolations(file, source) {
  const violations = []
  if (
    file.endsWith('/session-client.ts') &&
    /process\.kill\s*\(|\b(?:processExists|sessionOwnerExists)\s*\(|\bfs\.rm\s*\(|\blstart\b/u.test(
      source
    )
  ) {
    violations.push(
      `${file}: use inspectSession, closeSession or withSessionRecovery from @treeport/session-keeper; PIDs and timestamps are not ownership authority`
    )
  }

  if (
    (file.endsWith('/preflight.ts') ||
      file.endsWith('/cleanup-development-runtime.mjs')) &&
    /\bsessionStatusSchema\b|\b(?:status|inspected)\.(?:ownerPid|pid)\b/u.test(
      source
    )
  ) {
    violations.push(
      `${file}: use PersistentSession.inspect() or closeSession from @treeport/session-keeper; do not interpret retained session status`
    )
  }

  return violations
}

const violations = []
for (const name of files) {
  const source = await fs.readFile(path.join(runtimeRoot, name), 'utf8')
  violations.push(
    ...sessionOwnershipViolations(`src/terminal-runtime/${name}`, source)
  )
  for (const match of source.matchAll(
    /(?:from\s*|import\s*)['"]([^'"]+)['"]/g
  )) {
    const specifier = match[1]
    const allowed =
      specifier.startsWith('node:') ||
      specifier.startsWith('effect/') ||
      specifier.startsWith('@effect/') ||
      specifier === '../ghostty-vt/ghostty-vt' ||
      specifier === '../ghostty-vt/node' ||
      specifier === 'node-pty' ||
      specifier === 'zod' ||
      (['session-client.ts', 'session-protocol.ts'].includes(name) &&
        specifier === '@treeport/session-keeper') ||
      (specifier.startsWith('./') && !specifier.startsWith('../'))
    const persistentPrimitive = [
      'session-journal.ts',
      'session-protocol.ts'
    ].includes(name)
    const ownerAllowed =
      (name === 'session-protocol.ts' &&
        specifier === '@treeport/session-keeper') ||
      specifier.startsWith('node:') ||
      specifier === 'node-pty' ||
      specifier === 'zod' ||
      specifier === './session-journal' ||
      specifier === './session-protocol'
    if (!allowed || (persistentPrimitive && !ownerAllowed)) {
      violations.push(`${name}: ${specifier}`)
    }
  }
}

const cleanup = 'scripts/cleanup-development-runtime.mjs'
violations.push(
  ...sessionOwnershipViolations(
    cleanup,
    await fs.readFile(path.join(appRoot, cleanup), 'utf8')
  )
)

assert.deepEqual(
  violations,
  [],
  'Terminal runtime boundary violation: use the runtime API for product operations and @treeport/session-keeper for native ownership'
)
for (const required of [
  'contract.ts',
  'api.ts',
  'sessions.ts',
  'server.ts',
  'engine-worker.ts',
  'launcher.ts',
  'session-journal.ts',
  'session-protocol.ts',
  'session-client.ts'
]) {
  assert(
    files.includes(required),
    `Missing terminal runtime boundary file: ${required}`
  )
}
console.log(
  `Terminal runtime dependency boundary passed (${files.length} files)`
)
