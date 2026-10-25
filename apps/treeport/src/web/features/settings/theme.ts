import type { TreeportTheme } from '@treeport/desktop-bridge'

const THEME_STORAGE_KEY = 'treeport-theme'
const ACCENT_STORAGE_KEY = 'treeport-accent'

// Presets sit at the dark accent-400 lightness, so swatches match the result.
export const ACCENT_PRESETS = [
  { label: 'Tide', color: '#6ccefe' },
  { label: 'Moss', color: '#7bd997' },
  { label: 'Amber', color: '#f2b458' },
  { label: 'Rose', color: '#f7a7b3' },
  { label: 'Violet', color: '#c5b4fb' }
] as const

export function storedTheme(): TreeportTheme & { accent: string } {
  const mode = localStorage.getItem(THEME_STORAGE_KEY)
  const accent = localStorage.getItem(ACCENT_STORAGE_KEY)

  return {
    mode: mode === 'auto' || mode === 'light' ? mode : 'dark',
    accent:
      accent && /^#[0-9a-f]{6}$/.test(accent) ? accent : ACCENT_PRESETS[0].color
  }
}

const lightScheme = window.matchMedia('(prefers-color-scheme: light)')
let appliedTheme: ReturnType<typeof storedTheme> | null = null

lightScheme.addEventListener('change', () => {
  if (appliedTheme?.mode === 'auto') {
    applyTheme(appliedTheme)
  }
})

export function applyTheme(theme: ReturnType<typeof storedTheme>) {
  appliedTheme = theme

  const mode =
    theme.mode === 'auto'
      ? lightScheme.matches
        ? 'light'
        : 'dark'
      : theme.mode

  const root = document.documentElement
  root.dataset.theme = mode
  root.style.setProperty('--accent-color', theme.accent)
  // index.html paints the dark startup screen before any theme is known.
  document
    .querySelector('meta[name="color-scheme"]')
    ?.setAttribute('content', mode)
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', mode === 'light' ? '#fafcfe' : '#09090b')
  localStorage.setItem(THEME_STORAGE_KEY, theme.mode)
  localStorage.setItem(ACCENT_STORAGE_KEY, theme.accent)
  window.treeportDesktop?.setTheme?.(theme)
}
