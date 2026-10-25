import type { DesktopBridge } from '@treeport/desktop-bridge'

type LocalBrowserBridge = DesktopBridge &
  Required<
    Pick<
      DesktopBridge,
      | 'registerBrowser'
      | 'browserCommand'
      | 'setBrowserInputControl'
      | 'setBrowserPresentationActive'
      | 'requestBrowserClose'
      | 'disposeBrowser'
      | 'onBrowserFocus'
      | 'onBrowserPopup'
      | 'onBrowserUnavailable'
      | 'onBrowserPermissionPrompt'
      | 'respondBrowserPermission'
    >
  >

export function supportsLocalBrowser(
  bridge: DesktopBridge | undefined
): bridge is LocalBrowserBridge {
  return Boolean(
    bridge?.registerBrowser &&
    bridge.browserCommand &&
    bridge.setBrowserInputControl &&
    bridge.setBrowserPresentationActive &&
    bridge.requestBrowserClose &&
    bridge.disposeBrowser &&
    bridge.onBrowserFocus &&
    bridge.onBrowserPopup &&
    bridge.onBrowserUnavailable &&
    bridge.onBrowserPermissionPrompt &&
    bridge.respondBrowserPermission
  )
}
