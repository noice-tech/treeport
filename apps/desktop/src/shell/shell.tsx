import { createRoot } from 'react-dom/client'
import { App } from './app'
import { ShellStateProvider } from './shell-state'

const root = document.querySelector<HTMLDivElement>('#app')
if (!root) {
  throw new Error('Missing desktop shell root')
}

createRoot(root).render(
  <ShellStateProvider>
    <App />
  </ShellStateProvider>
)
