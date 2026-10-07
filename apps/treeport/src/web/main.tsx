import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { TreeportRoot } from './treeport-root'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TreeportRoot />
  </StrictMode>
)
