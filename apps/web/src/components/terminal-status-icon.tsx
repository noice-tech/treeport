import { cn } from '../lib/utils'

export function TerminalStatusIcon({
  working,
  className,
  title
}: {
  working: boolean
  className?: string
  title?: string
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn('transition-colors duration-300', className)}
      aria-hidden={title ? undefined : true}
    >
      {title ? <title>{title}</title> : null}
      <g
        className={cn(
          'origin-center transition-transform duration-500',
          working && 'scale-[0.62]'
        )}
      >
        <polyline points="4 17 10 11 4 5" />
        <line x1="12" y1="19" x2="20" y2="19" />
      </g>
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
          working && 'opacity-100 animate-comet motion-reduce:animate-none'
        )}
      />
    </svg>
  )
}
