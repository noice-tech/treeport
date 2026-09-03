import * as Effect from 'effect/Effect'
import { makeMutationCoordinator } from '../infrastructure/mutation-coordinator'

/** Serializes package settings and installation changes by settings scope. */
export class PackageMutations extends Effect.Service<PackageMutations>()(
  'treeport/PackageMutations',
  {
    scoped: makeMutationCoordinator<string>()
  }
) {}
