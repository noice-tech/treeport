import path from 'node:path'
import react from '@vitejs/plugin-react'
import { build as viteBuild, type Rolldown } from 'vite'

export async function buildPanel(root: string, entry: string) {
  let script = ''
  let css = ''
  const assets = new Map<
    string,
    { body: string | Buffer; contentType: string }
  >()
  const build = await viteBuild({
    root,
    configFile: false,
    logLevel: 'silent',
    plugins: [react()],
    resolve: { dedupe: ['react', 'react-dom'] },
    build: {
      write: false,
      watch: null,
      cssCodeSplit: false,
      rollupOptions: {
        input: path.join(root, entry),
        output: { codeSplitting: false }
      }
    }
  })
  // SAFETY: watch is explicitly disabled above, so Vite cannot return a watcher.
  const result = build as Rolldown.RolldownOutput | Rolldown.RolldownOutput[]
  const output = Array.isArray(result)
    ? result.flatMap((entry) => entry.output)
    : result.output
  for (const item of output) {
    if (item.type === 'chunk') {
      if (item.isEntry) {
        script = item.code
      }

      assets.set(item.fileName, {
        body: item.code,
        contentType: 'text/javascript'
      })
    } else if (item.fileName.endsWith('.css')) {
      css =
        item.source instanceof Uint8Array
          ? new TextDecoder().decode(item.source)
          : item.source
    } else {
      assets.set(item.fileName, {
        body:
          item.source instanceof Uint8Array
            ? Buffer.from(item.source)
            : item.source,
        contentType: 'application/octet-stream'
      })
    }
  }
  return { script, css, assets }
}
