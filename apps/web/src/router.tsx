import {
  createRootRoute,
  createRoute,
  createRouter
} from '@tanstack/react-router'
import App from './app'

const rootRoute = createRootRoute({ component: App })

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

const routeTree = rootRoute.addChildren([
  indexRoute,
  projectRoute.addChildren([worktreeRoute.addChildren([terminalRoute])])
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
