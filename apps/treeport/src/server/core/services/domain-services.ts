import * as Context from 'effect/Context'
import type { PanelService } from './panel/panel-service'
import type { ProjectObservationService } from './project/project-observation-service'
import type { ProjectRegistrationService } from './project/project-registration-service'
import type { ProjectSnapshotService } from './project/project-snapshot-service'
import type { TerminalService } from './terminal/terminal-service'
import type { WorktreeReconciler } from './worktree/worktree-reconciler'
import type { WorktreeService } from './worktree/worktree-service'

export class PanelOperations extends Context.Tag('treeport/PanelOperations')<
  PanelOperations,
  PanelService
>() {}

export class ProjectObservationOperations extends Context.Tag(
  'treeport/ProjectObservationOperations'
)<ProjectObservationOperations, ProjectObservationService>() {}

export class ProjectSnapshotOperations extends Context.Tag(
  'treeport/ProjectSnapshotOperations'
)<ProjectSnapshotOperations, ProjectSnapshotService>() {}

export class ProjectRegistrationOperations extends Context.Tag(
  'treeport/ProjectRegistrationOperations'
)<ProjectRegistrationOperations, ProjectRegistrationService>() {}

export class TerminalOperations extends Context.Tag(
  'treeport/TerminalOperations'
)<TerminalOperations, TerminalService>() {}

export class WorktreeReconciliation extends Context.Tag(
  'treeport/WorktreeReconciliation'
)<WorktreeReconciliation, WorktreeReconciler>() {}

export class WorktreeOperations extends Context.Tag(
  'treeport/WorktreeOperations'
)<WorktreeOperations, WorktreeService>() {}
