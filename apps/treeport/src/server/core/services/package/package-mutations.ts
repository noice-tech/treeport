import * as Effect from 'effect/Effect'
import { makeMutationCoordinator } from '../infrastructure/mutation-coordinator.ts'

export class PackageMutations extends Effect.Service<PackageMutations>()(
  'treeport/PackageMutations',
  {
    scoped: makeMutationCoordinator<string>()
  }
) {}
