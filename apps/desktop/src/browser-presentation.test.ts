import { describe, expect, it } from 'vitest'
import { browserPresentationOrigin } from './browser-presentation'

describe('browser presentation permissions', () => {
  it('allows pointer lock and fullscreen independently for eligible web pages', () => {
    expect(
      browserPresentationOrigin(
        'pointerLock',
        'https://game.example.test/play',
        true
      )
    ).toBe('https://game.example.test')
    expect(
      browserPresentationOrigin(
        'fullscreen',
        'http://localhost:4173/video',
        true
      )
    ).toBe('http://localhost:4173')
  })

  it('denies ineligible, unrelated, and unsupported requests', () => {
    expect(
      browserPresentationOrigin(
        'pointerLock',
        'https://game.example.test/play',
        false
      )
    ).toBeNull()
    expect(
      browserPresentationOrigin('media', 'https://game.example.test/play', true)
    ).toBeNull()
    expect(
      browserPresentationOrigin('fullscreen', 'file:///tmp/video.html', true)
    ).toBeNull()
    expect(browserPresentationOrigin('fullscreen', undefined, true)).toBeNull()
  })
})
