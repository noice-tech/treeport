import path from 'node:path'
import react from '@vitejs/plugin-react'
import { build as viteBuild } from 'vite'

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
      cssCodeSplit: false,
      rollupOptions: {
        input: path.join(root, entry),
        output: { codeSplitting: false }
      }
    }
  })
  const output = Array.isArray(build)
    ? build.flatMap((result) => result.output)
    : build.output
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
