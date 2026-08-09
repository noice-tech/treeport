import { DetailedError } from 'hono/client'
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

interface ApiErrorEnvelope {
  error?: {
    code?: unknown
    message?: unknown
    details?: unknown
  }
}

interface RequestDetails {
  requestId?: unknown
}

function displayText(value: unknown, maximumLength: number): string | null {
  if (typeof value !== 'string') {
    return null
  }

  let printable = ''
  for (const character of value) {
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
  if (!details || typeof details !== 'object' || Array.isArray(details)) {
    return null
  }

  const requestId = (details as RequestDetails).requestId
  return typeof requestId === 'string' &&
    requestId.length <= REQUEST_ID_MAX_LENGTH &&
    /^[A-Za-z0-9_=-]+$/.test(requestId)
    ? requestId
    : null
}

export function errorDetails(error: unknown): ErrorDetails {
  if (error instanceof RpcNetworkError) {
    return {
      message: 'Treeport could not be reached.',
      code: null,
      details: null,
      status: null,
      statusText: null,
      requestId: null,
      method: error.method,
      path: error.path,
      networkFailure: true,
      recoveryHint: 'Check that it is running and reachable, then retry.'
    }
  }

  if (error instanceof DetailedError) {
    const detail = error.detail as
      | { data?: unknown; statusText?: unknown }
      | undefined
    const data = detail?.data
    const errorEnvelope =
      data && typeof data === 'object' && !Array.isArray(data)
        ? (data as ApiErrorEnvelope).error
        : null
    const apiError =
      errorEnvelope &&
      typeof errorEnvelope === 'object' &&
      !Array.isArray(errorEnvelope)
        ? errorEnvelope
        : null
    const apiMessage = displayText(apiError?.message, MESSAGE_MAX_LENGTH)
    const code = displayText(apiError?.code, 100)
    const details = apiError?.details ?? null
    const status =
      typeof error.statusCode === 'number' &&
      error.statusCode >= 100 &&
      error.statusCode <= 599
        ? error.statusCode
        : null
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
      : displayText(error.message, STATUS_TEXT_MAX_LENGTH)

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
    error instanceof Error ? error.message : String(error),
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

export function errorMessage(error: unknown): string {
  return errorDetails(error).message
}
