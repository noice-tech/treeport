import type { ReactNode } from 'react'
import { Bars3Icon, XMarkIcon } from '@heroicons/react/16/solid'
import type { TerminalRecord } from '@treeport/shared'
import { NativeSelect } from '../../components/ui/native-select'
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarTrigger,
  useSidebar
} from '../../components/ui/sidebar'
import { useTerminalNavigationMetadata } from '../../terminal-runtime-metadata-react'
import { ResizableSidebarRail } from './workspace-shell'

export interface WorkspaceSidebarProps {
  projectSwitcher: ReactNode
  notificationCenter: ReactNode
  children: ReactNode
}

export function WorkspaceSidebar({
  projectSwitcher,
  notificationCenter,
  children
}: WorkspaceSidebarProps) {
  return (
    <Sidebar
      id="worktree-sidebar"
      collapsible="none"
      mobileTitle="Projects and trees"
      mobileDescription="Navigate projects, trees, and terminals."
      className="sidebar relative min-h-0 border-r border-white/8 bg-zinc-900/80 text-zinc-200 backdrop-blur-xl"
    >
      <SidebarHeader className="gap-0 border-b border-white/8 p-0">
        <div className="hidden justify-end p-2 max-[700px]:flex">
          <SidebarTrigger
            type="button"
            size="icon-sm"
            className="icon-button mobile-close text-zinc-400 hover:bg-white/5 hover:text-zinc-100"
            aria-label="Close drawer"
          >
            <XMarkIcon />
            <span className="touch-target" aria-hidden="true" />
          </SidebarTrigger>
        </div>
        <div className="flex items-center gap-1 p-2 max-[700px]:pt-0">
          <div className="min-w-0 flex-1">{projectSwitcher}</div>
          <div className="max-[700px]:hidden">{notificationCenter}</div>
        </div>
      </SidebarHeader>
      <SidebarContent className="gap-0 overflow-hidden">
        {children}
      </SidebarContent>
      <ResizableSidebarRail />
    </Sidebar>
  )
}

export function WorkspaceMobileHeader({
  selectedTerminalId,
  terminals,
  onSelectTerminal,
  notificationCenter
}: {
  selectedTerminalId: string | null
  terminals: TerminalRecord[]
  onSelectTerminal: (terminal: TerminalRecord) => void
  notificationCenter: ReactNode
}) {
  const { isMobile, openMobile } = useSidebar()
  const { titles: runtimeTitles } = useTerminalNavigationMetadata()

  return (
    <header
      className="mobile-bar hidden min-w-0 grid-cols-[2.75rem_minmax(0,1fr)_2.75rem] items-center gap-2 border-b border-white/8 bg-zinc-900/95 px-2 backdrop-blur max-[700px]:grid"
      inert={isMobile && openMobile ? true : undefined}
    >
      <SidebarTrigger
        type="button"
        size="icon"
        className="icon-button text-zinc-400 hover:bg-white/5 hover:text-zinc-100"
        aria-label="Open tree drawer"
      >
        <Bars3Icon />
        <span className="touch-target" aria-hidden="true" />
      </SidebarTrigger>
      <NativeSelect
        className="h-9 border-0 bg-zinc-800/80 text-base ring-0"
        name="terminal-selector"
        aria-label="Terminal selector"
        value={selectedTerminalId ?? ''}
        onChange={(event) => {
          const terminal = terminals.find(
            (item) => item.id === event.target.value
          )
          if (terminal) {
            onSelectTerminal(terminal)
          }
        }}
      >
        <option value="">Select terminal</option>
        {terminals.map((terminal) => (
          <option value={terminal.id} key={terminal.id}>
            {runtimeTitles.get(terminal.id) || terminal.name}
          </option>
        ))}
      </NativeSelect>
      {notificationCenter}
    </header>
  )
}
