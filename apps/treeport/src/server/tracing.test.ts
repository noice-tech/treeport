import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import { afterEach, describe, expect, it } from 'vitest'
import { makeMutationCoordinator } from './core/services/infrastructure/mutation-coordinator'
import { makeTracingLayer } from './tracing'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true }))
  )
})

describe('agent trace export', () => {
  it('flushes nested JSONL spans and filters unapproved attributes', async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'treeport-tracing-')
    )
    directories.push(directory)
    const tracePath = path.join(directory, 'trace.jsonl')

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.annotateCurrentSpan({
            'treeport.request.id': 'request-1',
            'unsafe.secret': 'do-not-export'
          })
          yield* Effect.void.pipe(
            Effect.withSpan('treeport.test.child', {
              attributes: { 'treeport.mutation.coordinator': 'terminal' }
            })
          )
        }).pipe(
          Effect.withSpan('treeport.test.parent'),
          Effect.provide(
            makeTracingLayer({
              serviceName: 'treeport',
              serviceVersion: 'test',
              destination: { filePath: tracePath }
            })
          )
        )
      )
    )

    const records = (await fs.readFile(tracePath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    const parent = records.find(
      (record) => record.name === 'treeport.test.parent'
    )
    const child = records.find(
      (record) => record.name === 'treeport.test.child'
    )

    expect(records).toHaveLength(2)
    expect(parent).toMatchObject({
      type: 'treeport.trace.span',
      service: 'treeport',
      parentSpanId: null,
      attributes: { 'treeport.request.id': 'request-1' }
    })
    expect(child).toMatchObject({
      traceId: parent.traceId,
      parentSpanId: parent.spanId,
      attributes: { 'treeport.mutation.coordinator': 'terminal' }
    })
    expect(JSON.stringify(records)).not.toContain('do-not-export')
    expect((await fs.stat(tracePath)).mode & 0o777).toBe(0o600)
  })

  it('separates mutation queue wait from execution in the parent trace', async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'treeport-mutation-tracing-')
    )
    directories.push(directory)
    const tracePath = path.join(directory, 'trace.jsonl')

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const coordinator = yield* makeMutationCoordinator<string>('terminal')
          const gate = yield* Deferred.make<void>()
          const started = yield* Deferred.make<void>()
          const first = yield* Effect.forkScoped(
            coordinator
              .enqueue(
                'worktree',
                Effect.gen(function* () {
                  yield* Deferred.succeed(started, undefined)
                  yield* Deferred.await(gate)
                })
              )
              .pipe(Effect.withSpan('treeport.test.first_request'))
          )
          yield* Deferred.await(started)
          const second = yield* Effect.forkScoped(
            coordinator
              .enqueue(
                'worktree',
                Effect.annotateCurrentSpan('treeport.terminal.id', 'second')
              )
              .pipe(Effect.withSpan('treeport.test.second_request'))
          )
          yield* Effect.sleep('20 millis')
          yield* Deferred.succeed(gate, undefined)
          yield* Fiber.join(first)
          yield* Fiber.join(second)
        }).pipe(
          Effect.provide(
            makeTracingLayer({
              serviceName: 'treeport',
              serviceVersion: 'test',
              destination: { filePath: tracePath }
            })
          )
        )
      )
    )

    const records = (await fs.readFile(tracePath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    const secondRequest = records.find(
      (record) => record.name === 'treeport.test.second_request'
    )
    const secondExecution = records.find(
      (record) => record.attributes['treeport.terminal.id'] === 'second'
    )
    const secondWait = records.find(
      (record) =>
        record.name === 'treeport.mutation.wait' &&
        record.parentSpanId === secondRequest.spanId
    )

    expect(secondExecution).toMatchObject({
      parentSpanId: secondRequest.spanId,
      name: 'treeport.mutation.execute',
      attributes: {
        'treeport.mutation.coordinator': 'terminal',
        'treeport.mutation.queued_ahead': 1,
        'treeport.terminal.id': 'second'
      }
    })
    expect(
      secondExecution.attributes['treeport.mutation.queue_wait_ms']
    ).toBeGreaterThanOrEqual(15)
    expect(secondWait.durationMs).toBeGreaterThanOrEqual(15)
  })
})
