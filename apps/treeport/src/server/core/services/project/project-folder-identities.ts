import * as Effect from 'effect/Effect'
import * as Ref from 'effect/Ref'

interface ProjectFolderIdentity {
  readonly device: string
  readonly inode: string
}

export class ProjectFolderIdentities extends Effect.Service<ProjectFolderIdentities>()(
  'treeport/ProjectFolderIdentities',
  {
    scoped: Effect.gen(function* () {
      const identities = yield* Ref.make(
        new Map<string, ProjectFolderIdentity>()
      )
      yield* Effect.addFinalizer(() => Ref.set(identities, new Map()))

      return {
        snapshot: Ref.get(identities),
        get: (projectId: string) =>
          Ref.get(identities).pipe(
            Effect.map((current) => current.get(projectId) ?? null)
          ),
        set: (projectId: string, identity: ProjectFolderIdentity) =>
          Ref.update(identities, (current) => {
            const next = new Map(current)
            next.set(projectId, identity)
            return next
          }),
        remove: (projectId: string) =>
          Ref.update(identities, (current) => {
            if (!current.has(projectId)) {
              return current
            }

            const next = new Map(current)
            next.delete(projectId)
            return next
          })
      }
    })
  }
) {}
