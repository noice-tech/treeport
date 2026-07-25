import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { Toaster } from './components/ui/sonner'
import { TooltipProvider } from './components/ui/tooltip'
import { TerminalFocusProvider } from './terminal-focus'
import { router } from './router'
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

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false },
    mutations: { retry: false }
  }
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <TerminalFocusProvider>
          <RouterProvider router={router} />
          <Toaster />
        </TerminalFocusProvider>
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>
)
