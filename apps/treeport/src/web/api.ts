import { DetailedError, hc, parseResponse } from 'hono/client'
import type { ClientResponse } from 'hono/client'
import type { ApiErrorBody } from '@treeport/shared'
import type { AppType } from '../server/app'

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: unknown
  ) {
    super(message)
  }
}

export async function parseRpcResponse<T extends ClientResponse<unknown>>(
  request: T | Promise<T>
): ReturnType<typeof parseResponse<T>> {
  try {
    return await parseResponse(request)
  } catch (cause) {
    if (!(cause instanceof DetailedError)) {
      throw cause
    }

    const body = (cause.detail as { data?: ApiErrorBody } | undefined)?.data
    const error = body?.error
    throw new ApiError(
      error?.code || 'HTTP_ERROR',
      error?.message || cause.message,
      cause.statusCode ?? 500,
      error?.details
    )
  }
}

export const rpc = hc<AppType>('/')
