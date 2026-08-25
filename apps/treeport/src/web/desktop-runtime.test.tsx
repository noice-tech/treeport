import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  browserRuntimeMode,
  DesktopRuntimeProvider,
  useDesktopRuntime
} from './desktop-runtime'

function RuntimeValue() {
  const runtime = useDesktopRuntime()
  return `${runtime.localBrowser ? 'local' : 'remote'}:${runtime.computerId ?? 'none'}`
}

describe('Browser runtime selection', () => {
  it('uses a local Browser only for a loopback Electron computer', () => {
    expect(browserRuntimeMode(false, false)).toBe('remote')
    expect(browserRuntimeMode(false, true)).toBe('remote')
    expect(browserRuntimeMode(true, false)).toBe('remote')
    expect(browserRuntimeMode(true, true)).toBe('local')

    expect(
      renderToStaticMarkup(
        <DesktopRuntimeProvider computerId="computer-1" localBrowser>
          <RuntimeValue />
        </DesktopRuntimeProvider>
      )
    ).toContain('local:computer-1')
  })
})
