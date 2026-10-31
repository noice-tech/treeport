import { useEffect } from 'react'
import type { ProjectRecord } from '#protocol/project'
import type { WorktreeRecord } from '#protocol/worktree'
import { useTerminalNavigationMetadata } from './terminal-runtime-metadata-react'

export function WorkspaceWindowTitle({
  projects,
  selectedProject,
  selectedWorktree,
  disconnected
}: {
  projects: ProjectRecord[]
  selectedProject: ProjectRecord | null
  selectedWorktree: WorktreeRecord | null
  disconnected: boolean
}) {
  const { attention, programs, activity } = useTerminalNavigationMetadata()
  let working = 0
  let needsAttention = 0

  for (const project of projects) {
    for (const worktree of project.worktrees) {
      for (const terminal of worktree.terminals) {
        if (terminal.status !== 'running' || !programs.has(terminal.id)) {
          continue
        }

        const state = activity.get(terminal.id)?.state

        if (attention.has(terminal.id) || state === 'blocked') {
          needsAttention += 1
        } else if (state === 'working') {
          working += 1
        }
      }
    }
  }

  const workspace = selectedWorktree?.name ?? selectedProject?.name
  const title = [workspace, 'Treeport'].filter(Boolean).join(' — ')
  const isWorking = !disconnected && working > 0
  const needsAgentAttention = !disconnected && needsAttention > 0

  useEffect(() => {
    const previousTitle = document.title
    document.title = title

    return () => {
      document.title = previousTitle
    }
  }, [title])

  useEffect(() => {
    if (!isWorking && !needsAgentAttention) {
      return
    }

    const favicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
    const canvas = document.createElement('canvas')
    canvas.width = 64
    canvas.height = 64
    const context = canvas.getContext('2d')

    if (!favicon || !context) {
      return
    }

    const originalHref = favicon.href
    const originalType = favicon.getAttribute('type')

    const frames = [7, 9, 11, 9].map((radius) => {
      context.clearRect(0, 0, 64, 64)
      context.fillStyle = '#09090b'
      context.beginPath()
      context.roundRect(0, 0, 64, 64, 12)
      context.fill()
      context.fillStyle = '#67e8f9'
      context.fillRect(14, 17, 36, 8)
      context.fillRect(28, 25, 8, 25)
      context.beginPath()
      context.arc(50, 50, 13, 0, Math.PI * 2)
      context.fillStyle = '#09090b'
      context.fill()
      context.beginPath()
      context.arc(50, 50, radius, 0, Math.PI * 2)
      context.fillStyle = needsAgentAttention ? '#fbbf24' : '#67e8f9'
      context.fill()

      return canvas.toDataURL('image/png')
    })

    favicon.type = 'image/png'
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
    let timer: number | null = null

    const updateAnimation = () => {
      if (timer !== null) {
        window.clearInterval(timer)
        timer = null
      }

      favicon.href = frames[2]!

      if (isWorking && !reducedMotion.matches) {
        let frame = 0
        // EXTERNAL: Swap raster frames: SVG favicon animations are not reliably supported.
        timer = window.setInterval(() => {
          favicon.href = frames[frame % frames.length]!
          frame += 1
        }, 600)
      }
    }

    updateAnimation()
    reducedMotion.addEventListener('change', updateAnimation)

    return () => {
      if (timer !== null) {
        window.clearInterval(timer)
      }

      reducedMotion.removeEventListener('change', updateAnimation)
      favicon.href = originalHref

      if (originalType === null) {
        favicon.removeAttribute('type')
      } else {
        favicon.setAttribute('type', originalType)
      }
    }
  }, [isWorking, needsAgentAttention])

  return null
}
