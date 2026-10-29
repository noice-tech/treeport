import vm from 'node:vm'
import { inspect } from 'node:util'
import type { Page } from 'playwright'

// Runs caller-authored Playwright code as an async function body with `page`
// and `context` in scope. The vm context keeps daemon globals out of reach by
// accident and bounds synchronous loops; it is not a security boundary.
export async function runBrowserScript(
  page: Page,
  code: string
): Promise<string> {
  const lines: string[] = []

  const format = (value: unknown) =>
    typeof value === 'string' ? value : inspect(value, { depth: 6 })

  const log = (...values: unknown[]) => {
    lines.push(values.map(format).join(' '))
  }

  const script = new vm.Script(`(async () => {\n${code}\n})()`, {
    filename: 'treeport-browser-run.js'
  })

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
    lines.push(format(result))
  }

  return lines.join('\n') || 'Script completed without output.'
}
