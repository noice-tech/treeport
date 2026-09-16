import {
  decodeUnknownOrNull,
  desktopHealthResponseSchema,
  projectsResponseSchema
} from '@treeport/shared'
import type { ComputerInventory } from './desktop-contract'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Stream from 'effect/Stream'

export const checkHealth = (origin: string) =>
  Effect.tryPromise(async (signal) => {
    const response = await fetch(new URL('/api/health', origin).toString(), {
      redirect: 'error',
      signal
    })
    return response.ok
      ? decodeUnknownOrNull(desktopHealthResponseSchema, await response.json())
      : null
  }).pipe(
    Effect.timeoutOption('1500 millis'),
    Effect.map(Option.getOrNull),
    Effect.catchAll(() => Effect.succeed(null))
  )

export const inspectOpenProjectInventory = (origin: string) =>
  Effect.tryPromise(async (signal) => {
    const response = await fetch(new URL('/api/projects', origin).toString(), {
      redirect: 'error',
      signal
    })
    if (!response.ok) {
      return null
    }

    const decoded = decodeUnknownOrNull(
      projectsResponseSchema,
      await response.json()
    )
    if (!decoded) {
      return null
    }

    const projects = decoded.projects.map((project) => ({
      id: project.id,
      name: project.name,
      kind: project.kind,
      rootPath: project.rootPath,
      availability: project.availability.state,
      worktrees: project.worktrees.length,
      terminals: project.worktrees.reduce(
        (count, worktree) => count + worktree.terminals.length,
        0
      )
    }))
    return {
      projects,
      worktrees: projects.reduce(
        (count, project) => count + project.worktrees,
        0
      ),
      terminals: projects.reduce(
        (count, project) => count + project.terminals,
        0
      ),
      fetchedAt: new Date().toISOString()
    } satisfies ComputerInventory
  }).pipe(
    Effect.timeoutOption('3000 millis'),
    Effect.map(Option.getOrNull),
    Effect.catchAll(() => Effect.succeed(null))
  )

// Canceling the consumer interrupts both backoff and the current fetch/body.
// Emit unavailable once after the grace period, then keep trying until ready.
export const watchBackendHealth = (origin: string) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis
      const retryDelays = [0, 250, 500, 1_000, 2_000]
      let attempt = 0
      let unavailable = false
      return Stream.repeatEffect(
        Effect.gen(function* () {
          yield* Effect.sleep(
            retryDelays[Math.min(attempt++, retryDelays.length - 1)]!
          )
          const health = yield* checkHealth(origin)
          const elapsed = (yield* Clock.currentTimeMillis) - startedAt
          if (health) {
            return Option.some(health)
          }

          if (!unavailable && elapsed >= 3_000) {
            unavailable = true
            return Option.some(null)
          }

          return Option.none()
        })
      ).pipe(
        Stream.filterMap((value) => value),
        Stream.takeUntil((health) => health !== null)
      )
    })
  )
