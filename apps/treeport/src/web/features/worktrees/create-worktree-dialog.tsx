import { useRef } from 'react'
import type {
  ProjectRecord,
  TerminalPresetDefinition,
  TerminalPresetDefinitionDiagnostic,
  TreeContextFieldDefinition,
  TreeContextFieldDiagnostic,
  TreeContextValues
} from '@treeport/shared'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '../../components/ui/dialog'
import { WorktreeForm } from './worktree-form'

export function CreateWorktreeDialog({
  project,
  onOpenChange,
  restoreFocusTo,
  presets,
  presetDiagnostics,
  presetsLoading,
  presetsError,
  onRetryPresets,
  contextFields,
  contextFieldDiagnostics,
  contextFieldsLoading,
  contextFieldsError,
  onRetryContextFields,
  onSubmit
}: {
  project: ProjectRecord | null
  onOpenChange: (open: boolean) => void
  restoreFocusTo: HTMLElement | null
  presets: TerminalPresetDefinition[]
  presetDiagnostics: TerminalPresetDefinitionDiagnostic[]
  presetsLoading: boolean
  presetsError: boolean
  onRetryPresets: () => void
  contextFields: TreeContextFieldDefinition[]
  contextFieldDiagnostics: TreeContextFieldDiagnostic[]
  contextFieldsLoading: boolean
  contextFieldsError: boolean
  onRetryContextFields: () => void
  onSubmit: (
    project: ProjectRecord,
    name: string,
    base: 'default' | 'current',
    initialTerminal: {
      name: string
      initialTitle?: string
      argv?: string[]
      returnToShell?: boolean
    },
    sourceWorktreeId?: string,
    treeContext?: TreeContextValues
  ) => void
}) {
  const submittedRef = useRef(false)

  return (
    <Dialog open={project !== null} onOpenChange={onOpenChange}>
      {project ? (
        <DialogContent
          className="max-w-md"
          mobilePresentation="dialog"
          restoreFocusTo={restoreFocusTo}
          onCloseAutoFocus={(event) => {
            if (submittedRef.current) {
              submittedRef.current = false
              event.preventDefault()
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>Create tree</DialogTitle>
            <DialogDescription className="sr-only">
              Create a linked tree and choose its starting point and initial
              terminal.
            </DialogDescription>
          </DialogHeader>
          <WorktreeForm
            project={project}
            presets={presets}
            presetDiagnostics={presetDiagnostics}
            presetsLoading={presetsLoading}
            presetsError={presetsError}
            onRetryPresets={onRetryPresets}
            contextFields={contextFields}
            contextFieldDiagnostics={contextFieldDiagnostics}
            contextFieldsLoading={contextFieldsLoading}
            contextFieldsError={contextFieldsError}
            onRetryContextFields={onRetryContextFields}
            busy={false}
            onSubmit={(
              name,
              base,
              initialTerminal,
              sourceWorktreeId,
              treeContext
            ) => {
              submittedRef.current = true
              onSubmit(
                project,
                name,
                base,
                initialTerminal,
                sourceWorktreeId,
                treeContext
              )
            }}
          />
        </DialogContent>
      ) : null}
    </Dialog>
  )
}
