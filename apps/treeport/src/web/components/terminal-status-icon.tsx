import type { TerminalProgram, TerminalProgress } from '@treeport/shared'
import { cn } from '../lib/utils'

export function TerminalStatusIcon({
  program,
  progress,
  attention,
  exited,
  className,
  title
}: {
  program: TerminalProgram | null
  progress: TerminalProgress | null
  attention: boolean
  exited: boolean
  className?: string
  title?: string
}) {
  const working =
    progress !== null &&
    !attention &&
    progress.state !== 'paused' &&
    progress.state !== 'error'
  const iconColor = attention
    ? 'text-amber-300'
    : progress?.state === 'error'
      ? 'text-rose-300'
      : progress?.state === 'paused'
        ? 'text-amber-300'
        : exited && !progress
          ? 'text-rose-300'
          : working
            ? 'text-cyan-400'
            : 'text-zinc-500'

  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      className={cn('shrink-0 overflow-visible', className)}
      aria-hidden={title ? undefined : true}
    >
      {title ? <title>{title}</title> : null}
      <g
        className={cn(
          'origin-center transition-[color,transform] duration-500',
          iconColor,
          working && 'scale-[0.62]'
        )}
      >
        {program === 'pi' ? (
          <svg viewBox="0 0 800 800" width="24" height="24">
            <path
              fill="currentColor"
              fillRule="evenodd"
              d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z"
            />
            <path fill="currentColor" d="M517.36 400H634.72V634.72H517.36Z" />
          </svg>
        ) : (
          <g
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="4 17 10 11 4 5" />
            <line x1="12" y1="19" x2="20" y2="19" />
          </g>
        )}
      </g>

      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        className="text-cyan-400"
      >
        <rect
          x="3"
          y="3"
          width="18"
          height="18"
          rx="5"
          className={cn(
            'opacity-0 transition-opacity duration-500',
            working && 'opacity-25'
          )}
        />
        <rect
          x="3"
          y="3"
          width="18"
          height="18"
          rx="5"
          pathLength="100"
          strokeDasharray="30 70"
          className={cn(
            'opacity-0 transition-opacity duration-500',
            working && 'animate-comet opacity-100 motion-reduce:animate-none'
          )}
        />
      </g>
    </svg>
  )
}
