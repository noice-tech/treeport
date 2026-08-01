import {
  createRootRoute,
  createRoute,
  createRouter
} from '@tanstack/react-router'
import App from './app'
import { AppErrorFallback } from './app-error-fallback'

const rootRoute = createRootRoute({
  component: App,
  errorComponent: AppErrorFallback,
  onCatch: (error) => console.error('Unexpected application crash', error)
})

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/'
})

const projectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'projects/$projectId'
})

const worktreeRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: 'worktrees/$worktreeId'
})

const terminalRoute = createRoute({
  getParentRoute: () => worktreeRoute,
  path: 'terminals/$terminalId'
})

const panelRoute = createRoute({
  getParentRoute: () => worktreeRoute,
  path: 'panels/$panelId'
})

const routeTree = rootRoute.addChildren([
  indexRoute,
  projectRoute.addChildren([
    worktreeRoute.addChildren([terminalRoute, panelRoute])
  ])
])

export const router = createRouter({
  routeTree,
  defaultPreload: false,
  scrollRestoration: false
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
