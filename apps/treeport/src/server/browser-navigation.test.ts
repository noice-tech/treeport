import { EventEmitter } from 'node:events'
import { expect, it } from 'vitest'
import { browserNavigation } from './browser-navigation'

it.each(['native', 'hosted'])(
  'settles canceled %s navigation and observes late rejection',
  async (owner) => {
    const page = new EventEmitter()
    const cdp = new EventEmitter()
    let failNavigation: (error: Error) => void = () => undefined
    const navigation = new Promise<void>((_resolve, reject) => {
      failNavigation = reject
    })
    // SAFETY: The helper only uses EventEmitter methods on these protocol fakes.
    const result = browserNavigation(
      page as never,
      () => navigation,
      owner === 'native' ? (cdp as never) : null
    )
    const rejected = expect(result).rejects.toThrow(
      'Navigation canceled by beforeunload'
    )
    if (owner === 'native') {
      cdp.emit('Treeport.navigationCanceled')
    } else {
      page.emit('dialog', { type: () => 'beforeunload' })
    }

    await rejected
    expect(page.listenerCount('dialog')).toBe(0)
    expect(cdp.listenerCount('Treeport.navigationCanceled')).toBe(0)
    failNavigation(new Error('Browser disconnected during cleanup'))
    await new Promise<void>((resolve) => setImmediate(resolve))
    // A subsequent command is not blocked by the canceled navigation.
    // SAFETY: The helper only uses EventEmitter methods on this page fake.
    await expect(
      browserNavigation(page as never, async () => 'next')
    ).resolves.toBe('next')
  }
)

it('ignores ordinary dialogs and cleans up after success or failure', async () => {
  const page = new EventEmitter()
  // SAFETY: The helper only uses EventEmitter methods on this page fake.
  await expect(
    browserNavigation(page as never, async () => {
      page.emit('dialog', { type: () => 'alert' })
      return 'committed'
    })
  ).resolves.toBe('committed')
  // SAFETY: The helper only uses EventEmitter methods on this page fake.
  await expect(
    browserNavigation(page as never, async () => {
      throw new Error('Navigation failed')
    })
  ).rejects.toThrow('Navigation failed')
  expect(page.listenerCount('dialog')).toBe(0)
})
