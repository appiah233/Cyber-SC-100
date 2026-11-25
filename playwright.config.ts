import { defineConfig } from '@playwright/test'

const port = process.env.PLAYWRIGHT_STATIC_PORT ?? '4177'
const origin = `http://127.0.0.1:${port}`
const baseURL = `${origin}/Cyber-SC-100/`
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH

export default defineConfig({
  testDir: 'tests/e2e',
  forbidOnly: Boolean(process.env.CI),
  workers: 2,
  reporter: 'line',
  use: {
    baseURL,
    browserName: 'chromium',
    launchOptions: executablePath ? { executablePath } : {},
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  webServer: {
    command: 'node tests/e2e/serve-dist.mjs',
    url: baseURL,
    reuseExistingServer: false,
    stdout: 'ignore',
    stderr: 'pipe',
  },
})
