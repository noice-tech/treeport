import { describe, expect, it, vi } from 'vitest'
import type { BrowserServerMessage } from '@treeport/shared'
import {
  connectNativeBrowserPanel,
  nativeBrowserAvailable,
  requestNativeBrowserClose
} from './native-browser-session-client'

function testAccess<Target extends object, Fixture extends object = object>(
  value: Fixture
): Target {
  // SAFETY: Tests intentionally supply only the contract used by the subject.
  return Object(value) as Target
}

describe('native Browser client', () => {
  it('opens, controls, persists, and closes the desktop page', async () => {
    const messages: BrowserServerMessage[] = []
    const commands: Array<{
      panelId: string
      command: TreeportDesktopBrowserCommand
    }> = []
    const bounds: Array<{
      panelId: string
      bounds: TreeportDesktopBrowserBounds
    }> = []
    const visibility: Array<{ panelId: string; visible: boolean }> = []
    let receiveState: (state: TreeportDesktopBrowserState) => void = () => {}
    let receivePopup: (popup: {
      panelId: string
      url: string
    }) => void = () => {}
    const initialState: TreeportDesktopBrowserState = {
      panelId: 'panel_browser',
      url: 'https://example.com/',
      title: 'Example',
      loading: false,
      canGoBack: false,
      canGoForward: false
    }
    const bridge = testAccess<TreeportDesktopBridge>({
      openBrowser: vi.fn(async () => initialState),
      setBrowserBounds: (
        panelId: string,
        nextBounds: TreeportDesktopBrowserBounds
      ) => bounds.push({ panelId, bounds: nextBounds }),
      setBrowserVisible: (panelId: string, visible: boolean) =>
        visibility.push({ panelId, visible }),
      sendBrowserCommand: (
        panelId: string,
        command: TreeportDesktopBrowserCommand
      ) => commands.push({ panelId, command }),
      requestBrowserClose: vi.fn(async () => false),
      disposeBrowser: vi.fn(),
      onBrowserState: (listener: typeof receiveState) => {
        receiveState = listener
        return () => undefined
      },
      onBrowserPopup: (listener: typeof receivePopup) => {
        receivePopup = listener
        return () => undefined
      }
    })
    const request = vi.fn(async () => new Response(null, { status: 200 }))

    expect(nativeBrowserAvailable(bridge)).toBe(true)
    const connection = connectNativeBrowserPanel(
      {
        id: 'panel_browser',
        kind: 'browser',
        worktreeId: 'wt_1',
        title: 'Example',
        url: 'https://example.com/',
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01'
      },
      true,
      { message: (message) => messages.push(message) },
      bridge,
      request
    )
    await vi.waitFor(() =>
      expect(messages).toContainEqual({
        type: 'ready',
        state: expect.objectContaining({
          url: 'https://example.com/',
          controlled: true,
          controller: 'you'
        })
      })
    )
    expect(visibility).toContainEqual({
      panelId: 'panel_browser',
      visible: true
    })

    connection.setBounds({ x: 10, y: 20, width: 800, height: 600 })
    connection.send({ type: 'navigate', url: 'https://example.com/next' })
    expect(bounds).toContainEqual({
      panelId: 'panel_browser',
      bounds: { x: 10, y: 20, width: 800, height: 600 }
    })
    expect(commands).toEqual([
      {
        panelId: 'panel_browser',
        command: { type: 'navigate', url: 'https://example.com/next' }
      }
    ])

    receiveState({
      ...initialState,
      url: 'https://example.com/next',
      title: 'Next',
      canGoBack: true
    })
    await vi.waitFor(() => expect(request).toHaveBeenCalled())
    expect(request).toHaveBeenCalledWith(
      '/api/panels/panel_browser/browser-state',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({
          url: 'https://example.com/next',
          title: 'Next'
        })
      })
    )

    receivePopup({
      panelId: 'panel_browser',
      url: 'https://popup.example.com/'
    })
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        '/api/panels/panel_browser/browser-popups',
        expect.objectContaining({ method: 'POST' })
      )
    )

    await expect(
      requestNativeBrowserClose('panel_browser', false, bridge)
    ).resolves.toBe(false)

    connection.dispose()
    expect(bridge.disposeBrowser).toHaveBeenCalledWith('panel_browser')
  })
})
