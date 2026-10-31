import type { ReactNode } from 'react'
import {
  Bars3Icon,
  MinusIcon,
  PlusIcon,
  XMarkIcon
} from '@heroicons/react/16/solid'
import type { TerminalRecord } from '#protocol/terminal'
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarTrigger,
  useSidebar
} from '../../components/ui/sidebar'
import { useTerminalNavigationMetadata } from '../../terminal-runtime-metadata-react'
import { terminalDisplayTitle, terminalSessions } from '../../terminal-session'
import { SidebarAction } from './sidebar-action'
import { ResizableSidebarRail } from './workspace-shell'

export interface WorkspaceSidebarProps {
  projectSwitcher: ReactNode
  settingsMenu: ReactNode
  notificationCenter: ReactNode
  children: ReactNode
}

export function WorkspaceSidebar({
  projectSwitcher,
  settingsMenu,
  notificationCenter,
  children
}: WorkspaceSidebarProps) {
  return (
    <Sidebar
      id="worktree-sidebar"
      collapsible="none"
      mobileTitle="Projects and trees"
      mobileDescription="Navigate projects, trees, and terminals."
      className="sidebar relative min-h-0 bg-transparent text-zinc-200"
    >
      <SidebarHeader className="gap-0 p-0 max-[700px]:border-b max-[700px]:border-white/8">
        <div className="flex items-center gap-1 p-2 max-[700px]:h-10 max-[700px]:px-1.5 max-[700px]:py-1">
          <div className="min-w-0 flex-1">{projectSwitcher}</div>
          <div className="flex shrink-0">{settingsMenu}</div>
          <div className="max-[700px]:hidden">{notificationCenter}</div>
          <div className="flex w-9 shrink-0 justify-center min-[701px]:hidden">
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
  terminal,
  notificationCenter
}: {
  terminal: TerminalRecord | null
  notificationCenter: ReactNode
}) {
  const { isMobile, openMobile } = useSidebar()
  const { titles: runtimeTitles } = useTerminalNavigationMetadata()

  const title = terminal
    ? terminalDisplayTitle(runtimeTitles.get(terminal.id), terminal.name)
    : ''

  return (
    <header
      className="mobile-bar hidden min-w-0 items-center gap-1 border-b border-white/8 bg-zinc-900/95 px-2 max-[701px]:flex"
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
      <span
        className="min-w-0 flex-1 truncate px-1 text-[0.8125rem] text-zinc-300"
        title={title || undefined}
      >
        {title}
      </span>
      <SidebarAction
        label="Zoom out terminal text"
        className="icon-button text-zinc-400 hover:bg-white/5 hover:text-zinc-100"
        disabled={!terminal}
        onClick={() => {
          if (terminal) {
            terminalSessions.zoom(terminal.id, 'zoom-out')
          }
        }}
      >
        <MinusIcon />
      </SidebarAction>
      <SidebarAction
        label="Zoom in terminal text"
        className="icon-button text-zinc-400 hover:bg-white/5 hover:text-zinc-100"
        disabled={!terminal}
        onClick={() => {
          if (terminal) {
            terminalSessions.zoom(terminal.id, 'zoom-in')
          }
        }}
      >
        <PlusIcon />
      </SidebarAction>
      {notificationCenter}
    </header>
  )
}
