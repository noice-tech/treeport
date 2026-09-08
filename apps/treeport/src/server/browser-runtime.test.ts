import { afterEach, expect, it, vi } from 'vitest'
import { browserRuntime } from './browser-runtime'

afterEach(() => vi.unstubAllEnvs())

it('uses native Chrome on macOS and a browser-only container on Linux', async () => {
  vi.stubEnv('TREEPORT_BROWSER_EXECUTABLE', '')
  await expect(browserRuntime('darwin')).resolves.toEqual({
    executablePath:
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    channel: 'chrome'
  })
  await expect(browserRuntime('linux')).resolves.toMatchObject({
    channel: 'docker'
  })
})

it('uses an explicit executable instead of Docker and rejects relative executable paths', async () => {
  vi.stubEnv('TREEPORT_BROWSER_EXECUTABLE', '/usr/bin/chromium')
  await expect(browserRuntime('linux')).resolves.toEqual({
    executablePath: '/usr/bin/chromium',
    channel: 'chromium'
  })
  vi.stubEnv('TREEPORT_BROWSER_EXECUTABLE', './chromium')
  await expect(browserRuntime('linux')).rejects.toThrow('absolute path')
})
