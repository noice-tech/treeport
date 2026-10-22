import type { BrowserMediaClientMessage } from '@treeport/shared'

export type BrowserMediaWheel = Extract<
  BrowserMediaClientMessage,
  { type: 'wheel' }
>

export type BrowserMediaWorkerCommand =
  | { type: 'canvas'; canvas: OffscreenCanvas }
  | { type: 'connect'; url: string; token: string }
  | {
      type: 'configure'
      config: { epoch: number; codec: string; width: number; height: number }
    }
  | { type: 'wheel'; message: BrowserMediaWheel }
  | { type: 'stop' }

export type BrowserMediaWorkerEvent =
  | { type: 'presented'; epoch: number }
  | { type: 'media'; connected: boolean }
  // A wheel that raced a media socket drop; the session socket carries it.
  | { type: 'wheel'; message: BrowserMediaWheel }
