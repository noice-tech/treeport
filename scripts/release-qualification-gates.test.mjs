import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path) => fs.readFileSync(path, 'utf8')

function expectGateBefore(source, gate, publication) {
  const gateIndex = source.indexOf(gate)
  const publicationIndex = source.indexOf(publication)
  expect(gateIndex).toBeGreaterThanOrEqual(0)
  expect(publicationIndex).toBeGreaterThan(gateIndex)
}

describe('packaged terminal API release gate', () => {
  it('stays explicit and outside ordinary signoff', () => {
    const manifest = JSON.parse(read('package.json'))
    expect(manifest.scripts.check).not.toContain('release-qualification')
    expect(manifest.scripts['test:integration:run']).not.toContain(
      'terminal-api.release'
    )
    expect(manifest.scripts['test:release-qualification']).toBe(
      'pnpm --filter @treeport/treeport build && vitest run --config vitest.release.config.ts'
    )
    expect(read('vitest.release.config.ts')).toContain(
      "include: ['scripts/terminal-api.release.mjs']"
    )
  })

  it('blocks every supported publication path before artifact mutation', () => {
    expectGateBefore(
      read('scripts/prepare-release.mjs'),
      "run('pnpm', ['test:release-qualification']",
      "git(['push', '--atomic'"
    )
    expectGateBefore(
      read('scripts/publish-release.mjs'),
      "run('pnpm', ['test:release-qualification']",
      "'publish',\n        '--access'"
    )
    expectGateBefore(
      read('.github/workflows/desktop-release.yml'),
      'run: pnpm test:release-qualification',
      'pnpm exec electron-forge publish --dry-run'
    )
  })
})
