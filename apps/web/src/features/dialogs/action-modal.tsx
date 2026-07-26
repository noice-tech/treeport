import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { XMarkIcon } from '@heroicons/react/16/solid'
import type {
  ProjectRecord,
  RemovePreview,
  TerminalPreset,
  WorktreeRecord
} from '@treeport/shared'
import { Button } from '../../components/ui/button'
import { focusableElements, trapTabKey } from '../../lib/focus'
import { cn } from '../../lib/utils'
import { ProjectForm } from '../projects/project-form'
import { TerminalPresetsManager } from '../terminal-presets/presets-manager'
import { RemoveConfirm } from '../worktrees/remove-confirm'
import {
  WorktreeForm,
  type WorktreeDestination
} from '../worktrees/worktree-form'

export type ActionModalState =
  | { type: 'project' }
  | { type: 'worktree'; project: ProjectRecord }
  | { type: 'presets' }
  | { type: 'remove'; worktree: WorktreeRecord; preview: RemovePreview }
  | null

export type RemovalStage = 'checking' | 'removing'

export function ActionModal({
  modal,
  close,
  restoreFocusTo,
  setError,
  presets,
  presetsLoading,
  presetsError,
  onRetryPresets,
  onCreateWorktree,
  removalStage,
  onConfirmRemoval,
  onProjectOpened
}: {
  modal: Exclude<ActionModalState, null>
  close: () => void
  restoreFocusTo: HTMLElement | null
  setError: (value: string | null) => void
  presets: TerminalPreset[]
  presetsLoading: boolean
  presetsError: boolean
  onRetryPresets: () => void
  onCreateWorktree: (
    project: ProjectRecord,
    name: string,
    base: 'default' | 'current',
    destination: WorktreeDestination,
    initialTerminal: {
      name: string
      argv?: string[]
      returnToShell?: boolean
    },
    sourceWorktreeId?: string
  ) => void
  removalStage: RemovalStage | null
  onConfirmRemoval: (worktree: WorktreeRecord, preview: RemovePreview) => void
  onProjectOpened: (project: ProjectRecord) => Promise<void>
}) {
  const dialogRef = useRef<HTMLElement | null>(null)
  const closeRef = useRef(close)
  closeRef.current = close

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) {
      return
    }

    const previouslyFocused = document.activeElement as HTMLElement | null
    const appFrame = document.querySelector<HTMLElement>('.app-frame')
    appFrame?.setAttribute('inert', '')
    const frame = window.requestAnimationFrame(() => {
      const autofocus = dialog.querySelector<HTMLElement>(
        '[data-modal-autofocus], [autofocus]'
      )
      const first = autofocus ?? focusableElements(dialog)[0]
      if (first) {
        first.focus()
      } else {
        dialog.focus()
      }
    })
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeRef.current()
        return
      }

      trapTabKey(event, dialog)
    }
    document.addEventListener('keydown', keydown)
    return () => {
      window.cancelAnimationFrame(frame)
      document.removeEventListener('keydown', keydown)
      appFrame?.removeAttribute('inert')
      if (restoreFocusTo?.isConnected) {
        restoreFocusTo.focus()
      } else if (previouslyFocused?.isConnected) {
        previouslyFocused.focus()
      }
    }
  }, [restoreFocusTo])

  return createPortal(
    <div
      className="modal-backdrop fixed inset-0 z-60 grid place-items-center bg-black/70 p-4 backdrop-blur-sm max-[700px]:items-end max-[700px]:p-0"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && close()}
    >
      <section
        ref={dialogRef}
        className={cn(
          'modal relative max-h-[calc(100dvh-2rem)] w-full overflow-y-auto rounded-xl bg-zinc-900 p-6 shadow-2xl ring-1 ring-white/10 max-[700px]:max-h-[90dvh] max-[700px]:max-w-none max-[700px]:rounded-b-none max-[700px]:p-5 max-[700px]:pb-[calc(1.25rem+env(safe-area-inset-bottom))]',
          modal.type === 'presets'
            ? 'max-w-3xl'
            : modal.type === 'worktree'
              ? 'max-w-md'
              : 'max-w-lg'
        )}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        tabIndex={-1}
      >
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="icon-button modal-close absolute top-3 right-3 text-zinc-500 hover:bg-white/5 hover:text-zinc-100"
          aria-label="Close"
          onClick={close}
        >
          <XMarkIcon />
          <span className="touch-target" aria-hidden="true" />
        </Button>
        {modal.type === 'project' && (
          <ProjectForm setError={setError} onOpened={onProjectOpened} />
        )}
        {modal.type === 'worktree' && (
          <WorktreeForm
            project={modal.project}
            presets={presets}
            presetsLoading={presetsLoading}
            presetsError={presetsError}
            onRetryPresets={onRetryPresets}
            busy={false}
            onSubmit={(
              name,
              base,
              destination,
              initialTerminal,
              sourceWorktreeId
            ) =>
              onCreateWorktree(
                modal.project,
                name,
                base,
                destination,
                initialTerminal,
                sourceWorktreeId
              )
            }
          />
        )}
        {modal.type === 'presets' && (
          <TerminalPresetsManager
            presets={presets}
            loading={presetsLoading}
            loadError={presetsError}
            onRetry={onRetryPresets}
            setError={setError}
          />
        )}
        {modal.type === 'remove' && (
          <RemoveConfirm
            worktree={modal.worktree}
            preview={modal.preview}
            busy={removalStage !== null}
            onConfirm={(preview) => onConfirmRemoval(modal.worktree, preview)}
          />
        )}
      </section>
    </div>,
    document.body
  )
}
