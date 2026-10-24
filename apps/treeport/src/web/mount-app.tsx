import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { applyTheme, storedTheme } from './features/settings/theme'
import { TreeportRoot } from './treeport-root'
import './styles.css'

export function mountApp() {
  applyTheme(storedTheme())
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <TreeportRoot />
    </StrictMode>
  )
}
