import { afterEach, expect, it, vi } from 'vitest'
import { parseResponse, rpc } from './api'
import { errorDetails } from './error-message'

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
            code: 'PROJECT_NOT_FOUND',
            message: 'The project no longer exists',
            details: { requestId: 'request-123' }
          }
        },
        { status: 404, statusText: 'Not Found' }
      )
    )
  )

  const failure = await parseResponse(rpc.api.projects.$get()).then(
    () => null,
    (cause: unknown) => cause
  )
  expect(errorDetails(failure)).toMatchObject({
    message: 'The project no longer exists',
    code: 'PROJECT_NOT_FOUND',
    requestId: 'request-123',
    status: 404
  })
})
