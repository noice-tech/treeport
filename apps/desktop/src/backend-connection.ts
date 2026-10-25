import {
  phoneAccessResponseSchema,
  workspaceActivityResponseSchema
} from './shell-metadata'
import type { PhoneAccessResponse } from './desktop-contract'
import { z } from 'zod'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { isLoopbackUrl, parseComputerUrl } from './renderer-url'

export const phoneAccess = (origin: string) =>
  Effect.tryPromise(async (signal): Promise<PhoneAccessResponse> => {
    const computer = parseComputerUrl(origin)

    if (!isLoopbackUrl(computer)) {
      return { url: computer.href, error: null, setupCommand: null }
    }

    const response = await fetch(new URL('/api/phone-access', computer), {
      redirect: 'error',
      signal
    })

    const result = response.ok
      ? phoneAccessResponseSchema.safeParse(await response.json()).data
      : null

    if (!result) {
      throw new Error(
        response.status === 404
          ? 'Update Treeport on this computer to discover its Tailscale URL.'
          : 'Could not check remote access on this computer.'
      )
    }

    if (result.url) {
      const remote = parseComputerUrl(result.url)

      if (remote.protocol !== 'https:' || isLoopbackUrl(remote)) {
        throw new Error('This instance did not report a remote HTTPS URL.')
      }

      return { ...result, url: remote.href }
    }

    return result
  }).pipe(
    Effect.timeout('12 seconds'),
    Effect.catchAll((cause) =>
      Effect.succeed<PhoneAccessResponse>({
        url: null,
        error:
          cause._tag === 'UnknownException' && cause.cause instanceof Error
            ? cause.cause.message
            : 'Could not check remote access. Make sure this computer is available, then retry.',
        setupCommand: null
      })
    )
  )

export const checkActivity = (origin: string) =>
  Effect.tryPromise(async (signal) => {
    const response = await fetch(new URL('/api/activity', origin), {
      redirect: 'error',
      signal
    })

    return response.ok
      ? (workspaceActivityResponseSchema.safeParse(await response.json())
          .data ?? null)
      : null
  }).pipe(
    Effect.timeoutOption('1500 millis'),
    Effect.map(Option.getOrNull),
    Effect.catchAll(() => Effect.succeed(null))
  )

export const checkHealth = (origin: string) =>
  Effect.tryPromise(async (signal) => {
    const response = await fetch(new URL('/api/health', origin).toString(), {
      redirect: 'error',
      signal
    })

    return response.ok
      ? z
          .object({
            version: z.string().nullable().catch(null),
            hostname: z.string().nullable().catch(null)
          })
          .parse(await response.json())
      : null
  }).pipe(
    Effect.timeoutOption('1500 millis'),
    Effect.map(Option.getOrNull),
    Effect.catchAll(() => Effect.succeed(null))
  )
