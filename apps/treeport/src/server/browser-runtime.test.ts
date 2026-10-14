import fs from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { browserRuntime } from './browser-runtime'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

it('discovers native Chrome or Chromium on macOS and Linux without downloading a browser', async () => {
  vi.stubEnv('TREEPORT_BROWSER_EXECUTABLE', '')
  const access = vi.spyOn(fs, 'access').mockRejectedValue(new Error('ENOENT'))
  await expect(browserRuntime('darwin')).resolves.toEqual({
    executablePath:
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    channel: 'chrome'
  })
  await expect(browserRuntime('linux')).resolves.toEqual({
    executablePath: '/opt/google/chrome/chrome',
    channel: 'chrome'
  })

  for (const executablePath of [
    '/opt/google/chrome/chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ]) {
    access.mockImplementation(async (candidate) => {
      if (candidate !== executablePath) {
        throw new Error('ENOENT')
      }
    })
    await expect(browserRuntime('linux')).resolves.toEqual({
      executablePath,
      channel: executablePath.includes('chromium') ? 'chromium' : 'chrome'
    })
  }
})

it('uses an explicit native executable and rejects relative executable paths', async () => {
  vi.stubEnv('TREEPORT_BROWSER_EXECUTABLE', '/usr/bin/chromium')
  await expect(browserRuntime('linux')).resolves.toEqual({
    executablePath: '/usr/bin/chromium',
    channel: 'chromium'
  })
  vi.stubEnv('TREEPORT_BROWSER_EXECUTABLE', '/usr/bin/google-chrome-stable')
  await expect(browserRuntime('linux')).resolves.toEqual({
    executablePath: '/usr/bin/google-chrome-stable',
    channel: 'chrome'
  })
  vi.stubEnv('TREEPORT_BROWSER_EXECUTABLE', './chromium')
  await expect(browserRuntime('linux')).rejects.toThrow('absolute path')
})
