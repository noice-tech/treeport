import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import type { ProductEvent, ProductEventType } from "@wtr/shared";

export class ProductEventBus {
  private readonly emitter = new EventEmitter();

  publish(type: ProductEventType, data: Record<string, unknown>): ProductEvent {
    const event: ProductEvent = {
      id: crypto.randomUUID(),
      type,
      at: new Date().toISOString(),
      data,
    };
    this.emitter.emit("event", event);
    return event;
  }

  subscribe(listener: (event: ProductEvent) => void): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }
}
