import { supportsLocalBrowser } from './desktop-capabilities'

export function getDesktopRuntime() {
  const bridge = window.treeportDesktop

  return {
    computerId: bridge?.runtime?.computerId ?? null,
    localBrowser: Boolean(
      bridge?.runtime?.localBrowser && supportsLocalBrowser(bridge)
    )
  }
}
