import * as Context from 'effect/Context'
import type { AppService } from './app/app-service.ts'
import type { ProjectObservationService } from './project/project-observation-service.ts'
import type { ProjectRegistrationService } from './project/project-registration-service.ts'
import type { ProjectSnapshotService } from './project/project-snapshot-service.ts'
import type { TerminalService } from './terminal/terminal-service.ts'
import type { WorktreeReconciler } from './worktree/worktree-reconciler.ts'
import type { WorktreeService } from './worktree/worktree-service.ts'

export class AppOperations extends Context.Tag('treeport/AppOperations')<
  AppOperations,
  AppService
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
