declare module '@treeport-web/desktop-runtime' {
  import type { ReactNode } from 'react'

  export function DesktopRuntimeProvider(props: {
    computerId: string
    localBrowser: boolean
    children: ReactNode
  }): ReactNode
}

declare module '@treeport-web/treeport-root' {
  import type { ReactNode } from 'react'

  export function TreeportRoot(): ReactNode
}

declare module '@treeport-web/styles.css'
