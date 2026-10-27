import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { getSessionKeeperPayload } from '@treeport/session-keeper'
import type { TerminalRecord, WorktreeRecord } from '@treeport/shared'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Scope from 'effect/Scope'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TerminalHostSessions } from '../terminal-runtime/sessions'
import { ProductEventBus } from './core/events'
import type { TreeportService } from './core/index'
import { TerminalMetadataManager } from './terminal-metadata'
import { testAccess } from './test-access'

const zsh = (() => {
  try {
    return execFileSync('sh', ['-c', 'command -v zsh']).toString().trim()
  } catch {
    return null
  }
})()

const OH_MY_ZSH_TITLES = `until [[ -e ~/subscribed ]]; do sleep 0.01; done
autoload -Uz add-zsh-hook
_fixture_title_precmd() { print -Pn '\\e]2;%n@%m:%~\\a' }
_fixture_title_preexec() { print -rn -- $'\\e]2;'"$1"$'\\a' }
add-zsh-hook precmd _fixture_title_precmd
add-zsh-hook preexec _fixture_title_preexec
PS1='READY> '
`

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup()
  }
})

async function fixture(command: string | null) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'treeport-title-'))
  await fs.writeFile(path.join(root, '.zshrc'), OH_MY_ZSH_TITLES)
  const scope = await Effect.runPromise(Scope.make())

  const host = await Effect.runPromise(
    Scope.extend(
      TerminalHostSessions.make({
        runtimeDir: root,
        launcherPath: path.resolve(
          import.meta.dirname,
          '../../dist/node/server/core/launcher.js'
        ),
        sessionExecutable: getSessionKeeperPayload()
      }),
      scope
    )
  )

  const terminal: TerminalRecord = {
    id: 'term',
    worktreeId: 'tree',
    name: 'Agent process',
    command,
    status: 'running',
    exitCode: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }

  // SAFETY: Metadata tracking only reads events and forks effects from the service.
  const service = testAccess<TreeportService>({
    events: new ProductEventBus(),
    projects: { listProjects: () => Effect.succeed([]) },
    runEffect: (effect: Effect.Effect<unknown>) => Effect.runPromise(effect),
    forkApplicationEffect: (effect: Effect.Effect<void>) => {
      Effect.runFork(effect)
    },
    terminalMetadataMutation: (
      _terminalId: string,
      effect: Effect.Effect<void>
    ) => effect,
    drainTerminalMetadataMutations: () => Effect.void
  })

  const metadata = new TerminalMetadataManager(service, host, {
    load: () => Effect.succeed([]),
    upsert: () => Effect.void,
    markRead: () => Effect.void,
    delete: () => Effect.void
  })

  cleanups.push(async () => {
    metadata.dispose()
    await Effect.runPromise(host.killWorktree('tree'))
    await Effect.runPromise(Scope.close(scope, Exit.void))
    await fs.rm(root, { recursive: true, force: true })
  })

  await Effect.runPromise(
    host.createTerminal({
      terminalId: terminal.id,
      worktreeId: terminal.worktreeId,
      name: terminal.name,
      createdAt: terminal.createdAt,
      cwd: root,
      shell: zsh!,
      command,
      afterExit: 'shell',
      env: { HOME: root, ZDOTDIR: root }
    })
  )
  await service.runEffect(metadata.initialize())
  await service.runEffect(
    metadata.trackTerminal(terminal, testAccess<WorktreeRecord>({ id: 'tree' }))
  )
  await fs.writeFile(path.join(root, 'subscribed'), '')
  const directories = [root, await fs.realpath(root)]

  return {
    directories,
    activity: () => metadata.get('term').activity.state,
    started: () =>
      vi.waitFor(() => fs.access(path.join(root, 'started')), {
        timeout: 10_000
      }),
    expectTitle: async (...accepted: string[]) => {
      await vi.waitFor(
        () => expect(accepted).toContain(metadata.get('term').title),
        { timeout: 10_000 }
      )
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(accepted).toContain(metadata.get('term').title)
    },
    input: async (text: string) => {
      const transition = await Effect.runPromise(
        host.prepareQueryAuthority('term')
      )

      await Effect.runPromise(
        host.activateQueryAuthority(
          'term',
          transition!.transitionId,
          'test',
          1,
          null
        )
      )
      await Effect.runPromise(
        host.write('term', text, { attachmentId: 'test', generation: 1 })
      )
    }
  }
}

describe.skipIf(!zsh)('terminal titles for foreground programs', () => {
  it('shows the program a launched command is running', async () => {
    const terminal = await fixture('touch started && sleep 30')
    await terminal.started()

    await terminal.expectTitle('sleep 30')
  })

  it('shows typed programs, titles they set, and the directory at the prompt', async () => {
    const terminal = await fixture(null)
    await terminal.expectTitle(...terminal.directories)

    await terminal.input('sleep 31\r')
    await terminal.expectTitle('sleep 31')

    await terminal.input('\u0003')
    await terminal.expectTitle(...terminal.directories)

    await terminal.input("printf '\\e]2;Agent\\a'; sleep 32\r")
    await terminal.expectTitle('Agent')

    await terminal.input('\u0003')
    await terminal.expectTitle(...terminal.directories)
  })

  it('keeps a program running when it marks its own output zones', async () => {
    const terminal = await fixture(null)
    await terminal.expectTitle(...terminal.directories)

    await terminal.input(
      "printf '\\e]7501;state=working:app=agent\\e\\\\\\e]133;A\\a\\e]133;B\\a\\e]133;C\\a'; sleep 33\r"
    )
    await terminal.expectTitle('sleep 33')
    expect(terminal.activity()).toBe('working')
  })
})
