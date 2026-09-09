import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as Effect from 'effect/Effect'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { currentPromiseSpan, makeTracingLayer } from './tracing'

const directories: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
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
    vi.stubEnv('TREEPORT_TRACE', 'jsonl')

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.annotateCurrentSpan({
            'treeport.request.id': 'request-1',
            'unsafe.secret': 'do-not-export'
          })
          const trace = yield* currentPromiseSpan
          const originalError = new Error('private-build-diagnostic')
          yield* Effect.promise(async () => {
            await expect(
              trace(
                'treeport.test.promise',
                () => Promise.reject(originalError),
                {
                  'treeport.web_panel.build_pending': false,
                  'unsafe.secret': 'do-not-export'
                }
              )
            ).rejects.toBe(originalError)
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

    expect(records).toHaveLength(3)
    expect(
      records.find((record) => record.name === 'treeport.test.promise')
    ).toMatchObject({
      traceId: parent.traceId,
      parentSpanId: parent.spanId,
      attributes: { 'treeport.web_panel.build_pending': false }
    })
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
})
