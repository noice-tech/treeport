import type { Page } from '@playwright/test'
import type {
  CleanupCommandProgress,
  OperationRecord,
  ProjectRecord,
  RemovePreview
} from '@treeport/shared'

export async function createWorktreeMock(page: Page, state: ProjectRecord) {
  let removePreviewRequests = 0
  let removePreviewDelayMs = 0
  let removePreviewOverride: Partial<RemovePreview> = {}
  let staleRemovePreview: Partial<RemovePreview> | null = null
  let removeRequests = 0
  const removeRequestBodies: unknown[] = []
  let removeGate: Promise<void> | null = null
  let releaseRemove: (() => void) | null = null
  let createGate: Promise<void> | null = null
  let releaseCreate: (() => void) | null = null
  let failCreate = false
  let creationSequence = 0
  const creationOperations = new Map<string, OperationRecord>()
  let removeOperation: OperationRecord | null = null

  await page.route('**/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname
    if (pathname.endsWith('/remove-preview')) {
      removePreviewRequests += 1
      if (removePreviewDelayMs) {
        await new Promise((resolve) =>
          setTimeout(resolve, removePreviewDelayMs)
        )
      }

      const worktree = state.worktrees[1]!
      await route.fulfill({
        json: {
          preview: {
            worktreeId: worktree.id,
            name: worktree.name,
            branch: worktree.branch,
            path: worktree.path,
            head: worktree.head,
            detached: worktree.detached,
            locked: false,
            lockReason: null,
            dirty: worktree.dirty,
            detachedHeadReachable: null,
            forceRequired: false,
            eligible: true,
            reasons: [],
            warnings: [],
            cleanup: {
              commands: [],
              available: true,
              unavailableReason: null
            },
            terminals: worktree.terminals.map(({ id, name, status }) => ({
              id,
              name,
              status
            })),
            confirmationToken: 'a'.repeat(64),
            ...removePreviewOverride
          }
        }
      })
      return
    }

    if (pathname === '/api/operations' && route.request().method() === 'GET') {
      await route.fulfill({
        json: {
          operations: [
            ...creationOperations.values(),
            ...(removeOperation ? [removeOperation] : [])
          ].filter(
            (operation) =>
              operation.status === 'pending' || operation.status === 'running'
          )
        }
      })
      return
    }

    const operationMatch = pathname.match(/^\/api\/operations\/([^/]+)$/)
    if (operationMatch && route.request().method() === 'GET') {
      await route.fulfill({
        json: {
          operation:
            creationOperations.get(operationMatch[1]!) ??
            (removeOperation?.id === operationMatch[1]!
              ? removeOperation
              : undefined)
        }
      })
      return
    }

    if (
      pathname === '/api/projects/proj_1/worktree-operations' &&
      route.request().method() === 'POST'
    ) {
      const body: {
        name: string
        base: 'default' | 'current'
        sourceWorktreeId?: string
        context?: Record<string, string>
        initialTerminal?: {
          name: string
          initialTitle?: string
          argv?: string[]
          returnToShell?: boolean
        }
      } = route.request().postDataJSON()
      const canonicalName = body.name
        .normalize('NFKD')
        .replace(/\p{Mark}+/gu, '')
        .toLowerCase()
        .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
        .replace(/^-+|-+$/gu, '')
      const operation: OperationRecord = {
        id: `op_create_${++creationSequence}`,
        kind: 'create',
        projectId: 'proj_1',
        worktreeId: null,
        status: 'pending',
        request: { ...body, name: canonicalName },
        result: null,
        error: null,
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01'
      }
      creationOperations.set(operation.id, operation)
      await route.fulfill({ status: 202, json: { operation } })

      void (async () => {
        operation.status = 'running'

        if (createGate) {
          await createGate
        }

        createGate = null
        releaseCreate = null

        if (failCreate) {
          failCreate = false
          operation.status = 'failed'
          operation.error = 'create failed'
          return
        }

        const terminal = {
          id: 'term_new',
          worktreeId: 'wt_new',
          name: body.initialTerminal?.name ?? 'Shell',
          argv: body.initialTerminal?.argv ?? ['/bin/zsh', '-l'],
          shellCommand: null,
          interactiveShell: !body.initialTerminal?.argv,
          status: 'running' as const,
          exitCode: null,
          createdAt: '2026-01-01',
          updatedAt: '2026-01-01'
        }
        const worktree = {
          ...structuredClone(state.worktrees[1]!),
          id: 'wt_new',
          name: canonicalName,
          path: `/worktrees/${canonicalName}/repo`,
          terminals: [terminal],
          panels: []
        }
        const existingIndex = state.worktrees.findIndex(
          (item) => item.id === worktree.id
        )
        if (existingIndex >= 0) {
          state.worktrees[existingIndex] = worktree
        } else {
          state.worktrees.push(worktree)
        }

        operation.status = 'completed'
        operation.worktreeId = worktree.id
        operation.result = {
          worktreeId: worktree.id,
          terminalId: terminal.id,
          terminalError: null,
          setupError: null
        }
      })()
      return
    }

    if (pathname.endsWith('/remove')) {
      removeRequests += 1
      removeRequestBodies.push(route.request().postDataJSON())
      if (staleRemovePreview) {
        removePreviewOverride = staleRemovePreview
        staleRemovePreview = null
        await route.fulfill({
          status: 409,
          json: {
            error: {
              code: 'REMOVE_PREVIEW_STALE',
              message:
                'The worktree changed after the removal preview; review it again'
            }
          }
        })
        return
      }

      if (removeGate) {
        await removeGate
      }

      removeGate = null
      releaseRemove = null
      const worktree = state.worktrees[1]!
      removeOperation = {
        id: 'op_1',
        kind: 'remove',
        projectId: worktree.projectId,
        worktreeId: worktree.id,
        status: 'pending',
        request: {
          confirmation: null,
          confirmationToken: 'a'.repeat(64),
          confirmDestructive: false,
          preview: {
            worktreeId: worktree.id,
            name: worktree.name,
            path: worktree.path,
            head: worktree.head,
            branch: worktree.branch,
            detached: worktree.detached,
            locked: worktree.locked,
            lockReason: worktree.lockReason,
            dirty: {
              dirty: false,
              staged: 0,
              unstaged: 0,
              untracked: 0,
              conflicts: 0,
              total: 0
            },
            detachedHeadReachable: true,
            forceRequired: false,
            eligible: true,
            reasons: [],
            warnings: [],
            cleanup: removePreviewOverride.cleanup ?? {
              commands: [],
              available: true,
              unavailableReason: null
            },
            terminals: [],
            confirmationToken: 'a'.repeat(64)
          },
          checkoutIdentity: null,
          prunable: false,
          gitWorktreeKey: 'worktrees/feature',
          repositoryIdentity: 'repository',
          phase: 'accepted',
          managedWrapperPath: worktree.managedWrapperPath,
          cleanupCommands: {
            status:
              (removePreviewOverride.cleanup?.commands.length ?? 0) > 0
                ? 'pending'
                : 'completed',
            definitionHash:
              (removePreviewOverride.cleanup?.commands.length ?? 0) > 0
                ? 'cleanup-definition'
                : null,
            skippedReason: null,
            commands: (removePreviewOverride.cleanup?.commands ?? []).map(
              (name) => ({
                name,
                status: 'pending',
                stdout: '',
                stderr: '',
                exitCode: null,
                error: null,
                outputTruncated: false
              })
            )
          }
        },
        result: null,
        error: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
      await route.fulfill({
        status: 202,
        json: { operation: removeOperation }
      })
      return
    }

    if (pathname.endsWith('/pr/refresh')) {
      await route.fulfill({ json: { pr: state.worktrees[1]!.pr } })
      return
    }

    await route.fallback()
  })

  return {
    removePreviewRequests: () => removePreviewRequests,
    setRemovePreview: (value: Partial<RemovePreview>) => {
      removePreviewOverride = value
    },
    setRemovePreviewDelay: (value: number) => {
      removePreviewDelayMs = value
    },
    removeRequests: () => removeRequests,
    removeRequestBodies: () => [...removeRequestBodies],
    setRemovalCleanup: (
      status: 'pending' | 'running' | 'completed' | 'failed',
      commands: CleanupCommandProgress[],
      error: string | null = null
    ) => {
      if (removeOperation?.kind === 'remove') {
        removeOperation = {
          ...removeOperation,
          status,
          error,
          request: {
            ...removeOperation.request,
            cleanupCommands: {
              ...removeOperation.request.cleanupCommands,
              status,
              commands
            }
          },
          updatedAt: new Date().toISOString()
        }
      }
    },
    completeRemoval: () => {
      const worktree = state.worktrees[1]
      if (worktree && removeOperation?.kind === 'remove') {
        state.worktrees.splice(1, 1)
        removeOperation = {
          ...removeOperation,
          worktreeId: null,
          status: 'completed',
          result: {
            removed: true,
            worktreeId: worktree.id,
            name: worktree.name,
            branchPreserved: worktree.branch,
            path: worktree.path,
            recovered: false,
            cleanup: {
              status: 'completed',
              residualPath: null,
              warning: null,
              commands: []
            }
          },
          updatedAt: new Date().toISOString()
        }
      }
    },
    staleNextRemoveWithPreview: (value: Partial<RemovePreview>) => {
      staleRemovePreview = value
    },
    delayNextRemove: () => {
      removeGate = new Promise<void>((resolve) => {
        releaseRemove = resolve
      })
      return () => releaseRemove?.()
    },
    delayNextCreate: () => {
      createGate = new Promise<void>((resolve) => {
        releaseCreate = resolve
      })
      return () => releaseCreate?.()
    },
    failNextCreate: () => {
      failCreate = true
    }
  }
}
