import type { BrowserMediaClientMessage } from '#protocol/browser'

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
  | { type: 'wheel'; message: BrowserMediaWheel }
  | { type: 'audio'; sampleRate: number; planes: Float32Array<ArrayBuffer>[] }
