import fs from 'node:fs/promises'

let compiled: Promise<WebAssembly.Module> | null = null

export function loadGhosttyVtModule(): Promise<WebAssembly.Module> {
  compiled ??= fs
    .readFile(new URL('./ghostty-vt.wasm', import.meta.url))
    .then((bytes) => WebAssembly.compile(bytes))

  return compiled
}
