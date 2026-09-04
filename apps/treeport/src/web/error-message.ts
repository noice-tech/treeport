/* eslint-disable anti-slop/no-unknown-parameters -- These helpers immediately decode untrusted error payload fields with Effect Schema. */
import { apiErrorBodySchema, decodeUnknownOrNull } from '@treeport/shared'
import * as Schema from 'effect/Schema'
import { DetailedError, RpcNetworkError } from './api'

const MESSAGE_MAX_LENGTH = 500
const STATUS_TEXT_MAX_LENGTH = 80
const REQUEST_ID_MAX_LENGTH = 128
const detailedErrorDetailSchema = Schema.Struct({
  data: Schema.optional(Schema.Unknown),
  statusText: Schema.optional(Schema.Unknown)
})
const detailRecordSchema = Schema.Record({
  key: Schema.String,
  value: Schema.Unknown
})
const httpStatusSchema = Schema.Int.pipe(Schema.between(100, 599))

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

function displayText(value: unknown, maximumLength: number): string | null {
  const parsed = decodeUnknownOrNull(Schema.String, value)
  if (parsed === null) {
    return null
  }

  let printable = ''
  for (const character of parsed) {
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
}

function requestIdFrom(details: unknown): string | null {
  const parsed = decodeUnknownOrNull(detailRecordSchema, details)
  const requestId = parsed
    ? decodeUnknownOrNull(Schema.String, parsed.requestId)
    : null
  return requestId !== null &&
    requestId.length <= REQUEST_ID_MAX_LENGTH &&
    /^[A-Za-z0-9_=-]+$/.test(requestId)
    ? requestId
    : null
}

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
    const detail = decodeUnknownOrNull(detailedErrorDetailSchema, cause.detail)
    const failure = decodeUnknownOrNull(apiErrorBodySchema, detail?.data)
    const apiError = failure?.error
    const apiMessage = displayText(apiError?.message, MESSAGE_MAX_LENGTH)
    const code = displayText(apiError?.code, 100)
    const details = apiError?.details ?? null
    const status = decodeUnknownOrNull(httpStatusSchema, cause.statusCode)
    const statusText = displayText(detail?.statusText, STATUS_TEXT_MAX_LENGTH)
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
      : displayText(cause.message, STATUS_TEXT_MAX_LENGTH)

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

  const message = displayText(
    cause instanceof Error ? cause.message : String(cause),
    MESSAGE_MAX_LENGTH
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

export function errorDescription(details: ErrorDetails): string {
  const message = /[.!?]$/.test(details.message)
    ? details.message
    : `${details.message}.`
  return [
    message,
    details.recoveryHint,
    details.requestId ? `Reference: ${details.requestId}.` : null
  ]
    .filter((part): part is string => Boolean(part))
    .join(' ')
}

export function errorMessage(cause: unknown): string {
  return errorDetails(cause).message
}
