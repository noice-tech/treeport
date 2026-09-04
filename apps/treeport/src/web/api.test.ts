import { afterEach, expect, it, vi } from 'vitest'
import { parseResponse, rpc } from './api'
import { errorDescription, errorDetails } from './error-message'

afterEach(() => {
  vi.unstubAllGlobals()
})

it('rejects malformed successful API payloads before they reach the UI', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({ projects: [{ id: 'incomplete-project' }] })
    )
  )

  await expect(parseResponse(rpc.api.projects.$get())).rejects.toMatchObject({
    message: 'Treeport returned an invalid response',
    statusCode: 502
  })
})

it('decodes the shared API failure envelope for user-visible errors', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json(
        {
          error: {
            code: 'INTERNAL_ERROR',
            message: 'Unexpected server error',
            details: { requestId: 'request-123' }
          }
        },
        { status: 500, statusText: 'Internal Server Error' }
      )
    )
  )

  const failure = await parseResponse(rpc.api.projects.$get()).then(
    () => null,
    (cause: unknown) => cause
  )
  const details = errorDetails(failure)
  expect(details).toMatchObject({
    message: 'Unexpected server error',
    code: 'INTERNAL_ERROR',
    requestId: 'request-123',
    status: 500
  })
  expect(errorDescription(details)).toBe(
    'Unexpected server error. Retry. If the problem continues, use the reference when checking Treeport logs. Reference: request-123.'
  )
})
