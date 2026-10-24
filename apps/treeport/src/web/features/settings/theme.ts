import type { TreeportTheme } from '@treeport/desktop-bridge'

const THEME_STORAGE_KEY = 'treeport-theme'

export function storedTheme(): TreeportTheme {
  return localStorage.getItem(THEME_STORAGE_KEY) === 'moss' ? 'moss' : 'tide'
}

export function applyTheme(theme: TreeportTheme) {
  document.documentElement.dataset.theme = theme
  localStorage.setItem(THEME_STORAGE_KEY, theme)
  window.treeportDesktop?.setTheme?.(theme)
}
