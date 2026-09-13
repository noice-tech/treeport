import type { TerminalRecord } from '@treeport/shared'

export interface TerminalLayoutDragSnapshot {
  terminal: TerminalRecord
  clientX: number
  clientY: number
}

type DropHandler = (snapshot: TerminalLayoutDragSnapshot) => boolean

class TerminalLayoutDragStore {
  private snapshot: TerminalLayoutDragSnapshot | null = null
  private readonly listeners = new Set<() => void>()
  private dropHandler: DropHandler | null = null

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): TerminalLayoutDragSnapshot | null => this.snapshot

  update(terminal: TerminalRecord, clientX: number, clientY: number): void {
    this.snapshot = { terminal, clientX, clientY }
    for (const listener of this.listeners) {
      listener()
    }
  }

  finish(terminal: TerminalRecord, clientX: number, clientY: number): boolean {
    const snapshot = { terminal, clientX, clientY }
    const handled = this.dropHandler?.(snapshot) ?? false
    this.clear()
    return handled
  }

  cancel(): void {
    this.clear()
  }

  registerDropHandler(handler: DropHandler): () => void {
    this.dropHandler = handler
    return () => {
      if (this.dropHandler === handler) {
        this.dropHandler = null
      }
    }
  }

  private clear(): void {
    if (!this.snapshot) {
      return
    }

    this.snapshot = null
    for (const listener of this.listeners) {
      listener()
    }
  }
}

export const terminalLayoutDrag = new TerminalLayoutDragStore()
