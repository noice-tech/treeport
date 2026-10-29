import vm from 'node:vm'
import { formatWithOptions } from 'node:util'
import type { Page } from 'playwright'

export async function runBrowserScript(
  page: Page,
  code: string
): Promise<string> {
  const lines: string[] = []

  const log = (...values: Parameters<typeof console.log>) => {
    lines.push(formatWithOptions({ depth: 6 }, ...values))
  }

  const script = new vm.Script(`(async () => {\n${code}\n})()`, {
    filename: 'treeport-browser-run.js'
  })

  // EXTERNAL: node:vm isolates globals and bounds synchronous loops, but it is
  // not a security boundary; callers already hold terminal-level access.
  const sandbox = vm.createContext({
    page,
    context: page.context(),
    console: { log, info: log, warn: log, error: log, debug: log },
    setTimeout,
    clearTimeout
  })

  let timer: ReturnType<typeof setTimeout> | null = null

  // EXTERNAL: A pending script holds the session's operation queue, so bound it.
  const result: unknown = await Promise.race([
    script.runInContext(sandbox, { timeout: 5_000 }),
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(new Error('The browser script timed out after 60 seconds.')),
        60_000
      )
    })
  ]).finally(() => clearTimeout(timer!))

  if (result !== undefined) {
    lines.push(formatWithOptions({ depth: 6 }, result))
  }

  return lines.join('\n') || 'Script completed without output.'
}
