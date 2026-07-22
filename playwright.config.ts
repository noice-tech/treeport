import { createHash } from 'node:crypto'
import { defineConfig, devices } from '@playwright/test'

const worktreePort =
  20_000 +
  (Number.parseInt(
    createHash('sha256').update(process.cwd()).digest('hex').slice(0, 4),
    16
  ) %
    20_000)
const e2ePort = Number(process.env.TASKTTY_E2E_PORT ?? worktreePort)
const e2eUrl = `http://127.0.0.1:${e2ePort}`

export default defineConfig({
  testDir: 'apps/web/e2e',
  timeout: 20_000,
  use: { baseURL: e2eUrl, trace: 'retain-on-failure' },
  webServer: {
    command: `pnpm --filter @tasktty/web exec vite --host 127.0.0.1 --port ${e2ePort} --strictPort`,
    url: e2eUrl,
    reuseExistingServer: false,
    timeout: 120_000
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'] } }
  ]
})
