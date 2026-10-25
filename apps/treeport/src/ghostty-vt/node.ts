import fs from 'node:fs/promises'

let compiled: Promise<WebAssembly.Module> | null = null

export function loadGhosttyVtModule(): Promise<WebAssembly.Module> {
  compiled ??= (async () => {
    for (const candidate of ['./ghostty-vt.wasm', '../../ghostty-vt.wasm']) {
      const bytes = await fs
        .readFile(new URL(candidate, import.meta.url))
        .catch(() => null)

      if (bytes) {
        return WebAssembly.compile(bytes)
      }
    }

    throw new Error('ghostty-vt.wasm is missing')
  })()

  return compiled
}
