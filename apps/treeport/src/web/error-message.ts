import { DetailedError } from 'hono/client'
import { z } from 'zod'
import { RpcNetworkError } from './api'

const MESSAGE_MAX_LENGTH = 500
const STATUS_TEXT_MAX_LENGTH = 80
const REQUEST_ID_MAX_LENGTH = 128

export interface ErrorDetails {
  message: string
  code: string | null
  details: unknown | null
  status: number | null
  statusText: string | null
  requestId: string | null
  method: string | null
  path: string | null
  networkFailure: boolean
  recoveryHint: string | null
}

const detailedErrorDataSchema = z.object({
  error: z
    .object({
      code: z.unknown().optional(),
      message: z.unknown().optional(),
      details: z.unknown().optional()
    })
    .optional()
})

const detailedErrorDetailSchema = z.object({
  data: z.unknown().optional(),
  statusText: z.unknown().optional()
})

const displayText = (maximumLength: number) =>
  z.unknown().transform((value) => {
    const parsed = z.string().safeParse(value)
    if (!parsed.success) {
      return null
    }

    let printable = ''
    for (const character of parsed.data) {
      const code = character.charCodeAt(0)
      printable += code < 32 || code === 127 ? ' ' : character
    }

    const normalized = printable.replace(/\s+/g, ' ').trim()
    if (!normalized) {
      return null
    }

    return normalized.length <= maximumLength
      ? normalized
      : `${normalized.slice(0, maximumLength - 1)}…`
  }).parse

const requestIdFrom = z.unknown().transform((details) => {
  const parsed = z.object({ requestId: z.string() }).safeParse(details)
  if (!parsed.success) {
    return null
  }

  const requestId = parsed.data.requestId
  return requestId.length <= REQUEST_ID_MAX_LENGTH &&
    /^[A-Za-z0-9_=-]+$/.test(requestId)
    ? requestId
    : null
}).parse

export function errorDetails(cause: unknown): ErrorDetails {
  if (cause instanceof RpcNetworkError) {
    return {
      message: 'Treeport could not be reached.',
      code: null,
      details: null,
      status: null,
      statusText: null,
      requestId: null,
      method: cause.method,
      path: cause.path,
      networkFailure: true,
      recoveryHint: 'Check that it is running and reachable, then retry.'
    }
  }

  if (cause instanceof DetailedError) {
    const parsedDetail = detailedErrorDetailSchema.safeParse(cause.detail)
    const detail = parsedDetail.success ? parsedDetail.data : null
    const parsedData = detailedErrorDataSchema.safeParse(detail?.data)
    const apiError = parsedData.success ? parsedData.data.error : null
    const apiMessage = displayText(MESSAGE_MAX_LENGTH)(apiError?.message)
    const code = displayText(100)(apiError?.code)
    const details = apiError?.details ?? null
    const parsedStatus = z
      .number()
      .int()
      .min(100)
      .max(599)
      .safeParse(cause.statusCode)
    const status = parsedStatus.success ? parsedStatus.data : null
    const statusText = displayText(STATUS_TEXT_MAX_LENGTH)(detail?.statusText)
    const requestId = requestIdFrom(details)

    if (apiMessage) {
      return {
        message: apiMessage,
        code,
        details,
        status,
        statusText,
        requestId,
        method: null,
        path: null,
        networkFailure: false,
        recoveryHint:
          code === 'INTERNAL_ERROR'
            ? 'Retry. If the problem continues, use the reference when checking Treeport logs.'
            : null
      }
    }

    const statusLabel = status
      ? `${status}${statusText ? ` ${statusText}` : ''}`
      : displayText(STATUS_TEXT_MAX_LENGTH)(cause.message)

    return {
      message:
        status && [502, 503, 504].includes(status)
          ? `The server or proxy returned ${statusLabel}.`
          : statusLabel
            ? `The Treeport server returned ${statusLabel}.`
            : 'The Treeport server returned an unexpected response.',
      code,
      details,
      status,
      statusText,
      requestId,
      method: null,
      path: null,
      networkFailure: false,
      recoveryHint:
        status && [502, 503, 504].includes(status)
          ? 'Check that Treeport is running, then retry.'
          : null
    }
  }

  const message = displayText(MESSAGE_MAX_LENGTH)(
    cause instanceof Error ? cause.message : String(cause)
  )
  return {
    message: message ?? 'Unexpected error.',
    code: null,
    details: null,
    status: null,
    statusText: null,
    requestId: null,
    method: null,
    path: null,
    networkFailure: false,
    recoveryHint: null
  }
}

export function errorMessage(cause: unknown): string {
  return errorDetails(cause).message
}
