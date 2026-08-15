import { EventEmitter } from 'node:events'
import crypto from 'node:crypto'
import type {
  ProductEvent,
  ProductEventInputDataMap,
  ProductEventType
} from '@treeport/shared'

export class ProductEventBus {
  private readonly emitter = new EventEmitter()

  publish<Type extends ProductEventType>(
    type: Type,
    data: ProductEventInputDataMap[Type]
  ): ProductEvent<Type> {
    // SAFETY: The payload keeps the fields for Type and normalizes only its
    // optional worktreeId field to the ProductEvent contract.
    const event = {
      id: crypto.randomUUID(),
      type,
      at: new Date().toISOString(),
      data: { ...data, worktreeId: data.worktreeId ?? null }
    } as ProductEvent<Type>
    this.emitter.emit('event', event)
    return event
  }

  subscribe(listener: (event: ProductEvent) => void): () => void {
    this.emitter.on('event', listener)
    return () => this.emitter.off('event', listener)
  }
}
