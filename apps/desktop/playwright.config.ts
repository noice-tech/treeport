import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  workers: 1,
  retries: process.env.CI ? 2 : 0
})
