import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Scope from 'effect/Scope'
import { DesktopRuntime } from './desktop-runtime'

it('exports named desktop tasks and flushes child spans when the root closes', async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'treeport-desktop-tracing-')
  )
  vi.stubEnv('TREEPORT_TRACE', 'jsonl')
  vi.stubEnv('TREEPORT_TRACE_FILE', '')
  vi.stubEnv('TREEPORT_TRACE_DIR', directory)
  onTestFinished(async () => {
    vi.unstubAllEnvs()
    await fs.rm(directory, { recursive: true, force: true })
  })
  const app = new DesktopRuntime()
  const window = new DesktopRuntime(app)
  await window.run(
    Effect.void.pipe(Effect.withSpan('desktop.child')),
    'desktop.test'
  )
  await Effect.runPromise(window.close)
  await app.run(Effect.void, 'desktop.after-window')
  await Effect.runPromise(app.close)
  const records = (
    await fs.readFile(path.join(directory, 'treeport-desktop.jsonl'), 'utf8')
  )
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  expect(records.map((record) => record.name)).toEqual([
    'desktop.child',
    'desktop.test',
    'desktop.after-window'
  ])
  expect(records[0]).toMatchObject({
    service: 'treeport-desktop',
    parentSpanId: records[1].spanId,
    traceId: records[1].traceId
  })
})

it('closes children, interrupts tasks, and awaits resource finalizers exactly once', async () => {
  const app = new DesktopRuntime()
  const window = new DesktopRuntime(app)
  const guest = new DesktopRuntime(window)
  const entered = Effect.runSync(Deferred.make<void>())
  const release = Effect.runSync(Deferred.make<void>())
  const events: string[] = []
  const task = guest.fork(
    Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.sync(() => events.push('acquired')),
        () =>
          Effect.gen(function* () {
            events.push('releasing')
            yield* Deferred.await(release)
            events.push('released')
          })
      )
      yield* Deferred.succeed(entered, undefined)
      yield* Effect.never
    })
  )
  await Effect.runPromise(Deferred.await(entered))
  const closing = Effect.runPromise(app.close)
  expect(app.isClosed).toBe(true)
  expect(guest.isClosed).toBe(true)
  await Effect.runPromise(Deferred.succeed(release, undefined))
  await Promise.all([closing, Effect.runPromise(app.close)])
  expect(events).toEqual(['acquired', 'releasing', 'released'])
  await Effect.runPromise(Fiber.await(task))
  const late = guest.run(Effect.sync(() => events.push('late')))
  await expect(late).rejects.toThrow()
  expect(events).not.toContain('late')
})

it('replaces a resource without closing its sibling or retaining its finalizer', async () => {
  const app = new DesktopRuntime()
  const first = new DesktopRuntime(app)
  const sibling = new DesktopRuntime(app)
  let closes = 0
  Effect.runSync(
    Scope.addFinalizer(
      first.scope,
      Effect.sync(() => {
        closes++
      })
    )
  )
  await Effect.runPromise(first.close)
  expect(closes).toBe(1)
  expect(await sibling.run(Effect.succeed('alive'))).toBe('alive')
  await Effect.runPromise(app.close)
  expect(closes).toBe(1)
})
