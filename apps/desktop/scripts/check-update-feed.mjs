#!/usr/bin/env node
import { setTimeout as delay } from 'node:timers/promises'

const [version, ...extra] = process.argv.slice(2)
if (
  !version ||
  extra.length ||
  !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)
) {
  throw new Error(
    'Usage: node scripts/check-update-feed.mjs <published-version>'
  )
}

const expectedUrl = `https://github.com/noice-tech/treeport/releases/download/v${version}/Treeport-${version}-darwin-universal.zip`
await Promise.all(
  ['darwin-arm64', 'darwin-x64'].map(async (platform) => {
    const url = `https://update.electronjs.org/noice-tech/treeport/${platform}/0.0.0`
    const deadline = Date.now() + 10 * 60_000
    let observed = null
    do {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(10_000)
      }).catch(() => null)
      observed =
        response?.status === 200
          ? await response.json().catch(() => null)
          : null
      if (observed?.name === `v${version}` && observed?.url === expectedUrl) {
        console.log(`${platform}: published update resolves to ${expectedUrl}`)
        return
      }

      await delay(15_000)
    } while (Date.now() < deadline)
    throw new Error(
      `${url} did not advertise ${version} within ten minutes. Last response: ${JSON.stringify(observed)}`
    )
  })
)
