import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { TreeportRoot } from './treeport-root'
import './styles.css'

const isIOS =
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
const viewport = document.querySelector<HTMLMetaElement>(
  'meta[name="viewport"]'
)
// Modern iOS still allows pinch zoom but honors this for input focus zoom.
if (isIOS && viewport && !viewport.content.includes('maximum-scale')) {
  viewport.content = `${viewport.content}, maximum-scale=1`
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TreeportRoot />
  </StrictMode>
)
