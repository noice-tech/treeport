import {
  GhosttyTerminal,
  TERMINAL_IMAGE_STORAGE_BYTES
} from '../ghostty-vt/ghostty-vt'
import { loadGhosttyVtModule } from '../ghostty-vt/node'

export async function restoreTestSnapshot(
  data: string,
  writePty: ((data: Uint8Array) => void) | null = null
): Promise<GhosttyTerminal> {
  return GhosttyTerminal.restore(
    await loadGhosttyVtModule(),
    Buffer.from(data, 'base64'),
    {
      scrollbackLines: 50_000,
      continuationBytes: 0,
      imageStorageBytes: TERMINAL_IMAGE_STORAGE_BYTES,
      foreground: 0xffffff,
      background: 0
    },
    {
      writePty,
      bell: null,
      titleChanged: null,
      pwdChanged: null,
      semanticPrompt: null,
      progress: null,
      programStatus: null,
      reset: null,
      unknownOsc: null,
      renderHold: null,
      clipboardWrite: null
    }
  )
}

export function hasKittyImage(
  terminal: GhosttyTerminal,
  imageId: number
): boolean {
  const storage = terminal.data('KITTY_GRAPHICS', (view, ptr) =>
    view.getUint32(ptr, true)
  )

  return (
    storage !== null &&
    terminal.vt.call('ghostty_kitty_graphics_image', storage, imageId) !== 0
  )
}
