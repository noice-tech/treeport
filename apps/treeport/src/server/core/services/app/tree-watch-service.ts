import { watch, type FSWatcher } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { AsyncSubscription } from '@parcel/watcher'
import * as Effect from 'effect/Effect'
import type { WorktreeRecord } from '#protocol/worktree'
import type { ProductEventBus } from '../../events.ts'
import type { GitAdapter } from '../../git.ts'

const CHANGE_BATCH_MS = 250

interface TreeWatcher {
  listeners: Set<() => void>
  ready: Promise<void>
  close(): void
}

/**
 * One shared file watcher per tree, alive while it has listeners. Git-ignored
 * paths are excluded so dependency and build folders cost no watches.
 */
export class TreeWatchService {
  private readonly watchers = new Map<string, TreeWatcher>()

  watch(
    worktree: WorktreeRecord,
    git: GitAdapter,
    events: ProductEventBus,
    onChange: () => void
  ): Effect.Effect<() => void, Error> {
    const watchers = this.watchers

    return Effect.gen(function* () {
      let watcher = watchers.get(worktree.id)

      if (!watcher) {
        const root = worktree.path
        const listeners = new Set<() => void>()
        const pending = new Set<string>()
        let ignored = new Set<string>()
        let subscription: AsyncSubscription | null = null
        let gitWatcher: FSWatcher | null = null
        let gitChanged = false
        let timer: NodeJS.Timeout | null = null
        let flushing = Promise.resolve()
        let closed = false

        const isIgnored = (relative: string) => {
          const parts = relative.split('/')

          return parts.some((_, index) =>
            ignored.has(parts.slice(0, index + 1).join('/'))
          )
        }

        const subscribe = async () => {
          ignored = new Set(await Effect.runPromise(git.ignoredPaths(root)))
          // EXTERNAL: The native addon cannot load in several worker threads,
          // so only the process that watches a tree loads it.
          const { default: parcelWatcher } = await import('@parcel/watcher')

          return parcelWatcher.subscribe(
            root,
            (error, changes) => {
              if (error) {
                return
              }

              for (const change of changes) {
                pending.add(path.relative(root, change.path))
              }

              schedule()
            },
            { ignore: ['.git', ...ignored] }
          )
        }

        const flush = async () => {
          const candidates = [...pending].filter((entry) => !isIgnored(entry))
          const notify = gitChanged
          pending.clear()
          gitChanged = false

          const newlyIgnored = candidates.length
            ? await Effect.runPromise(
                git
                  .checkIgnored(root, candidates)
                  .pipe(Effect.orElseSucceed(() => []))
              )
            : []

          if (closed) {
            return
          }

          if (notify || newlyIgnored.length < candidates.length) {
            for (const listener of listeners) {
              listener()
            }
          }

          for (const entry of newlyIgnored) {
            ignored.add(entry)
          }

          const directories = await Promise.all(
            newlyIgnored.map((entry) =>
              fs.lstat(path.join(root, entry)).then(
                (stats) => stats.isDirectory(),
                () => false
              )
            )
          )

          if (closed || !directories.includes(true)) {
            return
          }

          // EXTERNAL: Overlapping subscriptions on one root keep each other's
          // native watches alive, so the old one must end before the new one.
          await subscription?.unsubscribe()
          subscription = await subscribe()

          if (closed) {
            void subscription.unsubscribe()
          }

          gitChanged = true
          schedule()
        }

        const schedule = () => {
          timer ??= setTimeout(() => {
            timer = null
            flushing = flushing.then(flush).catch(() => {})
          }, CHANGE_BATCH_MS)
        }

        const unsubscribeEvents = events.subscribe((event) => {
          if (
            event.type === 'worktree.git_changed' &&
            event.data.worktreeId === worktree.id
          ) {
            gitChanged = true
            schedule()
          }
        })

        const close = () => {
          closed = true
          unsubscribeEvents()
          gitWatcher?.close()
          void subscription?.unsubscribe().catch(() => {})

          if (timer) {
            clearTimeout(timer)
          }

          if (watchers.get(worktree.id) === created) {
            watchers.delete(worktree.id)
          }
        }

        const ready = (async () => {
          const identity = await Effect.runPromise(
            git.worktreeLaunchIdentity(root)
          )

          // EXTERNAL: Git records commits, staging, and checkouts in HEAD and
          // index inside the tree's Git directory, outside linked trees.
          gitWatcher = watch(
            identity.gitDirectory,
            { persistent: false },
            (_, name) => {
              if (name === 'HEAD' || name === 'index') {
                gitChanged = true
                schedule()
              }
            }
          )
          gitWatcher.on('error', () => gitWatcher?.close())

          subscription = await subscribe()

          if (closed) {
            void subscription.unsubscribe()
          }
        })()

        const created: TreeWatcher = { listeners, ready, close }
        watcher = created
        watchers.set(worktree.id, created)
      }

      const current = watcher
      current.listeners.add(onChange)

      const release = () => {
        current.listeners.delete(onChange)

        if (!current.listeners.size) {
          current.close()
        }
      }

      yield* Effect.tryPromise({
        try: () => current.ready,
        catch: (cause) =>
          cause instanceof Error ? cause : new Error(String(cause))
      }).pipe(Effect.tapError(() => Effect.sync(release)))

      return release
    })
  }
}
