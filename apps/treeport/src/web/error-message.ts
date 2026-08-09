import type { ApiErrorBody } from '@treeport/shared'
import { DetailedError } from 'hono/client'

export function errorMessage(error: unknown): string {
  if (error instanceof DetailedError) {
    const body = (error.detail as { data?: ApiErrorBody } | undefined)?.data
    return body?.error?.message || error.message
  }

  return error instanceof Error ? error.message : String(error)
}
