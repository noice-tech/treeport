import { expect, it } from 'vitest'
import { refreshVisibleFiles } from './refresh-visible-files'

it('refreshes only mutable visible expanded patches and bounds parallel reads', async () => {
  const files = [
    ...Array.from({ length: 12 }, (_, index) => ({
      id: `local-${index}`,
      scope: 'uncommitted' as const,
      loadState: 'ready'
    })),
    { id: 'committed', scope: 'committed' as const, loadState: 'ready' },
    { id: 'new-head', scope: 'committed' as const, loadState: 'idle' },
    { id: 'hidden', scope: 'uncommitted' as const, loadState: 'ready' },
    { id: 'collapsed', scope: 'uncommitted' as const, loadState: 'ready' }
  ]
  const visible = new Set(
    files.filter((file) => file.id !== 'hidden').map((file) => file.id)
  )
  const loaded: Array<{ id: string; reload: boolean }> = []
  let active = 0
  let peak = 0
  await refreshVisibleFiles(
    files,
    visible,
    new Set(['collapsed']),
    async (id, reload) => {
      active++
      peak = Math.max(peak, active)
      loaded.push({ id, reload })
      await Promise.resolve()
      active--
    }
  )
  expect(peak).toBe(4)
  expect(loaded).toHaveLength(13)
  expect(loaded.find((file) => file.id === 'new-head')).toEqual({
    id: 'new-head',
    reload: false
  })
  expect(
    loaded
      .filter((file) => file.id.startsWith('local-'))
      .every((file) => file.reload)
  ).toBe(true)
  expect(
    loaded.some((file) =>
      ['hidden', 'collapsed', 'committed'].includes(file.id)
    )
  ).toBe(false)
})
